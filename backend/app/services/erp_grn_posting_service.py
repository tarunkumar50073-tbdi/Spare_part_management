"""Spare receiving read from ERP: the GRN register -> store stock.

Receiving, the GRN and the Maintenance / Tool Room quality clearance all happen
in ERP (spec 1 / 9). The app records none of them by hand; it READS the ERP GRN
register (termsdb.srv_report, mirrored read-only into receiving_register by
ERPSyncService) and turns what ERP says into the part's store stock and history:

    ERP GRN line, accept_qty empty      -> GRN created, quality pending (not stock)
    ERP GRN line, accept_qty > 0        -> quality cleared: the accepted qty is
                                           added to available stock ONCE (a
                                           RECEIPT ledger row, status ERP_GRN,
                                           reference = GRN no.) + a journal row
    ERP GRN line, reject_qty > 0        -> rejected by quality (never stock)

Posting rules, all to avoid counting anything twice:
  * matched on item_cd = Part No. (the ERP item code), spare store parts only;
  * a part never physically counted is skipped — its first count includes it;
  * a GRN dated on/before the part's stock baseline (its last physical count,
    opening load or stock-row creation) is skipped — that count already has it;
  * a GRN dated before the configured "post from" date is never auto-posted;
  * each (part, GRN no.) is posted once; if ERP later accepts more on the same
    GRN only the difference is added; a reduction is flagged, never reversed
    silently.
RECEIPT rows with status ERP_GRN are ERP-originated, so the ERP stock-write
push leaves them out (models/spare_stock.ERP_ORIGIN_RECEIPT_STATUSES).

ERP gives no quality date — only the GRN date. The time the app first saw the
accepted qty (the sync that read it) is when the stock-in is recorded, and the
row says so.
"""
from collections import defaultdict
from datetime import date, datetime, timezone

from sqlalchemy import func

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.services.spare_journal_service import SpareJournalService
from app.services.spare_stock_service import SpareStockService
from app.utils.db_tx import atomic
from app.utils.exceptions import BadRequestError

SETTING_KEY = "erp_grn_autopost"
# Posting starts from the day this went live: GRNs before it are part of the
# physical counts the store already did. An admin can move it in Receiving & GRN.
DEFAULTS = {"enabled": True, "from_date": "2026-09-26"}
STATUS = "ERP_GRN"
ERP_USER = "ERP-GRN"


def _f(v):
    return float(v) if v is not None else None


def _plant_date(stamp):
    """A DB stamp (naive UTC in SQLite, or aware) as the plant's calendar date —
    the server clock is the plant clock."""
    if stamp is None:
        return None
    if isinstance(stamp, date) and not isinstance(stamp, datetime):
        return stamp
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone().date()


def _as_date(value):
    if value in (None, ""):
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        raise BadRequestError("from_date must be a date (YYYY-MM-DD)")


class ErpGrnPostingService:
    def __init__(self):
        self.stock = SpareStockService()
        self.journal = SpareJournalService()

    # ---- settings ----

    def settings(self):
        saved = AppSetting.get_value(SETTING_KEY)
        out = dict(DEFAULTS)
        if isinstance(saved, dict):
            out.update({k: saved[k] for k in DEFAULTS if k in saved})
        return out

    def set_settings(self, data, user=None):
        current = self.settings()
        if "enabled" in (data or {}):
            current["enabled"] = bool(data["enabled"])
        if "from_date" in (data or {}):
            d = _as_date(data["from_date"])
            if d is None:
                raise BadRequestError("from_date is required")
            if d > date.today():
                raise BadRequestError("from_date cannot be in the future")
            current["from_date"] = d.isoformat()
        AppSetting.set_value(SETTING_KEY, current, user)
        return current

    # ---- reading ----

    @staticmethod
    def _baseline(part_ids):
        """part_id -> (baseline plant date, counted?) — the latest of the last
        physical count, the latest OPENING / ADJUSTMENT row and the stock row's
        creation. No stock row = never counted."""
        rows = {r.part_id: r for r in SpareStock.query.filter(SpareStock.part_id.in_(part_ids)).all()} if part_ids else {}
        counts = dict(
            db.session.query(SpareStockLedger.part_id, func.max(SpareStockLedger.created_at))
            .filter(SpareStockLedger.part_id.in_(part_ids),
                    SpareStockLedger.txn_type.in_(("OPENING", "ADJUSTMENT")))
            .group_by(SpareStockLedger.part_id).all()
        ) if part_ids else {}
        out = {}
        for pid in part_ids:
            r = rows.get(pid)
            if r is None:
                out[pid] = (None, False)
                continue
            dates = [d for d in (_plant_date(r.last_counted_at), _plant_date(counts.get(pid)),
                                 _plant_date(r.created_at)) if d]
            out[pid] = (max(dates) if dates else None, True)
        return out

    @staticmethod
    def _posted(part_ids):
        """(part_id, grn_no) -> qty already posted from ERP."""
        if not part_ids:
            return {}
        q = (db.session.query(SpareStockLedger.part_id, SpareStockLedger.reference,
                              func.sum(SpareStockLedger.qty_delta))
             .filter(SpareStockLedger.part_id.in_(part_ids), SpareStockLedger.txn_type == "RECEIPT",
                     SpareStockLedger.status == STATUS)
             .group_by(SpareStockLedger.part_id, SpareStockLedger.reference))
        return {(pid, ref): round(float(qty or 0), 2) for pid, ref, qty in q.all()}

    def lines(self, store_code, part_id=None):
        """Every ERP GRN line of the store's parts (in the mirror's window),
        grouped per (part, GRN no.), each with what the app does with it."""
        parts_q = Part.query.filter(Part.store_code == store_code)
        if part_id:
            parts_q = parts_q.filter(Part.id == part_id)
        parts = {p.part_no.upper(): p for p in parts_q.all() if p.part_no}
        if not parts:
            return []
        grn_q = ReceivingRegister.query.filter(func.upper(ReceivingRegister.item_cd).in_(list(parts)))
        grouped = defaultdict(lambda: {"receipt": 0.0, "accept": None, "reject": None, "rows": []})
        for r in grn_q.all():
            part = parts.get((r.item_cd or "").upper())
            if part is None or not r.grn_no:
                continue
            g = grouped[(part.id, r.grn_no)]
            g["part"] = part
            g["grn_no"] = r.grn_no
            g["grn_date"] = min(filter(None, [g.get("grn_date"), r.grn_date]), default=None)
            g["ven_cd"] = g.get("ven_cd") or r.ven_cd
            g["ven_name"] = g.get("ven_name") or r.ven_name
            g["invoice_no"] = g.get("invoice_no") or r.challan_no
            g["receipt"] += float(r.receipt_qty or 0)
            if r.accept_qty is not None:
                g["accept"] = (g["accept"] or 0.0) + float(r.accept_qty)
            if r.reject_qty is not None:
                g["reject"] = (g["reject"] or 0.0) + float(r.reject_qty)

        cfg = self.settings()
        from_date = _as_date(cfg.get("from_date"))
        part_ids = list({k[0] for k in grouped})
        base = self._baseline(part_ids)
        posted = self._posted(part_ids)
        out = []
        for (pid, grn_no), g in grouped.items():
            part = g["part"]
            accepted = round(g["accept"], 2) if g["accept"] is not None else None
            rejected = round(g["reject"], 2) if g["reject"] is not None else None
            already = posted.get((pid, grn_no), 0.0)
            baseline, counted = base.get(pid, (None, False))
            grn_date = g.get("grn_date")
            state, reason, to_post = None, None, 0.0
            if not accepted:
                if rejected:
                    state, reason = "REJECTED", "Rejected by quality in ERP — not stock"
                else:
                    state, reason = "QUALITY_PENDING", "GRN created in ERP — quality clearance pending"
            elif already >= accepted:
                state = "POSTED" if already == accepted else "CHECK"
                reason = (f"{already:g} added to store stock from this GRN" if already == accepted
                          else f"ERP now accepts {accepted:g} but {already:g} was already added — check with ERP")
            elif not counted:
                state, reason = "SKIPPED", "Part not counted yet — its first physical count will include this"
            elif baseline and grn_date and grn_date <= baseline:
                state, reason = "SKIPPED", (f"GRN dated {grn_date.isoformat()}, on/before the part's stock "
                                            f"baseline {baseline.isoformat()} — that count already includes it")
            elif from_date and grn_date and grn_date < from_date:
                state, reason = "SKIPPED", f"GRN before the post-from date {from_date.isoformat()}"
            else:
                to_post = round(accepted - already, 2)
                state = "WILL_POST" if cfg.get("enabled") else "OFF"
                reason = (f"{to_post:g} accepted in ERP will be added to store stock" if cfg.get("enabled")
                          else "Auto-add from ERP is switched off")
            out.append({
                "part_id": pid, "part_no": part.part_no, "part_name": part.part_name,
                "grn_no": grn_no, "grn_date": grn_date.isoformat() if grn_date else None,
                "ven_cd": g.get("ven_cd"), "ven_name": g.get("ven_name"), "invoice_no": g.get("invoice_no"),
                "receipt_qty": round(g["receipt"], 2), "accept_qty": accepted, "reject_qty": rejected,
                "posted_qty": already, "to_post": to_post, "state": state, "reason": reason,
                "baseline_date": baseline.isoformat() if baseline else None,
            })
        out.sort(key=lambda x: (x["grn_date"] or "", x["grn_no"]), reverse=True)
        return out

    def mirror_freshness(self):
        """When the GRN mirror was last refreshed and its newest GRN date — shown
        with every figure, so stale ERP data is never read as current."""
        last_write, newest = db.session.query(
            func.max(ReceivingRegister.created_at), func.max(ReceivingRegister.grn_date)).one()
        return {"synced_at": last_write.isoformat() if last_write else None,
                "newest_grn_date": newest.isoformat() if newest else None}

    def preview(self, store_code):
        rows = self.lines(store_code)
        counts = defaultdict(int)
        for r in rows:
            counts[r["state"]] += 1
        return {"settings": self.settings(), "erp": self.mirror_freshness(),
                "counts": dict(counts), "rows": rows}

    # ---- writing ----

    def post(self, store_code, user=ERP_USER):
        """Add every WILL_POST line to store stock. Each (part, GRN) is its own
        transaction and re-checked inside it, so a concurrent run can't add the
        same GRN twice. Returns what was posted."""
        if not self.settings().get("enabled"):
            return {"posted": [], "skipped_off": True}
        done = []
        for line in self.lines(store_code):
            if line["state"] != "WILL_POST" or line["to_post"] <= 0:
                continue
            with atomic():
                already = self._posted([line["part_id"]]).get((line["part_id"], line["grn_no"]), 0.0)
                qty = round((line["accept_qty"] or 0) - already, 2)
                if qty <= 0:
                    continue
                stock_row = SpareStock.query.filter_by(part_id=line["part_id"]).first()
                if stock_row is None:
                    continue  # never counted — the rule above; re-checked here
                new_qty = round(float(stock_row.qty_on_hand or 0) + qty, 2)
                remarks = (f"ERP GRN {line['grn_no']} ({line['grn_date']}) — accepted by quality in ERP; "
                           f"read by the app's ERP sync")
                row, _ = self.stock._write(
                    line["part_id"], new_qty, "RECEIPT", reference=line["grn_no"],
                    remarks=remarks[:255], user=user,
                    extra={"status": STATUS, "invoice_no": line["invoice_no"]},
                )
                ledger = (SpareStockLedger.query
                          .filter_by(part_id=line["part_id"], txn_type="RECEIPT", status=STATUS,
                                     reference=line["grn_no"])
                          .order_by(SpareStockLedger.id.desc()).first())
                self.journal.record(
                    line["part_id"], "GRN", qty, store_code=store_code, user=user,
                    prev_status="QUALITY_PENDING", new_status="STOCK_AVAILABLE",
                    from_bucket="QUALITY_PENDING", to_bucket="AVAILABLE",
                    ledger_id=ledger.id if ledger else None,
                    supplier_name=line["ven_name"], ven_cd=line["ven_cd"], grn_no=line["grn_no"],
                    invoice_no=line["invoice_no"], remarks=remarks,
                )
            done.append({"part_id": line["part_id"], "part_no": line["part_no"],
                         "grn_no": line["grn_no"], "qty": qty})
        return {"posted": done, "skipped_off": False}
