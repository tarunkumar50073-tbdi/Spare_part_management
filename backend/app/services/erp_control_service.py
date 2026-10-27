"""ERP Control Center — one honest status view of everything the app knows
about its link to ERP, for one store.

    stock_snapshot  the stock figures ERP last pushed for this store's parts, and their age
    db_sync         the read-only ERP DB -> mirror poller, plus how fresh the mirrors are
    ledger_inbox    the ERP stock-ledger Excel drop folder
    write_back      movements recorded here that ERP has not received yet
    reconciliation  ERP's figure against the store's own count, with the money in the gaps
    data_sources    which figure comes from where, stated for the UI

Read-only: nothing here writes. Every state is derived from rows or from the
services' own status — a figure the app does not record (a history of sync
runs, failed push attempts) is labelled as not recorded, never filled in.
"""
from datetime import date, datetime, timedelta, timezone

from flask import current_app
from sqlalchemy import and_, func

from app.extensions import db
from app.models.erp_stock import ERPStock
from app.models.gate_entry import GateEntry
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.spare_stock import ERP_ORIGIN_RECEIPT_STATUSES, SpareStock, SpareStockLedger
from app.models.store import Store
from app.services.erp_ledger_inbox_service import ERPLedgerInboxService
from app.services.erp_sync_service import ERPSyncService
from app.services.spare_stock_service import SpareStockService
from app.utils.exceptions import NotFoundError

# Same window the dashboard's snapshot chip and the scan screen use.
STALE_AFTER_HOURS = 24
PENDING_LIMIT = 50
_TOP_GAPS = 5
# The only ledger types the ERP push sends (SpareStockService.sync_pending_to_erp).
ERP_MOVEMENT_TYPES = ("ISSUE", "RECEIPT", "RETURN")


def erp_origin_receipt():
    """A RECEIPT row whose stock-in already happened IN ERP: a quality-cleared
    supplier receipt (the supervisor's GRN) or an RGP GRN. The app only mirrors
    it onto available stock; pushing it would add the same quantity to ERP a
    second time. (status NULL — a legacy row — is not one of these.)"""
    L = SpareStockLedger
    return and_(L.txn_type == "RECEIPT", L.status.isnot(None), L.status.in_(ERP_ORIGIN_RECEIPT_STATUSES))

IN_MEMORY_NOTE = ("Kept in server memory only: it resets when the server restarts, "
                  "and no history of past runs is stored.")


def _utc(value):
    """A stored time as an aware UTC datetime. SQLite hands back naive values
    (everything is written in UTC); the in-memory statuses keep ISO strings."""
    if value is None:
        return None
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value)
        except ValueError:
            return None
    if not isinstance(value, datetime):
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _iso(value):
    """Aware ISO string, so the browser shows it in local time instead of
    reading a naive UTC stamp as if it were local."""
    dt = _utc(value)
    return dt.isoformat() if dt else None


def _age_hours(value, now):
    dt = _utc(value)
    return round((now - dt).total_seconds() / 3600, 1) if dt else None


def snapshot_state(rows, age_hours):
    """NONE (ERP never pushed a figure for this store), STALE (older than
    STALE_AFTER_HOURS) or SYNCED."""
    if not rows:
        return "NONE"
    if age_hours is None or age_hours > STALE_AFTER_HOURS:
        return "STALE"
    return "SYNCED"


def db_sync_state(status):
    if not status.get("configured"):
        return "NOT_CONFIGURED"
    if status.get("last_error"):
        return "ERROR"
    if status.get("last_sync_at"):
        return "OK"
    return "NEVER_RUN"


def inbox_state(status):
    if status.get("last_error"):
        return "ERROR"
    if status.get("pending_files"):
        return "FILES_WAITING"
    # Newest result first: an empty inbox whose last file went to failed/ is not "clear".
    recent = status.get("recent") or []
    if recent and recent[0].get("ok") is False:
        return "LAST_FILE_FAILED"
    if status.get("last_scan_at"):
        return "OK"
    return "NOT_SCANNED"


def write_state(write):
    if write["active"]:
        return "ACTIVE"
    return "DISABLED" if not write["write_enabled"] else "NOT_CONFIGURED"


class ERPControlService:
    def __init__(self):
        self.stock = SpareStockService()

    def status(self, store_code):
        if not Store.query.filter_by(code=store_code).first():
            raise NotFoundError(f"Store '{store_code}' not found")
        now = datetime.now(timezone.utc)
        snapshot = self._stock_snapshot(store_code, now)
        return {
            "store_code": store_code,
            "generated_at": now.isoformat(),
            "stock_snapshot": snapshot,
            "db_sync": self._db_sync(store_code, now),
            "ledger_inbox": self._ledger_inbox(now),
            "write_back": self._write_back(store_code, now),
            "reconciliation": self._reconciliation(store_code, snapshot, now),
            "data_sources": self._data_sources(store_code),
        }

    # ------------------------------------------------------------ snapshot

    @staticmethod
    def _stock_snapshot(store_code, now):
        parts_total = (db.session.query(func.count(Part.id))
                       .filter(Part.store_code == store_code, Part.is_active.is_(True))
                       .scalar() or 0)
        rows, last, first = (
            db.session.query(func.count(ERPStock.id), func.max(ERPStock.synced_at),
                             func.min(ERPStock.synced_at))
            .join(Part, Part.id == ERPStock.part_id)
            .filter(Part.store_code == store_code, Part.is_active.is_(True))
            .one()
        )
        age = _age_hours(last, now)
        return {
            "state": snapshot_state(rows, age),
            "rows": rows,
            "parts_total": parts_total,
            "coverage_pct": round(rows / parts_total * 100, 1) if parts_total else None,
            "last_synced_at": _iso(last),
            "oldest_synced_at": _iso(first),
            "age_hours": age,
            "age_days": int(age // 24) if age is not None and age >= 0 else None,
            "stale_after_hours": STALE_AFTER_HOURS,
            # erp_stock is written only by ERP's inbound stock push; the DB
            # poller mirrors gate entries and GRNs, not stock.
            "source": ("Filled only when ERP pushes stock figures to the app (ERP stock sync). "
                       "The ERP database sync does not refresh it."),
        }

    # ------------------------------------------------------------- DB sync

    def _db_sync(self, store_code, now):
        st = ERPSyncService().status()
        part_nos = self._store_part_nos(store_code)
        today = date.today()
        return {
            **st,
            "state": db_sync_state(st),
            "last_sync_at": _iso(st.get("last_sync_at")),
            "last_sync_age_hours": _age_hours(st.get("last_sync_at"), now),
            # Whether this server process actually started the poller — a
            # configured interval means nothing if credentials were missing at start.
            "poller_running": bool(ERPSyncService._poller_started),
            # The server's poller, seen through the run it saved (another machine).
            "poller_elsewhere": bool(st.get("saved_by_other_machine") and st.get("poll_seconds")),
            "status_in_memory": not st.get("saved_by_other_machine"),
            "note": IN_MEMORY_NOTE,
            "mirrors": {
                "gate_entries": self._mirror(GateEntry, GateEntry.item_code, GateEntry.gate_entry_dt,
                                             part_nos, today),
                "receiving_register": self._mirror(ReceivingRegister, ReceivingRegister.item_cd,
                                                   ReceivingRegister.grn_date, part_nos, today),
            },
        }

    @staticmethod
    def _store_part_nos(store_code):
        return {(pno or "").strip().upper() for (pno,) in
                db.session.query(Part.part_no)
                .filter(Part.store_code == store_code, Part.is_active.is_(True))}

    @staticmethod
    def _mirror(model, code_col, date_col, part_nos, today):
        """Plant-wide mirror size and newest date, plus how much of it matches
        this store's part numbers. Matched by grouping the codes once and
        intersecting in Python — a join on upper(code) would scan per part."""
        total, latest = db.session.query(func.count(model.id), func.max(date_col)).one()
        key = func.upper(func.trim(code_col))
        matched_rows = matched_parts = 0
        for code, n in (db.session.query(key, func.count(model.id))
                        .filter(code_col.isnot(None)).group_by(key)):
            if code in part_nos:
                matched_rows += n
                matched_parts += 1
        return {
            "rows": total,
            "latest_date": latest.isoformat() if latest else None,
            "age_days": (today - latest).days if latest else None,
            "matched_rows": matched_rows,
            "matched_parts": matched_parts,
        }

    # -------------------------------------------------------- ledger inbox

    @staticmethod
    def _ledger_inbox(now):
        base = {
            "status_in_memory": True,
            "note": IN_MEMORY_NOTE,
            # The import writes the Child Parts receipt ledger (BUY/MAKE source
            # breakdown); spare on-hand stock is never touched by it.
            "scope": ("Imports the ERP stock-ledger Excel into the Child Parts receipt history. "
                      "It never changes spare stock."),
            "poller_running": bool(ERPLedgerInboxService._poller_started),
        }
        try:
            st = ERPLedgerInboxService().status()
        except OSError as exc:  # the inbox folder is missing / not writable
            # Only the folder listing failed: the scan history in memory is still
            # true, while the waiting files are unknown (None, not an empty list).
            last_scan = ERPLedgerInboxService._last_scan_at
            return {
                **base, "state": "UNAVAILABLE", "error": f"{type(exc).__name__}: {exc}",
                "inbox_path": current_app.config.get("ERP_LEDGER_INBOX"),
                "poll_seconds": current_app.config.get("ERP_LEDGER_POLL_SECONDS"),
                "pending_files": None,
                "recent": list(ERPLedgerInboxService._recent),
                "last_scan_at": _iso(last_scan),
                "last_scan_age_hours": _age_hours(last_scan, now),
                "last_error": ERPLedgerInboxService._last_error,
                "consecutive_failures": ERPLedgerInboxService._consecutive_failures,
            }
        return {
            **st, **base,
            "state": inbox_state(st),
            "last_scan_at": _iso(st.get("last_scan_at")),
            "last_scan_age_hours": _age_hours(st.get("last_scan_at"), now),
            "error": None,
        }

    # ---------------------------------------------------------- write-back

    def _write_back(self, store_code, now):
        write = SpareStockService.erp_write_status()
        # The pending count and list leave the ERP-origin receipts out (see
        # erp_origin_receipt): a quality-cleared receipt or an RGP GRN entered
        # stock through ERP's own GRN, so calling it "not yet in ERP" would be
        # false, and pushing it would count the stock twice in ERP. They are
        # read through the stock service's own pending_erp_* on purpose — the
        # same filter sync_pending_to_erp pushes by — so what this screen calls
        # pending is exactly what a push would send.
        L = SpareStockLedger
        pending = self.stock.pending_erp_count(store_code)
        rows = self.stock.pending_erp_movements(store_code, limit=PENDING_LIMIT)
        for r in rows:
            r["age_hours"] = _age_hours(r["at"], now)
            r["at"] = _iso(r["at"])
        # Oldest first, so the first row is the oldest pending movement.
        oldest = rows[0]["at"] if rows else None
        pushed, last_pushed = (
            db.session.query(func.count(L.id), func.max(L.erp_pushed_at))
            .join(Part, Part.id == L.part_id)
            .filter(Part.store_code == store_code, L.erp_pushed_at.isnot(None))
            .one()
        )
        erp_origin = (db.session.query(func.count(L.id))
                      .join(Part, Part.id == L.part_id)
                      .filter(Part.store_code == store_code, erp_origin_receipt())
                      .scalar() or 0)
        return {
            **write,
            "state": write_state(write),
            "pending": pending,
            "oldest_pending_at": oldest,
            "oldest_pending_age_hours": _age_hours(oldest, now),
            "rows": rows,
            "shown": len(rows),
            "limit": PENDING_LIMIT,
            "pushed_total": pushed,
            "last_pushed_at": _iso(last_pushed),
            # Receipts that became available after ERP's own GRN — never queued.
            "erp_origin_receipts": erp_origin,
            "note": ("Push attempts are not logged: a movement that fails or is held back "
                     "simply stays pending until a push succeeds. Quality-cleared receipts and "
                     "RGP GRNs are not queued: their stock-in was made in ERP by the GRN."),
        }

    # ------------------------------------------------------ reconciliation

    def _reconciliation(self, store_code, snapshot, now):
        summary = self.stock.erp_gap_summary(store_code)
        rows = self.stock.erp_gap(store_code)
        rate = {pid: float(p) for pid, p in
                db.session.query(Part.id, Part.unit_price)
                .filter(Part.store_code == store_code, Part.is_active.is_(True),
                        Part.unit_price.isnot(None))}

        value = {"SHORT": 0.0, "EXCESS": 0.0}
        priced = {"SHORT": 0, "EXCESS": 0}
        unpriced = {"SHORT": 0, "EXCESS": 0}
        valued = []
        for r in rows:
            if r["status"] not in value:
                continue
            price = rate.get(r["part_id"])
            # No rate (or a zero one) = the gap can't be valued; counted, not guessed.
            if not price:
                unpriced[r["status"]] += 1
                continue
            v = abs(r["gap_qty"]) * price
            value[r["status"]] += v
            priced[r["status"]] += 1
            valued.append((v, price, r))
        valued.sort(key=lambda t: -t[0])

        def total(*statuses):
            # Gaps with no rate at all have an unknown value, not a zero one.
            if any(unpriced[s] for s in statuses) and not any(priced[s] for s in statuses):
                return None
            return round(sum(value[s] for s in statuses), 2)

        # ERP pushes stamp only the parts they carry, so one fresh push can sit
        # beside weeks-old figures: count the stale ones, not just the newest.
        stale_cut = now - timedelta(hours=STALE_AFTER_HOURS)
        erp_times = [_utc(r["erp_synced_at"]) for r in rows if r.get("erp_synced_at")]
        erp_times = [t for t in erp_times if t]

        reconciled = [r for r in rows if r["gap_qty"] is not None]
        counted = sorted(r["last_counted_at"] for r in reconciled if r["last_counted_at"])
        return {
            **summary,
            "value_impact": {
                "short_value": total("SHORT"),
                "excess_value": total("EXCESS"),
                "gross_value": total("SHORT", "EXCESS"),
                "short_priced": priced["SHORT"],
                "short_unpriced": unpriced["SHORT"],
                "excess_priced": priced["EXCESS"],
                "excess_unpriced": unpriced["EXCESS"],
                "priced_gaps": len(valued),
                "unpriced_gaps": unpriced["SHORT"] + unpriced["EXCESS"],
                "basis": "Gap quantity x the part master rate (not an ERP valuation).",
            },
            "top_gaps": [{
                "part_id": r["part_id"], "part_no": r["part_no"], "part_name": r["part_name"],
                "status": r["status"], "erp_qty": r["erp_qty"], "physical_qty": r["physical_qty"],
                "gap_qty": r["gap_qty"], "unit_price": price, "value": round(v, 2),
            } for v, price, r in valued[:_TOP_GAPS]],
            "erp_as_of": snapshot["last_synced_at"],
            "erp_oldest": snapshot["oldest_synced_at"],
            "erp_age_hours": snapshot["age_hours"],
            "erp_oldest_age_hours": _age_hours(snapshot["oldest_synced_at"], now),
            "erp_state": snapshot["state"],
            "erp_figures": len(erp_times),
            "erp_stale_figures": sum(1 for t in erp_times if t < stale_cut),
            "stale_after_hours": STALE_AFTER_HOURS,
            "counted_from": _iso(counted[0]) if counted else None,
            "counted_to": _iso(counted[-1]) if counted else None,
            "caveat": ("Each gap compares ERP's figure as of its last push with a count taken at a "
                       "different time — movement between the two reads as a gap, not a loss."),
        }

    # -------------------------------------------------------- data sources

    @staticmethod
    def _data_sources(store_code):
        total = (db.session.query(func.count(Part.id))
                 .filter(Part.store_code == store_code, Part.is_active.is_(True)).scalar() or 0)
        counted, last_count = (
            db.session.query(func.count(SpareStock.id), func.max(SpareStock.last_counted_at))
            .join(Part, Part.id == SpareStock.part_id)
            .filter(Part.store_code == store_code, Part.is_active.is_(True))
            .one()
        )
        by_type, starts = {}, []
        for txn_type, n, first in (
            db.session.query(SpareStockLedger.txn_type, func.count(SpareStockLedger.id),
                             func.min(SpareStockLedger.created_at))
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code)
            .group_by(SpareStockLedger.txn_type)
        ):
            by_type[txn_type] = n
            if first:
                starts.append(_utc(first))
        # Split by what reaches ERP: opening counts dominate the ledger, so a
        # single row total would read as hundreds of movements. Receipts that
        # came in through ERP's own GRN are not movements the app sends.
        erp_origin = (db.session.query(func.count(SpareStockLedger.id))
                      .join(Part, Part.id == SpareStockLedger.part_id)
                      .filter(Part.store_code == store_code, erp_origin_receipt())
                      .scalar() or 0)
        movement_rows = sum(by_type.get(t, 0) for t in ERP_MOVEMENT_TYPES) - erp_origin
        return [
            {
                "key": "erp", "label": "ERP data",
                "what": ("Stock figures ERP pushed, and the gate entries and GRN register mirrored "
                         "read-only from the ERP database."),
                "trust": "The app never edits these. Each is only as fresh as its last push or sync above.",
            },
            {
                "key": "dx", "label": "DX Store transactions",
                "what": ("Issues, receipts and returns recorded in this app, plus the opening counts "
                         "and count adjustments (the spare stock ledger)."),
                "trust": ("Only issues, receipts and returns are queued for ERP, and they reach it only "
                          "once write-back is switched on. Opening counts and adjustments stay in the app; "
                          "quality-cleared receipts and RGP GRNs are already in ERP through the GRN."),
                "ledger_started_at": _iso(min(starts)) if starts else None,
                "ledger_rows": sum(by_type.values()),
                "movement_rows": movement_rows,
                "erp_origin_rows": erp_origin,
                "opening_rows": by_type.get("OPENING", 0),
                "adjustment_rows": by_type.get("ADJUSTMENT", 0),
                "rows_by_type": by_type,
            },
            {
                "key": "physical", "label": "Physical count",
                "what": "What the store counted on the shelf — the In Stock figure.",
                "trust": "A part never counted has no quantity (not zero).",
                "counted_parts": counted,
                "total_parts": total,
                "last_counted_at": _iso(last_count),
            },
        ]
