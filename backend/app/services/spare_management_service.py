"""The management block of the Spare Parts Store dashboard and the Live Board.

The overview answers "what is wrong". This answers what a manager asks next,
in one response (GET /dashboard/spare/management):

    tracker       WHO must act on each open point, and by WHEN — the Action
                  Tracker. The counts are live; the owner, target date and
                  remarks are an administrator's saved note on the line.
    excess_aging  HOW LONG the money above max has sat: days since the part
                  last came in, per ERP.
    movement      material IN against OUT in rupees, month by month.
    scan          is the store scanning its parts, or typing them.

It stands beside SpareDashboardService instead of growing overview(): that call
already runs the ERP GRN scan and a dozen ledger queries, and the alerts bell
re-runs it every two minutes. Every count the two share comes from the
overview's own helper, so the screens can never disagree.

Nothing is estimated. A figure the data cannot support is None. A figure that
could not be read (its query failed) is None as well, and its tracker line reads
UNKNOWN — the rest of the payload still arrives.
"""
import time
from collections import Counter
from datetime import date, datetime, timedelta

from flask import current_app
from sqlalchemy import and_, case, func

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.base import utcnow
from app.models.gate_entry import GateEntry
from app.models.part import Part
from app.models.part_request import PartRequest
from app.models.put_away_log import PutAwayLog
from app.models.receiving_register import ReceivingRegister
from app.models.scan_audit import ScanAudit
from app.models.spare_flow import SpareTransaction
from app.models.spare_stock import SpareStockLedger
from app.models.store import Store
from app.services.consumption_analytics_service import _local_offset, _utc_naive
from app.services.erp_gap_service import ERPGapService
from app.services.erp_grn_posting_service import _plant_date
from app.services.part_request_service import OPEN_STATUSES
from app.services.spare_dashboard_service import SpareDashboardService, _as_date, _money
from app.services.spare_stock_service import _sec_tuple
from app.utils.exceptions import BadRequestError

SETTING_KEY = "action_tracker"
OWNER_MAX = 60
REMARKS_MAX = 200

# The Action Tracker's lines, in the order they are listed, each with what has
# to be done and who does it unless an administrator names someone else. A
# `store_only` line is a whole-store figure (the ERP queues are not split by
# section), so it is left out of a section / group call — exactly like the
# overview's srv_pending and erp_pending.
TRACKER_ITEMS = (
    {"key": "critical", "label": "Critical parts", "severity": "critical",
     "action": "Raise / expedite PO", "owner": "Purchase",
     "link": {"label": "Open list", "to": "/store-stock-spare", "status": "Critical"}},
    {"key": "reorder", "label": "At reorder level", "severity": "warning",
     "action": "Raise PO", "owner": "Purchase",
     "link": {"label": "Open list", "to": "/store-stock-spare", "status": "Reorder"}},
    {"key": "excess", "label": "Excess above max", "severity": "warning",
     "action": "Stop ordering · review max level", "owner": "Store + Planning",
     "link": {"label": "Open list", "to": "/store-stock-spare", "status": "Above Maximum"}},
    {"key": "srv_pending", "label": "GRN / quality pending (ERP)", "severity": "warning",
     "action": "Clear quality in ERP", "owner": "Quality / user dept.",
     "link": {"label": "Open Receiving & GRN", "to": "/receiving"}, "store_only": True},
    {"key": "erp_gap", "label": "ERP vs physical gap", "severity": "warning",
     "action": "Reconcile stock with ERP", "owner": "Store + ERP team",
     "link": {"label": "Open ERP vs Physical", "to": "/spare-erp-gap"}, "store_only": True},
    {"key": "confirm_pending", "label": "Issues awaiting confirmation", "severity": "warning",
     "action": "Confirm installation", "owner": "User department",
     "link": {"label": "Confirm installation", "to": "/confirm-installation"}},
    {"key": "kiosk_open", "label": "Kiosk part requests open", "severity": "warning",
     "action": "Issue the requested part", "owner": "Store supervisor",
     "link": {"label": "Open Part Requisition", "to": "/part-requests"}},
    {"key": "returns_pending", "label": "Returns awaiting inspection", "severity": "warning",
     "action": "Inspect returned parts", "owner": "Store",
     "link": {"label": "Open Work Queue", "to": "/work-queue"}},
    {"key": "rgp_overdue", "label": "Repair (RGP) overdue", "severity": "warning",
     "action": "Follow up with the supplier", "owner": "Purchase",
     "link": {"label": "Open Work Queue", "to": "/work-queue"}},
    {"key": "no_rate", "label": "Parts without a rate", "severity": "info",
     "action": "Enter the rate in Part Master", "owner": "Store + Accounts",
     "link": {"label": "Open Data Quality", "to": "/data-quality"}},
    {"key": "erp_pending", "label": "Movements not yet in ERP", "severity": "info",
     "action": "Enable / clear the ERP write-back", "owner": "ERP / IT",
     "link": {"label": "Open ERP Control Center", "to": "/erp-control"}, "store_only": True},
)
_SPEC = {spec["key"]: spec for spec in TRACKER_ITEMS}

# Excess aging by days since the last inward. The ERP mirror keeps a rolling
# window (120 days as configured), so nothing can be dated past its horizon:
# "none" means no inward since then, not "never".
AGING_BUCKETS = (
    ("0-30", "0–30 days"),
    ("31-90", "31–90 days"),
    ("91+", "91+ days"),
    ("none", "No inward on record"),
)
_TOP_EXCESS = 5

MOVEMENT_MONTHS = 6

SCAN_WINDOW_DAYS = 30
# scan_audit.scan_source: a gun or camera read, against a typed / searched code.
SCANNED_SOURCES = ("USB_SCANNER", "BLUETOOTH_SCANNER", "TABLET_CAMERA")
# spare_transactions.scan_source on an ISSUE: how the operator reached the part.
ISSUE_BY_SCAN = ("QR_SCAN", "SUPPLIER_BARCODE", "kiosk_request")
ISSUE_BY_SEARCH = ("ERP_SEARCH", "MANUAL_ENTRY")

# The lists behind the Live Board's figures (board_list, GET /management/list):
# the kinds, and the filters each one takes as `key`.
BOARD_LIST_KEYS = {
    "in": None,                                   # key = the month, YYYY-MM
    "out": None,                                  # key = the month, YYYY-MM
    "dept": None,                                 # key = the consuming department
    "scans": ("all", "scanned", "scanned_ok", "typed_ok", "not_found"),
    "issues": ("all", "scan", "search", "unrecorded"),
    "put_away": ("all", "lot_tag"),
}

# The ERP mirror tables (receiving_register, gate_entries) are replaced
# wholesale by the ERP sync, hourly at most, and never change in between. The
# aggregate read off them alone — each item's last inward date — is therefore
# kept for a few minutes instead of re-scanning ~36,000 rows on every board
# refresh. Everything else is read live, the monthly GRN totals included: they
# are valued at the parts' rates, which an admin can change at any moment.
_MIRROR_CACHE = {}
_MIRROR_CACHE_TTL = 300


def _mirror_cached(key, build):
    ttl = current_app.config.get("SPARE_MGMT_CACHE_TTL", _MIRROR_CACHE_TTL)
    # Caching off (tests) — build straight through.
    if not (ttl and ttl > 0):
        return build()
    now = time.time()
    hit = _MIRROR_CACHE.get(key)
    if hit is not None and hit[0] > now:
        return hit[1]
    value = build()
    # Drop what has expired, so a key that is never asked for again (last
    # month's window) does not stay for the life of the process.
    for stale in [k for k, (expires, _) in list(_MIRROR_CACHE.items()) if expires <= now]:
        _MIRROR_CACHE.pop(stale, None)
    _MIRROR_CACHE[key] = (now + ttl, value)
    return value


def _safe(what, read, fallback=None):
    """Run one sub-query of the payload. A failure is logged and answered with
    `fallback` ("could not be computed"), so one unreadable figure never takes
    the whole board down with it."""
    try:
        return read()
    except Exception:  # noqa: BLE001 — see above
        current_app.logger.exception("Spare management: %s could not be computed", what)
        # A failed statement can leave the transaction unusable for the
        # queries that follow; nothing here writes, so there is nothing to lose.
        db.session.rollback()
        return fallback


def _stamp(value):
    """A stored instant as a naive-UTC ISO string — how SQLite hands stamps
    back, and what the screens' parseServerTime reads."""
    value = _utc_naive(value)
    return value.isoformat() if value else None


def _dict(value):
    """A saved setting is JSON an admin screen wrote, but never trusted to be
    the right shape."""
    return value if isinstance(value, dict) else {}


def _count(condition):
    """How many rows meet a condition, as a SUM so several counts share one
    query. Coalesced: SUM over no rows is NULL, and that is a measured zero."""
    return func.coalesce(func.sum(case((condition, 1), else_=0)), 0)


def _rupees(value):
    """Money for a sentence, printed the way the boards print it."""
    if value >= 1e7:
        return f"₹ {value / 1e7:.2f} Cr"
    if value >= 1e5:
        return f"₹ {value / 1e5:.2f} L"
    return f"₹ {value:,.0f}"


def _waiting(age):
    """How long the oldest request has waited: hours for the first two days,
    whole days after that."""
    hours = int(age.total_seconds() // 3600)
    if hours < 1:
        return "under 1 h"
    return f"{hours} h" if hours < 48 else f"{hours // 24} d"


def _month_starts(as_of, count):
    """The first day of each of the last `count` plant months, oldest first."""
    year, month = as_of.year, as_of.month
    out = []
    for _ in range(count):
        out.append(date(year, month, 1))
        year, month = (year, month - 1) if month > 1 else (year - 1, 12)
    return out[::-1]


def _aging_bucket(days):
    if days is None:
        return "none"
    if days <= 30:
        return "0-30"
    return "31-90" if days <= 90 else "91+"


def _aging_unknown(as_of, erp):
    """The excess-aging block when it could not be read: the same shape, so the
    screens still draw, with every figure None."""
    return {
        "basis": "last_inward_erp", "as_of": as_of.isoformat(),
        "horizon": None, "horizon_days": None, "erp": erp,
        "total": {"parts": None, "value": None, "unrated": None},
        "buckets": [{"key": key, "label": label, "parts": None, "value": None, "unrated": None}
                    for key, label in AGING_BUCKETS],
        "idle": {"parts": None, "value": None},
        "top": [],
        "part_buckets": None,
    }


def _line(count, value=None, value_label=None, detail="", sections=()):
    """One tracker line's live figures. count None = it could not be computed."""
    return {"count": count, "value": value, "value_label": value_label,
            "detail": detail, "sections": list(sections)}


def _note(spec, entry):
    """A line's saved owner / target date / remarks over its defaults."""
    entry = _dict(entry)
    owner = entry.get("owner") or ""
    return {
        "owner": owner or spec["owner"],
        "owner_is_default": not owner,
        "target_date": entry.get("target_date") or None,
        "remarks": entry.get("remarks") or "",
        "updated_by": entry.get("updated_by"),
        "updated_at": entry.get("updated_at"),
    }


def _text(value, name, limit):
    if value is None:
        return ""
    if not isinstance(value, str):
        raise BadRequestError(f"{name} must be text")
    value = value.strip()
    if len(value) > limit:
        raise BadRequestError(f"{name} can be at most {limit} characters")
    return value


def _target_date(value):
    if value in (None, ""):
        return None
    try:
        return date.fromisoformat(str(value).strip()).isoformat()
    except ValueError:
        raise BadRequestError("target_date must be a date (YYYY-MM-DD)") from None


class SpareManagementService:
    def __init__(self):
        self.dashboard = SpareDashboardService()
        self.stock = self.dashboard.stock
        self.erp_grn = self.dashboard.erp_grn

    # ------------------------------------------------------------------ public

    def management(self, store_code, section_id=None, section_ids=None, user=None):
        """The management block of a store, one section, or a section group
        (section_ids wins over section_id — the same precedence as the
        overview). `user` is the signed-in User, or None for the machine caller:
        only an administrator may edit the tracker's notes."""
        # Read before anything else: a sub-query that fails rolls the session
        # back, and the user would have to be loaded again.
        can_edit = bool(user is not None and user.is_admin)
        rows = self.stock.list_stock(store_code, section_id, section_ids=section_ids)
        names = self.dashboard._section_names(store_code)
        agg = self.dashboard._aggregate(rows)
        # One clock reading for the whole payload. Stamps are stored in UTC;
        # every age, month and window below is cut on the plant clock (the
        # server's own zone), measured, never assumed.
        offset = _local_offset()
        now = utcnow().replace(tzinfo=None)
        as_of = (now + offset).date()
        since = now - timedelta(days=SCAN_WINDOW_DAYS)
        scope = (store_code, section_id, section_ids)
        # Same rule as the overview: a group is not the whole store either.
        store_level = section_id is None and not section_ids

        erp = _safe("the ERP mirror's freshness", self.erp_grn.mirror_freshness,
                    {"synced_at": None, "newest_grn_date": None})
        aging = _safe("excess aging", lambda: self._excess_aging(store_code, rows, names, as_of, erp),
                      _aging_unknown(as_of, erp))
        kiosk = _safe("the kiosk requests", lambda: self._kiosk(*scope, since),
                      dict.fromkeys(("open", "issued", "oldest_open_at")))
        return {
            "store_code": store_code,
            "section_id": section_id,
            "section_ids": sorted(section_ids) if section_ids else None,
            "generated_at": utcnow().isoformat(),
            "as_of": as_of.isoformat(),
            "tracker": self._tracker(*scope, store_level, rows, names, agg, aging, kiosk, now, as_of, can_edit),
            "excess_aging": aging,
            "movement": self._movement(*scope, as_of, offset, erp, agg["quality"]["missing_rate"]),
            "scan": self._scan(*scope, store_level, since, kiosk),
        }

    def set_tracker_item(self, store_code, key, data, user=None):
        """Save an administrator's note on one tracker line: who owns it, by
        when, and remarks. Only the fields present in `data` change; an empty
        owner goes back to the line's default and an empty target date clears
        it. `user` is the acting username. All notes live in ONE app_settings
        row, {store: {line key: note}}. Returns the saved note over the line's
        defaults."""
        spec = _SPEC.get(key)
        if spec is None:
            raise BadRequestError(f"Unknown action tracker item '{key}'")
        # A note is kept under its store's code: one saved under a code that is
        # not a store would show on no screen and stay in the row for good.
        if Store.query.filter_by(code=store_code).first() is None:
            raise BadRequestError(f"Unknown store '{str(store_code)[:40]}'")
        if not isinstance(data, dict):
            raise BadRequestError("The request body must be a JSON object")
        saved = _dict(AppSetting.get_value(SETTING_KEY))
        store = _dict(saved.get(store_code))
        entry = {"owner": "", "target_date": None, "remarks": "", **_dict(store.get(key))}
        if "owner" in data:
            entry["owner"] = _text(data["owner"], "owner", OWNER_MAX)
        if "target_date" in data:
            entry["target_date"] = _target_date(data["target_date"])
        if "remarks" in data:
            entry["remarks"] = _text(data["remarks"], "remarks", REMARKS_MAX)
        entry["updated_by"] = user
        entry["updated_at"] = utcnow().isoformat()
        saved[store_code] = {**store, key: entry}
        AppSetting.set_value(SETTING_KEY, saved, user)
        return {"key": key, **_note(spec, entry)}

    # ---------------------------------------------------------- action tracker

    def _tracker(self, store_code, section_id, section_ids, store_level, rows, names, agg, aging,
                 kiosk, now, as_of, can_edit):
        """Each line's live figures — the stock lines off the list, every queue
        from the overview's own helper and guarded on its own — under the note
        an administrator saved on it."""
        lines, to_restock = self._stock_lines(rows, names, agg, aging)
        readers = {
            "confirm_pending": lambda: _line(
                self.dashboard._pending_confirmations(store_code, section_id, section_ids)),
            "kiosk_open": lambda: self._kiosk_line(kiosk, now),
            "returns_pending": lambda: self._returns_line(store_code, section_id, section_ids),
            "rgp_overdue": lambda: _line(
                self.dashboard._rgp(store_code, section_id, section_ids)["overdue"]),
        }
        if store_level:
            readers.update({
                "srv_pending": lambda: self._srv_line(store_code),
                "erp_gap": lambda: self._erp_gap_line(rows),
                "erp_pending": lambda: _line(self.stock.pending_erp_count(store_code)),
            })
        for key, read in readers.items():
            lines[key] = _safe(f"the tracker's {key} line", read, _line(None))

        notes = _dict(_safe("the tracker's saved notes",
                            lambda: _dict(AppSetting.get_value(SETTING_KEY)).get(store_code)))
        items = [self._item(spec, lines[spec["key"]], notes.get(spec["key"]), as_of)
                 for spec in TRACKER_ITEMS if spec["key"] in lines]
        return {
            "items": items,
            "summary": {
                "open": sum(1 for it in items if it["status"] == "OPEN"),
                "clear": sum(1 for it in items if it["status"] == "CLEAR"),
                "overdue": sum(1 for it in items if it["overdue"]),
                "critical_parts": lines["critical"]["count"],
                "to_restock": to_restock,
                "tied_up": lines["excess"]["value"],
            },
            "can_edit": can_edit,
        }

    @staticmethod
    def _item(spec, line, entry, as_of):
        count = line["count"]
        status = "UNKNOWN" if count is None else ("OPEN" if count > 0 else "CLEAR")
        note = _note(spec, entry)
        target = _as_date(note["target_date"])
        days = (target - as_of).days if target else None
        return {
            "key": spec["key"], "label": spec["label"], "detail": line["detail"],
            "count": count, "value": line["value"], "value_label": line["value_label"],
            # A zero count is never critical — it is simply "ok".
            "severity": "ok" if count == 0 else spec["severity"],
            "status": status,
            "action": spec["action"],
            **note,
            # Only an open point can be late: a cleared one met its date.
            "overdue": status == "OPEN" and days is not None and days < 0,
            "days_to_target": days,
            "sections": line["sections"],
            "link": dict(spec["link"]),
            "scope": "store" if spec.get("store_only") else "section",
        }

    @staticmethod
    def _stock_lines(rows, names, agg, aging):
        """The four lines read straight off the stock list — their counts, where
        the parts are, and the money — and the restock total of the short ones."""
        def where(counts):
            return [{"section_id": sid, "name": names.get(sid, "Unassigned"), "count": n}
                    for sid, n in sorted(counts.items(), key=lambda kv: -kv[1])[:3]]

        # The overview's restock rule (SpareDashboardService._aggregate), split
        # here so each line quotes its own spend: the gap to max — or to min
        # where no max is set — at the part's rate. A part with no rate adds
        # nothing.
        restock = {"Out of Stock": 0.0, "Below Minimum": 0.0, "Reorder": 0.0}
        unrated = Counter()
        for r in rows:
            rate = r["unit_price"]
            if rate is None:
                unrated[r["section_id"]] += 1
            if r["status"] in restock and rate:
                need = r["shortfall"]
                if need is None:
                    gap = (r["min_stock_level"] or 0) - (r["qty_on_hand"] or 0)
                    need = gap if gap > 0 else None
                if need:
                    restock[r["status"]] += need * rate

        by_status, at = agg["by_status"], agg["where"]
        zero, below = by_status["Out of Stock"]["count"], by_status["Below Minimum"]["count"]
        critical = restock["Out of Stock"] + restock["Below Minimum"]
        horizon = _as_date(aging["horizon"])
        # The "none" bucket is the last one: excess with no inward on record.
        undated = aging["buckets"][-1]["value"]
        no_rate = agg["quality"]["missing_rate"]
        lines = {
            "critical": _line(zero + below, _money(critical), "to restock to max",
                              f"{zero:,} zero stock · {below:,} below minimum",
                              where(Counter(at["Out of Stock"]) + Counter(at["Below Minimum"]))),
            "reorder": _line(by_status["Reorder"]["count"], _money(restock["Reorder"]),
                             "to restock to max", sections=where(at["Reorder"])),
            "excess": _line(by_status["Above Maximum"]["count"], _money(agg["excess_value"]),
                            "tied up above max",
                            (f"{_rupees(undated)} with no ERP inward on record since {horizon:%d %b}"
                             if horizon and undated else ""),
                            where(at["Above Maximum"])),
            "no_rate": _line(no_rate,
                             detail="Not valued — left out of stock value and excess" if no_rate else "",
                             sections=where(unrated)),
        }
        # Rounded once, like the overview's total — not summed from two rounded lines.
        return lines, _money(critical + restock["Reorder"])

    def _srv_line(self, store_code):
        receiving = self.dashboard._receiving_pending(store_code, None, None)
        oldest = _as_date(receiving["oldest_grn_date"])
        return _line(receiving["total"], detail=f"Oldest GRN {oldest:%d %b}" if oldest else "")

    def _erp_gap_line(self, rows):
        """Parts whose ERP snapshot differs from the physical count, by the ERP
        vs Physical screen's own status rule — run over the store's stock list
        already in hand, where the screen's own listing would hydrate every
        part of the store a second time (half of this call's time)."""
        erp_qty = {r.part_id: float(r.qty_on_hand) for r in self.stock.erp_repo.list_all()}
        states = Counter(ERPGapService._status(erp_qty.get(r["part_id"]), r["qty_on_hand"]) for r in rows)
        short, excess = states["SHORT"], states["EXCESS"]
        return _line(short + excess, detail=f"{short:,} short · {excess:,} excess vs the ERP snapshot")

    def _returns_line(self, store_code, section_id, section_ids):
        pending = self.dashboard._returns_pending(store_code, section_id, section_ids)
        return _line(pending["inspection"] + pending["hold"] + pending["damaged"])

    @staticmethod
    def _kiosk_line(kiosk, now):
        oldest = kiosk["oldest_open_at"]
        return _line(kiosk["open"],
                     detail=f"Oldest waiting {_waiting(now - datetime.fromisoformat(oldest))}" if oldest else "")

    # ------------------------------------------------------------ excess aging

    @staticmethod
    def _last_inward():
        """What the ERP mirror says about when each item last came in:
        {"grn" / "gate": {ITEM CODE: latest GRN / gate-entry date},
         "grn_from" / "gate_from": the earliest date each table holds}.
        Both tables carry store_code CHILD_PART on every row (the sync's
        constant), so they are never filtered by store; the item code is the
        Part No. Two store-wide GROUP BYs joined to the parts in Python — the
        per-part subquery form of this took half a minute."""
        def build():
            def latest(code, day):
                # Matched the way the rest of the app matches an ERP item code:
                # trimmed and case-blind.
                key = func.upper(func.trim(code))
                return {k: d for k, d in db.session.query(key, func.max(day))
                        .filter(code.isnot(None)).group_by(key) if d}
            return {
                "grn": latest(ReceivingRegister.item_cd, ReceivingRegister.grn_date),
                "gate": latest(GateEntry.item_code, GateEntry.gate_entry_dt),
                "grn_from": db.session.query(func.min(ReceivingRegister.grn_date)).scalar(),
                "gate_from": db.session.query(func.min(GateEntry.gate_entry_dt)).scalar(),
            }
        return _mirror_cached("last_inward", build)

    def _excess_aging(self, store_code, rows, names, as_of, erp):
        """The money above max by how long ago the part last came in. The date
        is ERP's — the later of the last GRN and the last gate entry. The app's
        own stock-in is only the fallback: a RECEIPT row is stamped when the
        app posted it, days or weeks after the GRN, so it must never override
        an ERP date. No date at all is the "none" bucket."""
        inward = self._last_inward()
        posted = dict(
            db.session.query(SpareStockLedger.part_id, func.max(SpareStockLedger.created_at))
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code, SpareStockLedger.txn_type == "RECEIPT")
            .group_by(SpareStockLedger.part_id).all())
        buckets = {key: {"key": key, "label": label, "parts": 0, "value": 0.0, "unrated": 0}
                   for key, label in AGING_BUCKETS}
        rated = []
        # Every excess part's band, rated or not — the Live Board lists the
        # parts behind a band from it, so the list is the band's own parts.
        part_buckets = {}
        for r in rows:
            if r["status"] != "Above Maximum" or not r["max_stock_level"]:
                continue
            code = (r["part_no"] or "").strip().upper()
            grn, gate = inward["grn"].get(code), inward["gate"].get(code)
            if grn and (not gate or grn >= gate):
                last, source = grn, "GRN"
            elif gate:
                last, source = gate, "GATE"
            else:
                last = _plant_date(posted.get(r["part_id"]))
                source = "LEDGER" if last else None
            days = (as_of - last).days if last else None
            bucket = buckets[_aging_bucket(days)]
            bucket["parts"] += 1
            part_buckets[r["part_id"]] = bucket["key"]
            # A part with no rate is counted, never valued.
            if not r["unit_price"]:
                bucket["unrated"] += 1
                continue
            over = r["qty_on_hand"] - r["max_stock_level"]
            value = over * r["unit_price"]
            bucket["value"] += value
            rated.append({
                "part_id": r["part_id"], "part_no": r["part_no"], "part_name": r["part_name"],
                "section_id": r["section_id"], "section": names.get(r["section_id"], "Unassigned"),
                "qty_on_hand": r["qty_on_hand"], "max_stock_level": r["max_stock_level"],
                "excess_qty": round(over, 2), "excess_value": _money(value),
                "last_inward": last.isoformat() if last else None, "last_inward_source": source,
                "days_since_inward": days, "bucket": bucket["key"],
            })
        rated.sort(key=lambda p: -p["excess_value"])

        horizon = min((d for d in (inward["grn_from"], inward["gate_from"]) if d), default=None)
        idle = (buckets["91+"], buckets["none"])
        return {
            "basis": "last_inward_erp",
            "as_of": as_of.isoformat(),
            "horizon": horizon.isoformat() if horizon else None,
            "horizon_days": (as_of - horizon).days if horizon else None,
            "erp": erp,
            "total": {"parts": sum(b["parts"] for b in buckets.values()),
                      "value": _money(sum(b["value"] for b in buckets.values())),
                      "unrated": sum(b["unrated"] for b in buckets.values())},
            "buckets": [{**b, "value": _money(b["value"])} for b in buckets.values()],
            "idle": {"parts": sum(b["parts"] for b in idle),
                     "value": _money(sum(b["value"] for b in idle))},
            "top": rated[:_TOP_EXCESS],
            "part_buckets": part_buckets,
        }

    # ---------------------------------------------------------------- movement

    @staticmethod
    def _erp_inward(store_code, section_id, section_ids, first):
        """The scope's ERP GRN lines per GRN month, valued at today's rate (the
        register stores none): {"YYYY-MM": (lines, receipt qty, receipt value,
        accepted value, lines quality has not cleared)}. grn_date is already a
        plant calendar date. Read on every call (a few milliseconds through
        the item_cd index), so a rate entered a moment ago is the rate used."""
        R = ReceivingRegister
        rated = Part.unit_price.isnot(None)
        month = func.strftime("%Y-%m", R.grn_date)
        q = (db.session.query(
                month, func.count(R.id), func.sum(R.receipt_qty),
                func.sum(case((rated, R.receipt_qty * Part.unit_price), else_=0)),
                func.sum(case((rated, func.coalesce(R.accept_qty, 0) * Part.unit_price), else_=0)),
                _count(R.accept_qty.is_(None)))
             # Exact equality, so SQLite uses the item_cd index: upper() in
             # this join walks the whole register once per part (minutes).
             # Never filtered on R.store_code — see _last_inward.
             .select_from(Part).join(R, R.item_cd == Part.part_no)
             .filter(Part.store_code == store_code, R.grn_date >= first,
                     *_sec_tuple(section_id, section_ids))
             .group_by(month))
        return {period: (int(lines), float(qty or 0), float(value or 0), float(accepted or 0), int(pending))
                for period, lines, qty, value, accepted, pending in q}

    @staticmethod
    def _ledger_movement(store_code, section_id, section_ids, first, offset):
        """The app's own ledger for the scope: RECEIPT and ISSUE per plant
        month, valued at today's rate — {"YYYY-MM": (in qty, in value, out qty,
        out value, issue lines)} — plus the plant date of the scope's first
        ledger row of any kind and whether it has ever recorded an issue."""
        L = SpareStockLedger
        scope = _sec_tuple(section_id, section_ids)
        is_in, is_out = L.txn_type == "RECEIPT", L.txn_type == "ISSUE"
        rated = Part.unit_price.isnot(None)
        # created_at is UTC: shift it onto the plant clock before cutting
        # months, and take the window's first plant midnight back to UTC.
        month = func.strftime("%Y-%m", L.created_at, f"{int(offset.total_seconds() // 60):+d} minutes")
        q = (db.session.query(
                month,
                func.sum(case((is_in, L.qty_delta), else_=0)),
                func.sum(case((and_(is_in, rated), L.qty_delta * Part.unit_price), else_=0)),
                func.sum(case((is_out, -L.qty_delta), else_=0)),
                func.sum(case((and_(is_out, rated), -L.qty_delta * Part.unit_price), else_=0)),
                _count(is_out))
             .join(Part, Part.id == L.part_id)
             .filter(Part.store_code == store_code, L.txn_type.in_(("RECEIPT", "ISSUE")),
                     L.created_at >= datetime.combine(first, datetime.min.time()) - offset, *scope)
             .group_by(month))
        months = {period: (float(in_qty or 0), float(in_value or 0), float(out_qty or 0),
                           float(out_value or 0), int(out_lines))
                  for period, in_qty, in_value, out_qty, out_value, out_lines in q}
        first_row, issues = (db.session.query(func.min(L.created_at), _count(is_out))
                             .join(Part, Part.id == L.part_id)
                             .filter(Part.store_code == store_code, *scope).one())
        return {"months": months, "since": _plant_date(first_row), "issues": bool(issues)}

    def _movement(self, store_code, section_id, section_ids, as_of, offset, erp, unrated_parts):
        """Monthly IN against OUT in rupees for the last six plant months. IN is
        what the plant received (the ERP GRN register); OUT is what the store
        issued in the app. A month neither source covers is None, never 0: a
        bar at zero would say "nothing moved" where the truth is "not known"."""
        months = _month_starts(as_of, MOVEMENT_MONTHS)
        first = months[0]
        scope = (store_code, section_id, section_ids)
        by_grn_month, grn_from = _safe(
            "the monthly ERP inward",
            lambda: (self._erp_inward(*scope, first), self._last_inward()["grn_from"]), (None, None))
        ledger = _safe("the monthly ledger movement", lambda: self._ledger_movement(*scope, first, offset))

        # The register is a rolling window, so its oldest month is cut short.
        # A month counts as covered only when the register holds it from its
        # first day, up to the month of its newest GRN.
        newest = _as_date(erp["newest_grn_date"])

        def covered(month):
            return bool(by_grn_month is not None and grn_from and newest
                        and grn_from <= month <= newest.replace(day=1))

        # Before the scope's first ledger row nothing was being recorded, so
        # "no issue" there is unknown; from that month on it is a measured zero.
        tracked_from = ledger["since"].replace(day=1) if ledger and ledger["since"] else None
        out = []
        for month in months:
            period = f"{month:%Y-%m}"
            row = {"period": period, "label": f"{month:%b}", "current": month == months[-1],
                   "in_value": None, "in_qty": None, "in_lines": 0,
                   "accepted_value": None, "pending_lines": 0,
                   "out_value": None, "out_qty": None, "out_lines": 0,
                   "app_in_value": None, "app_in_qty": None}
            if covered(month):
                lines, qty, value, accepted, pending = by_grn_month.get(period, (0, 0.0, 0.0, 0.0, 0))
                row.update(in_value=_money(value), in_qty=round(qty, 2), in_lines=lines,
                           accepted_value=_money(accepted), pending_lines=pending)
            if ledger is not None:
                in_qty, in_value, out_qty, out_value, out_lines = ledger["months"].get(
                    period, (0.0, 0.0, 0.0, 0.0, 0))
                row.update(app_in_value=_money(in_value), app_in_qty=round(in_qty, 2))
                if tracked_from and month >= tracked_from:
                    row.update(out_value=_money(out_value), out_qty=round(out_qty, 2), out_lines=out_lines)
            out.append(row)

        this = out[-1]
        both = this["in_value"] is not None and this["out_value"] is not None
        return {
            "months": out,
            "in_source": "ERP GRN register · receipt qty × current rate",
            "out_source": "App issue ledger · issued qty × current rate",
            "erp": {**erp, "coverage_from": grn_from.isoformat() if grn_from else None},
            "issues_recorded": ledger["issues"] if ledger else None,
            "issue_tracking_since": ledger["since"].isoformat() if ledger and ledger["since"] else None,
            "this_month": {"period": this["period"], "in_value": this["in_value"],
                           "out_value": this["out_value"],
                           "net_value": _money(this["in_value"] - this["out_value"]) if both else None},
            "unrated_parts": unrated_parts,
        }

    # -------------------------------------------------------------------- scan

    def _scan(self, store_code, section_id, section_ids, store_level, since, kiosk):
        """Scan discipline over a rolling 30 days. `scans` covers the Scan Part
        page only (the one screen that audits every read); the other three say
        how the scan-first flows around it are being used."""
        scope = (store_code, section_id, section_ids)
        scan_keys = ("total", "scanned", "typed", "not_found", "scanned_ok", "typed_ok",
                     "users", "last_at", "scan_first_pct")
        prev_keys = ("total", "scanned", "scan_first_pct")
        prev = _safe("the previous window's scans",
                     lambda: self._scan_counts(*scope, since - timedelta(days=SCAN_WINDOW_DAYS), since),
                     dict.fromkeys(prev_keys))
        return {
            "window_days": SCAN_WINDOW_DAYS,
            "scans": _safe("the Scan Part scans", lambda: self._scan_counts(*scope, since),
                           dict.fromkeys(scan_keys)),
            "prev": {k: prev[k] for k in prev_keys},
            "issues": _safe("the issues by scan", lambda: self._issues_by_scan(*scope, since),
                            dict.fromkeys(("total", "by_scan", "by_search", "unrecorded", "by_scan_pct"))),
            "put_away": _safe("the put-away confirmations", lambda: self._put_aways(*scope, since),
                              dict.fromkeys(("count", "with_lot_tag", "users", "last_at", "ever"))),
            "kiosk": kiosk,
            # A code that was not found has no part, so no section: in a
            # section's figures those scans are simply absent.
            "not_found_scope": "store" if store_level else "section",
        }

    def _scan_counts(self, store_code, section_id, section_ids, since, until=None):
        A = ScanAudit
        scanned = A.scan_source.in_(SCANNED_SOURCES)
        typed = A.scan_source == "MANUAL_ENTRY"
        found = A.result == "SUCCESS"
        q = (db.session.query(
                func.count(A.id), _count(scanned), _count(typed), _count(~found),
                _count(and_(scanned, found)), _count(and_(typed, found)),
                func.count(func.distinct(A.user)), func.max(A.created_at))
             .filter(A.store_code == store_code, A.created_at >= since))
        if until is not None:
            q = q.filter(A.created_at < until)
        scope = _sec_tuple(section_id, section_ids)
        if scope:
            # A scan belongs to a section through the part it resolved to.
            q = q.join(Part, Part.id == A.part_id).filter(*scope)
        total, n_scanned, n_typed, not_found, scanned_ok, typed_ok, users, last_at = q.one()
        return {
            "total": total, "scanned": int(n_scanned), "typed": int(n_typed), "not_found": int(not_found),
            "scanned_ok": int(scanned_ok), "typed_ok": int(typed_ok), "users": users,
            "last_at": _stamp(last_at),
            "scan_first_pct": self.stock._pct(int(n_scanned), total),
        }

    def _issues_by_scan(self, store_code, section_id, section_ids, since):
        """How the part was reached on each issue of the window. Read from the
        LEDGER outwards: the journal is append-only and still holds the ISSUE
        rows of test issues whose ledger rows were removed. Those must not
        count — and because SQLite hands a freed ledger id out again, a journal
        row only belongs to a ledger row of the same part."""
        L, J = SpareStockLedger, SpareTransaction
        q = (db.session.query(J.scan_source, func.count(L.id))
             .select_from(L)
             .join(Part, Part.id == L.part_id)
             .outerjoin(J, and_(J.issue_id == L.id, J.txn_type == "ISSUE", J.part_id == L.part_id))
             .filter(L.txn_type == "ISSUE", Part.store_code == store_code,
                     func.coalesce(L.status, "") != "CANCELLED", L.created_at >= since,
                     *_sec_tuple(section_id, section_ids))
             .group_by(J.scan_source))
        by_source = dict(q.all())
        total = sum(by_source.values())
        by_scan = sum(by_source.get(s, 0) for s in ISSUE_BY_SCAN)
        by_search = sum(by_source.get(s, 0) for s in ISSUE_BY_SEARCH)
        return {"total": total, "by_scan": by_scan, "by_search": by_search,
                # No source on the journal row, or no journal row at all.
                "unrecorded": total - by_scan - by_search,
                "by_scan_pct": self.stock._pct(by_scan, total)}

    @staticmethod
    def _put_aways(store_code, section_id, section_ids, since):
        """Put-aways confirmed on the Put-away Check screen. Every row is a bin
        scan the server verified; one with a gate entry no. came from a lot tag
        rather than a plain part QR. `ever` tells "not started yet" from "none
        in the window"."""
        P = PutAwayLog
        recent = P.created_at >= since
        q = db.session.query(
            _count(recent), _count(and_(recent, P.gate_entry_no.isnot(None))),
            func.count(func.distinct(case((recent, P.put_by)))),
            func.max(case((recent, P.confirmed_at))), func.count(P.id),
        ).filter(P.store_code == store_code)
        # The log carries its own section (denormalised at write).
        if section_ids:
            q = q.filter(P.section_id.in_(list(section_ids)))
        elif section_id:
            q = q.filter(P.section_id == section_id)
        count, with_lot_tag, users, last_at, ever = q.one()
        return {"count": int(count), "with_lot_tag": int(with_lot_tag), "users": users,
                "last_at": _stamp(last_at), "ever": ever > 0}

    @staticmethod
    def _kiosk(store_code, section_id, section_ids, since):
        """Kiosk part requests: still open (whenever raised), issued in the
        window, and since when the oldest open one has been waiting."""
        K = PartRequest
        is_open = K.status.in_(OPEN_STATUSES)
        q = db.session.query(
            _count(is_open), _count(and_(K.status == "ISSUED", K.issued_at >= since)),
            func.min(case((is_open, K.created_at))),
        ).filter(K.store_code == store_code)
        scope = _sec_tuple(section_id, section_ids)
        if scope:
            q = q.join(Part, Part.id == K.part_id).filter(*scope)
        n_open, issued, oldest = q.one()
        return {"open": int(n_open), "issued": int(issued), "oldest_open_at": _stamp(oldest)}

    # ------------------------------------------------------ Live Board lists

    def board_list(self, store_code, kind, key=None, section_id=None, section_ids=None):
        """The rows behind one figure of the Live Board, read by that figure's
        own rule, so the list ties out to what was tapped:

            in        key YYYY-MM   the ERP GRN lines of the month (In bar):
                                    count = in_lines, value = in_value
            out       key YYYY-MM   the app's ISSUE rows of the plant month
                                    (Out bar): count = out_lines, value = out_value
            dept      key name      this month's issues of that consuming
                                    department: qty = its Dept. Issue figure
            scans     key filter    the Scan Part scans of the last 30 days
            issues    key filter    the last 30 days' issues, by how the part
                                    was reached (Issues by scan)
            put_away  key filter    the put-aways of the last 30 days

        Read-only. Returns {kind, key, rows, count, qty, value}; value is None
        for a list that carries no rupees."""
        if kind not in BOARD_LIST_KEYS:
            raise BadRequestError(f"kind must be one of: {', '.join(BOARD_LIST_KEYS)}")
        allowed = BOARD_LIST_KEYS[kind]
        if allowed is not None:
            key = key or "all"
            if key not in allowed:
                raise BadRequestError(f"key must be one of: {', '.join(allowed)}")
        elif not key or not isinstance(key, str):
            raise BadRequestError("key is required")
        scope = (store_code, section_id, section_ids)
        since = utcnow().replace(tzinfo=None) - timedelta(days=SCAN_WINDOW_DAYS)
        if kind in ("in", "out"):
            period = self._period(key)
            rows = self._in_rows(*scope, period) if kind == "in" else self._out_rows(*scope, period)
            key = period
        elif kind == "dept":
            rows = self._dept_rows(*scope, key)
        elif kind == "scans":
            rows = self._scan_rows(*scope, since, key)
        elif kind == "issues":
            rows = self._issue_rows(*scope, since, key)
        else:
            rows = self._put_away_rows(*scope, since, key)
        valued = kind in ("in", "out")
        return {
            "kind": kind, "key": key, "rows": rows, "count": len(rows),
            "qty": round(sum(r.get("qty") or 0 for r in rows), 2),
            "value": _money(sum(r.get("value") or 0 for r in rows)) if valued else None,
        }

    @staticmethod
    def _period(text):
        """A month as YYYY-MM, or a 400."""
        try:
            first = datetime.strptime(f"{str(text).strip()}-01", "%Y-%m-%d").date()
        except ValueError:
            raise BadRequestError("key must be a month, YYYY-MM") from None
        return f"{first:%Y-%m}"

    def _ledger_row(self, e, how=None):
        """A ledger row in the board's movement-list shape, with `qty` as a
        positive amount moved."""
        row = self.stock._activity_row(e)
        row["at"] = _stamp(e.created_at)
        row["qty"] = abs(row["qty_delta"])
        if how:
            row["how"] = how
        return row

    @staticmethod
    def _in_rows(store_code, section_id, section_ids, period):
        """The ERP GRN lines behind a month's In bar — _erp_inward's own join
        and filters, one row per register line, valued at today's rate (None
        for a part with no rate, which adds nothing to the bar)."""
        R = ReceivingRegister
        rated = Part.unit_price.isnot(None)
        first = datetime.strptime(f"{period}-01", "%Y-%m-%d").date()
        q = (db.session.query(R, Part, case((rated, R.receipt_qty * Part.unit_price), else_=None))
             .select_from(Part).join(R, R.item_cd == Part.part_no)
             .filter(Part.store_code == store_code, R.grn_date >= first,
                     func.strftime("%Y-%m", R.grn_date) == period,
                     *_sec_tuple(section_id, section_ids))
             .order_by(R.grn_date.desc(), R.id.desc()))
        rows = []
        for r, p, value in q:
            qty = float(r.receipt_qty) if r.receipt_qty is not None else None
            rows.append({
                "id": r.id, "at": r.grn_date.isoformat() if r.grn_date else None,
                "txn_type": "GRN", "part_id": p.id, "part_no": p.part_no, "part_name": p.part_name,
                "section_id": p.section_id, "qty_delta": qty, "balance_after": None, "qty": qty,
                "value": float(value) if value is not None else None,
                "grn_no": r.grn_no, "ven_name": r.ven_name or r.ven_cd,
                "accept_qty": float(r.accept_qty) if r.accept_qty is not None else None,
            })
        return rows

    def _out_rows(self, store_code, section_id, section_ids, period):
        """The app's ISSUE rows behind a month's Out bar — _ledger_movement's
        own filters, the month cut on the plant clock — valued at today's
        rate."""
        L = SpareStockLedger
        offset = _local_offset()
        month = func.strftime("%Y-%m", L.created_at, f"{int(offset.total_seconds() // 60):+d} minutes")
        rated = Part.unit_price.isnot(None)
        q = (db.session.query(L, case((rated, -L.qty_delta * Part.unit_price), else_=None))
             .join(Part, Part.id == L.part_id)
             .filter(Part.store_code == store_code, L.txn_type == "ISSUE", month == period,
                     *_sec_tuple(section_id, section_ids))
             .order_by(L.created_at.desc(), L.id.desc()))
        rows = []
        for e, value in q:
            row = self._ledger_row(e)
            row["value"] = float(value) if value is not None else None
            rows.append(row)
        return rows

    def _dept_rows(self, store_code, section_id, section_ids, department):
        """This month's issues consumed by one department — the overview's
        this_month_by_department rule (consumption_by_department over the
        month to date): not cancelled, the department owning the part's
        section."""
        from app.services.consumption_analytics_service import consumer_of, consumers
        from app.services.spare_stock_service import _not_cancelled
        L = SpareStockLedger
        today = datetime.now().date()
        window = self.stock._consumption_window(None, today.replace(day=1).isoformat(), today.isoformat())
        owner, _ = consumers(store_code)
        q = (db.session.query(L).join(Part, Part.id == L.part_id)
             .filter(Part.store_code == store_code, L.txn_type == "ISSUE", _not_cancelled(),
                     *_sec_tuple(section_id, section_ids), *window)
             .order_by(L.created_at.desc(), L.id.desc()))
        return [self._ledger_row(e) for e in q
                if consumer_of(owner, e.part.section_id if e.part else None) == department]

    @staticmethod
    def _scan_rows(store_code, section_id, section_ids, since, key):
        """The Scan Part scans behind the scan tiles — _scan_counts' own
        filters (a section reaches a scan through the part it resolved to)."""
        A = ScanAudit
        scanned = A.scan_source.in_(SCANNED_SOURCES)
        typed = A.scan_source == "MANUAL_ENTRY"
        found = A.result == "SUCCESS"
        q = (db.session.query(A, Part).outerjoin(Part, Part.id == A.part_id)
             .filter(A.store_code == store_code, A.created_at >= since,
                     *_sec_tuple(section_id, section_ids)))
        where = {"scanned": scanned, "scanned_ok": and_(scanned, found),
                 "typed_ok": and_(typed, found), "not_found": ~found}.get(key)
        if where is not None:
            q = q.filter(where)
        rows = []
        for a, p in q.order_by(A.created_at.desc(), A.id.desc()):
            # How the code got in, then whether it was found — so the list's
            # SCANNED rows are the rate tile's scans and its NOT FOUND rows the
            # not-found tile's.
            how = ("SCANNED" if a.scan_source in SCANNED_SOURCES
                   else "TYPED" if a.scan_source == "MANUAL_ENTRY" else a.scan_source)
            if a.result != "SUCCESS":
                how = f"{how} · NOT FOUND"
            rows.append({
                "id": a.id, "at": _stamp(a.created_at), "txn_type": how, "how": how,
                "part_id": p.id if p else None, "part_no": p.part_no if p else a.scanned_code,
                "part_name": p.part_name if p else None, "section_id": p.section_id if p else None,
                "scanned_code": a.scanned_code, "scan_source": a.scan_source, "result": a.result,
                "user": a.user, "qty_delta": None, "balance_after": None,
            })
        return rows

    def _issue_rows(self, store_code, section_id, section_ids, since, key):
        """The issues behind "Issues by scan" — _issues_by_scan's own join, one
        row per row it counts — each saying how the part was reached."""
        L, J = SpareStockLedger, SpareTransaction
        q = (db.session.query(L, J.scan_source)
             .select_from(L)
             .join(Part, Part.id == L.part_id)
             .outerjoin(J, and_(J.issue_id == L.id, J.txn_type == "ISSUE", J.part_id == L.part_id))
             .filter(L.txn_type == "ISSUE", Part.store_code == store_code,
                     func.coalesce(L.status, "") != "CANCELLED", L.created_at >= since,
                     *_sec_tuple(section_id, section_ids)))
        source = func.coalesce(J.scan_source, "")
        where = {"scan": source.in_(ISSUE_BY_SCAN), "search": source.in_(ISSUE_BY_SEARCH),
                 "unrecorded": source.notin_(ISSUE_BY_SCAN + ISSUE_BY_SEARCH)}.get(key)
        if where is not None:
            q = q.filter(where)
        rows = []
        for e, src in q.order_by(L.created_at.desc(), L.id.desc()):
            how = "BY SCAN" if src in ISSUE_BY_SCAN else "BY SEARCH" if src in ISSUE_BY_SEARCH else "NOT RECORDED"
            row = self._ledger_row(e, how)
            row["scan_source"] = src
            rows.append(row)
        return rows

    @staticmethod
    def _put_away_rows(store_code, section_id, section_ids, since, key):
        """The put-aways behind "Put-away by scan" — _put_aways' own filters
        (the log carries its own section)."""
        P = PutAwayLog
        q = (db.session.query(P, Part).outerjoin(Part, Part.id == P.part_id)
             .filter(P.store_code == store_code, P.created_at >= since))
        if section_ids:
            q = q.filter(P.section_id.in_(list(section_ids)))
        elif section_id:
            q = q.filter(P.section_id == section_id)
        if key == "lot_tag":
            q = q.filter(P.gate_entry_no.isnot(None))
        rows = []
        for r, p in q.order_by(P.created_at.desc(), P.id.desc()):
            qty = float(r.qty) if r.qty is not None else None
            rows.append({
                "id": r.id, "at": _stamp(r.confirmed_at or r.created_at), "txn_type": "PUT-AWAY",
                "part_id": r.part_id, "part_no": (p.part_no if p else None) or r.part_no,
                "part_name": p.part_name if p else None, "section_id": r.section_id,
                "qty_delta": qty, "balance_after": None, "qty": qty,
                "location": r.scanned_location, "assigned_location": r.assigned_location,
                "gate_entry_no": r.gate_entry_no, "put_by": r.put_by,
            })
        return rows
