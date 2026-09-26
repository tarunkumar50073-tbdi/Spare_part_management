"""Supplier receiving for the Spare Parts Store — read from ERP, not recorded here.

Receiving, the GRN and the Maintenance / Tool Room quality clearance are done in
ERP (user decision 2026-09-26). The app READS them from the ERP GRN register
(ErpGrnPostingService): a GRN line whose quality ERP accepted becomes store
stock once, and the part's receiving history is built from ERP's gate entries
and GRN lines. Nothing is received, GRN'd or quality-cleared by hand any more:
every manual receiving write answers 410 Gone with RECEIVING_IN_ERP, so an old
screen or script is told plainly where the step went instead of silently doing
nothing.

What stays is the history of the receipts the store recorded in the app before
that change (spare_receipts): readable as recorded, never moved on.
"""
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import joinedload

from app.extensions import db
from app.models.part import Part
from app.models.spare_flow import RECEIPT_OPEN, RECEIPT_STATUSES, SpareReceipt
from app.utils.exceptions import AppException, BadRequestError

RECEIVING_IN_ERP = "Receiving, GRN and quality clearance are done in ERP — the app reads them from ERP"


class ReceivingInErpError(AppException):
    """410 Gone: the manual receiving step no longer exists in the app."""
    status_code = 410
    message = RECEIVING_IN_ERP


def _f(v):
    return float(v) if v is not None else None


def _iso(v):
    return v.isoformat() if v is not None else None


def _age_days(ts):
    """Whole days since a stored UTC timestamp, on the plant clock — the same
    footing the receiving monitor ages its rows on."""
    if ts is None:
        return None
    if ts.tzinfo is not None:
        ts = ts.astimezone(timezone.utc).replace(tzinfo=None)
    offset = datetime.now().astimezone().utcoffset() or timedelta(0)
    return max((datetime.now().date() - (ts + offset).date()).days, 0)


class SpareReceiptService:
    """The receipts recorded in the app before receiving moved to ERP — read only."""

    @staticmethod
    def get(receipt_id):
        return db.session.get(SpareReceipt, receipt_id)

    @staticmethod
    def to_dict(r):
        part = r.part
        return {
            "id": r.id, "receipt_no": r.receipt_no, "status": r.status,
            "part_id": r.part_id,
            "part_no": part.part_no if part else None,
            "part_name": part.part_name if part else None,
            "uom": part.uom if part else None,
            "store_code": r.store_code,
            "qty_received": _f(r.qty_received),
            "qty_accepted": _f(r.qty_accepted),
            "qty_rejected": _f(r.qty_rejected),
            "supplier_id": r.supplier_id,
            "supplier_master_name": r.supplier.supplier_name if r.supplier else None,
            "ven_cd": r.ven_cd, "ven_name": r.ven_name, "supplier_source": r.supplier_source,
            "invoice_no": r.invoice_no, "invoice_date": _iso(r.invoice_date),
            "check_result": r.check_result, "received_by": r.received_by, "remarks": r.remarks,
            "grn_no": r.grn_no, "grn_date": _iso(r.grn_date),
            "grn_recorded_by": r.grn_recorded_by, "grn_recorded_at": _iso(r.grn_recorded_at),
            "quality_by": r.quality_by,
            "cleared_by": r.cleared_by, "cleared_at": _iso(r.cleared_at),
            "quality_remarks": r.quality_remarks, "ledger_id": r.ledger_id,
            "scanned_code": r.scanned_code, "scan_source": r.scan_source,
            "cancelled_by": r.cancelled_by, "cancelled_at": _iso(r.cancelled_at),
            "cancel_reason": r.cancel_reason,
            "created_at": _iso(r.created_at), "updated_at": _iso(r.updated_at),
            # Days since the material was received — how long it has been
            # waiting while open, or how long the flow took once closed.
            "age_days": _age_days(r.created_at),
        }

    def list(self, store_code, status=None, limit=None):
        """A store's in-app receipts, newest first. `status` is one status, a
        comma-separated list, or OPEN (received + quality pending)."""
        q = (SpareReceipt.query.options(joinedload(SpareReceipt.part), joinedload(SpareReceipt.supplier))
             .join(Part, Part.id == SpareReceipt.part_id)
             .filter(Part.store_code == store_code))
        statuses = self._statuses(status)
        if statuses:
            q = q.filter(SpareReceipt.status.in_(statuses))
        q = q.order_by(SpareReceipt.created_at.desc(), SpareReceipt.id.desc())
        if limit:
            q = q.limit(limit)
        return [self.to_dict(r) for r in q.all()]

    @staticmethod
    def _statuses(status):
        status = (str(status).strip() if status is not None else "") or None
        if not status:
            return None
        if status.upper() == "OPEN":
            return list(RECEIPT_OPEN)
        wanted = [s.strip().upper() for s in status.split(",") if s.strip()]
        unknown = [s for s in wanted if s not in RECEIPT_STATUSES]
        if unknown:
            raise BadRequestError(
                f"Unknown receipt status {', '.join(unknown)} — use OPEN or {', '.join(RECEIPT_STATUSES)}")
        return wanted
