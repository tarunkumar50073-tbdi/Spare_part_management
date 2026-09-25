"""One spare, everything about it, in one response — the part drawer.

PART · STOCK · LOCATION · CONSUMPTION · ERP · SUPPLIERS · TRANSACTIONS · ALERTS

Built only from recorded data. What the store does not track is returned as
None with the reason (e.g. reserved quantity), never as a confident zero; a
consumption window reads "since the ledger began" rather than pretending to
history the app does not have.
"""
from datetime import datetime, timedelta, timezone

from sqlalchemy import func

from app.extensions import db
from app.models.base import utcnow
from app.models.spare_stock import SpareStockLedger
from app.models.store import Section
from app.repositories.part_repository import PartRepository
from app.services.spare_dashboard_service import STALE_AFTER_HOURS
from app.services.spare_flow_service import SpareFlowService
from app.services.spare_stock_service import SpareStockService
from app.utils.exceptions import NotFoundError

COUNT_AGE_ALERT_DAYS = 90


def _naive(dt):
    """UTC, without tzinfo — how SQLite hands created_at back, so the windows
    below compare like with like."""
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).replace(tzinfo=None) if dt.tzinfo else dt


def _month_key(d):
    return f"{d.year:04d}-{d.month:02d}"


def _months_back(ref, n):
    """The last n calendar months ending with ref's month, oldest first."""
    y, m = ref.year, ref.month
    out = []
    for _ in range(n):
        out.append(f"{y:04d}-{m:02d}")
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return list(reversed(out))


class SparePartOverviewService:
    def __init__(self):
        self.stock = SpareStockService()
        self.flow = SpareFlowService()
        self.parts = PartRepository()

    def overview(self, part_id):
        part = self.parts.get_by_id(part_id)
        if not part:
            raise NotFoundError(f"Part {part_id} not found")
        row = self.stock.get_for_part(part_id)
        section = db.session.get(Section, part.section_id) if part.section_id else None
        arrivals, suppliers = self.flow._gate_history(part.part_no)
        consumption = self._consumption(part_id)
        erp = self._erp(part_id, row["qty_on_hand"])
        label = self._label(part)
        pending_confirm = len(self.stock.pending_confirmations_for_part(part_id))

        return {
            "part": {
                "id": part.id, "part_no": part.part_no, "part_name": part.part_name,
                "uom": part.uom, "category": part.category, "type": part.sub_category,
                "old_part_no": part.old_part_no, "new_part_no": part.new_part_no,
                "unit_price": row["unit_price"], "is_active": part.is_active,
                # No specification field exists on the part master yet.
                "specification": None,
            },
            "stock": {
                "qty_on_hand": row["qty_on_hand"], "status": row["status"],
                "min": row["min_stock_level"], "reorder": row["reorder_level"],
                "max": row["max_stock_level"], "shortfall": row["shortfall"],
                "stock_value": row["stock_value"], "last_counted_at": row["last_counted_at"],
                # Nothing reserves stock against a job in this store — so there is
                # no "reserved" figure to show, and "available" is simply on hand.
                "reserved": None, "reserved_note": "Reservations are not tracked",
                "available": row["qty_on_hand"],
            },
            "location": {
                "section": section.name if section else None, "section_id": part.section_id,
                "location": part.location, "rework_location": part.rework_location,
            },
            "consumption": consumption,
            "erp": erp,
            "suppliers": suppliers[:5],
            "arrivals": arrivals[:5],
            "transactions": self.stock.history_for_part(part_id, limit=15),
            "label": label,
            "alerts": self._alerts(row, part, label, pending_confirm, consumption),
            "pending_confirmations": pending_confirm,
        }

    # ------------------------------------------------------------------ parts

    def _consumption(self, part_id):
        """Issued quantity in the windows a planner asks about, from this part's
        own ISSUE rows (bucketed in Python — portable, and one part has few)."""
        rows = [(_naive(at), q) for at, q in
                (db.session.query(SpareStockLedger.created_at, SpareStockLedger.qty_delta)
                 .filter(SpareStockLedger.part_id == part_id, SpareStockLedger.txn_type == "ISSUE")
                 .all())]
        ledger_start = db.session.query(func.min(SpareStockLedger.created_at)).scalar()
        now = _naive(utcnow())
        shift_start = _naive(self.stock._today_shift_start()[0])
        week_start = now - timedelta(days=7)
        month_start = datetime(now.year, now.month, 1)
        prev_end = month_start
        prev_start = datetime(now.year - (now.month == 1), (now.month - 2) % 12 + 1, 1)

        def total(since, until=None):
            return round(sum(-float(q) for at, q in rows
                             if at >= since and (until is None or at < until)), 2)

        months = _months_back(now, 12)
        by_month = {m: 0.0 for m in months}
        for at, q in rows:
            k = _month_key(at)
            if k in by_month:
                by_month[k] += -float(q)
        last_issue = max((at for at, _ in rows), default=None)
        return {
            "today": total(shift_start),
            "week": total(week_start),
            "month": total(month_start),
            "previous_month": total(prev_start, prev_end),
            "trend": [{"month": m, "qty": round(v, 2)} for m, v in by_month.items()],
            "issues": len(rows),
            "last_issue_at": last_issue.isoformat() if last_issue else None,
            # The app's stock ledger only goes back this far — say so, instead of
            # letting an empty trend read as "never used".
            "ledger_since": ledger_start.isoformat() if ledger_start else None,
        }

    @staticmethod
    def _erp(part_id, physical):
        from app.models.erp_stock import ERPStock
        rec = ERPStock.query.filter_by(part_id=part_id).first()
        if rec is None:
            return {"state": "NONE", "erp_qty": None, "physical_qty": physical, "difference": None,
                    "synced_at": None, "age_hours": None}
        synced = rec.synced_at
        age_h = None
        if synced is not None:
            ref = synced if synced.tzinfo else synced.replace(tzinfo=timezone.utc)
            age_h = round((datetime.now(timezone.utc) - ref).total_seconds() / 3600, 1)
        erp_qty = float(rec.qty_on_hand) if rec.qty_on_hand is not None else None
        return {
            "state": "STALE" if age_h is not None and age_h > STALE_AFTER_HOURS else "SYNCED",
            "erp_qty": erp_qty, "physical_qty": physical,
            "difference": (round(physical - erp_qty, 2)
                           if physical is not None and erp_qty is not None else None),
            "synced_at": synced.isoformat() if synced else None, "age_hours": age_h,
        }

    @staticmethod
    def _label(part):
        from app.models.label_print_audit import LabelPrintAudit
        from app.models.part_barcode import PartBarcode
        printed = (db.session.query(func.count(LabelPrintAudit.id))
                   .filter(LabelPrintAudit.part_id == part.id).scalar()) or 0
        mapped = db.session.query(func.count(PartBarcode.id)).filter(PartBarcode.part_id == part.id).scalar()
        return {"barcode": part.barcode, "mapped_barcodes": mapped or 0,
                "labels_printed": printed}

    @staticmethod
    def _alerts(row, part, label, pending_confirm, consumption):
        alerts = []

        def add(severity, label_, detail):
            alerts.append({"severity": severity, "label": label_, "detail": detail})

        st = row["status"]
        if st == "Out of Stock":
            add("critical", "Zero stock", "Counted and found empty — nothing to issue")
        elif st == "Below Minimum":
            add("critical", "Below minimum", f"{row['qty_on_hand']:g} on hand against a minimum of {row['min_stock_level']:g}")
        elif st == "Reorder":
            add("warning", "At reorder level", "At or below the reorder point — raise the PO")
        elif st == "Above Maximum":
            over = row["qty_on_hand"] - (row["max_stock_level"] or 0)
            add("warning", "Excess", f"{over:g} above the maximum of {row['max_stock_level']:g}")
        elif st == "Not Counted":
            add("info", "Never counted", "No physical count recorded — its status is unknown")
        if pending_confirm:
            add("warning", "Awaiting confirmation",
                f"{pending_confirm} issue(s) not yet confirmed by the user (machine / line)")
        if row["last_counted_at"]:
            counted = _naive(datetime.fromisoformat(row["last_counted_at"]))
            days = (_naive(utcnow()) - counted).days
            if days > COUNT_AGE_ALERT_DAYS:
                add("info", "Count is old", f"Last counted {days} days ago")
        if not row["max_stock_level"]:
            add("info", "No maximum set", "Nothing to reorder against until a maximum is set")
        if row["unit_price"] is None:
            add("info", "No rate", "Cannot be valued until a rate is entered")
        if not (part.location or "").strip():
            add("info", "No location", "Nobody can be told where to find it")
        if label["labels_printed"] == 0:
            add("info", "No barcode label", "Print a label so it can be scanned")
        return alerts
