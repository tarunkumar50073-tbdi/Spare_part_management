"""The spare traceability journal (spare_transactions) and document numbers.

Shared by the receipt, return, RGP, issue and scan-result services so every
business event lands in ONE append-only table with the spec 24 audit fields.
Rows are only ever inserted: the model refuses update/delete (AppendOnlyError,
models/spare_flow.py), and a mistake is corrected by a CANCEL row, never by
rewriting what happened.
"""
from datetime import datetime

from app.extensions import db
from app.models.spare_flow import BUCKETS, TXN_TYPES, SpareReceipt, SpareReturn, SpareRgp, SpareTransaction
from app.utils.db_tx import maybe_commit


def _f(v):
    return float(v) if v is not None else None


def _iso(v):
    return v.isoformat() if v is not None else None


class SpareJournalService:
    """Write and read journal rows; hand out document numbers."""

    # ---- writing ----

    def record(self, part_id, txn_type, qty=None, *, store_code=None, user=None,
               prev_status=None, new_status=None, from_bucket=None, to_bucket=None,
               receipt_id=None, return_id=None, rgp_id=None, issue_id=None, ledger_id=None,
               department=None, issued_to=None, employee_id=None, issued_to_mobile=None,
               issued_to_code=None, line_name=None, line_no=None, machine=None,
               die_no=None, supplier_name=None, ven_cd=None, rgp_no=None, grn_no=None,
               invoice_no=None, return_reason=None, inspection_result=None, remarks=None,
               scanned_code=None, scan_source=None):
        """Append one event. Call it inside the same atomic() as the document /
        stock change it describes, so the history and the state can't disagree."""
        if txn_type not in TXN_TYPES:
            raise ValueError(f"Unknown journal txn_type {txn_type!r}")
        for b in (from_bucket, to_bucket):
            if b is not None and b not in BUCKETS:
                raise ValueError(f"Unknown bucket {b!r}")
        row = SpareTransaction(
            part_id=part_id, store_code=store_code, txn_type=txn_type,
            qty=(round(float(qty), 2) if qty is not None else None),
            prev_status=prev_status, new_status=new_status,
            from_bucket=from_bucket, to_bucket=to_bucket,
            receipt_id=receipt_id, return_id=return_id, rgp_id=rgp_id,
            issue_id=issue_id, ledger_id=ledger_id,
            department=department, issued_to=issued_to, employee_id=employee_id,
            issued_to_mobile=issued_to_mobile, issued_to_code=issued_to_code, line_name=line_name,
            line_no=line_no, machine=machine, die_no=die_no,
            supplier_name=supplier_name, ven_cd=ven_cd, rgp_no=rgp_no, grn_no=grn_no,
            invoice_no=invoice_no, return_reason=return_reason,
            inspection_result=inspection_result,
            remarks=(remarks[:255] if remarks else remarks),
            scanned_code=(scanned_code[:80] if scanned_code else scanned_code),
            scan_source=scan_source, created_by=user,
        )
        db.session.add(row)
        maybe_commit()
        return row

    # ---- reading ----

    @staticmethod
    def to_dict(t):
        return {
            "id": t.id, "at": _iso(t.created_at), "part_id": t.part_id,
            "txn_type": t.txn_type, "qty": _f(t.qty),
            "prev_status": t.prev_status, "new_status": t.new_status,
            "from_bucket": t.from_bucket, "to_bucket": t.to_bucket,
            "receipt_id": t.receipt_id, "return_id": t.return_id, "rgp_id": t.rgp_id,
            "issue_id": t.issue_id, "ledger_id": t.ledger_id,
            "department": t.department, "issued_to": t.issued_to,
            "employee_id": t.employee_id, "issued_to_mobile": t.issued_to_mobile,
            "issued_to_code": t.issued_to_code,
            "line_name": t.line_name, "line_no": t.line_no, "machine": t.machine,
            "die_no": t.die_no, "supplier_name": t.supplier_name, "ven_cd": t.ven_cd,
            "rgp_no": t.rgp_no, "grn_no": t.grn_no, "invoice_no": t.invoice_no,
            "return_reason": t.return_reason, "inspection_result": t.inspection_result,
            "remarks": t.remarks, "scanned_code": t.scanned_code,
            "scan_source": t.scan_source, "user": t.created_by,
        }

    def list_for_part(self, part_id, limit=None):
        q = (SpareTransaction.query.filter_by(part_id=part_id)
             .order_by(SpareTransaction.created_at.desc(), SpareTransaction.id.desc()))
        if limit:
            q = q.limit(limit)
        return [self.to_dict(t) for t in q.all()]

    # ---- document numbers ----

    @staticmethod
    def _next_seq(prefix, *columns):
        """Highest number already used under `prefix` across the given columns,
        plus one — derived from the data, so a restart never reuses a number."""
        best = 0
        for col in columns:
            last = (db.session.query(col).filter(col.like(f"{prefix}%"))
                    .order_by(col.desc()).first())
            if last and last[0]:
                try:
                    best = max(best, int(str(last[0]).rsplit("-", 1)[1]))
                except (ValueError, IndexError):
                    pass
        return best + 1

    def next_receipt_no(self):
        prefix = f"RCV-{datetime.now():%Y%m%d}-"
        return f"{prefix}{self._next_seq(prefix, SpareReceipt.receipt_no):03d}"

    def next_return_no(self):
        """Same RET-YYYYMMDD-NNN series as the legacy ledger return slips, so a
        number is never issued twice across the old and new tables."""
        from app.models.spare_stock import SpareStockLedger
        prefix = f"RET-{datetime.now():%Y%m%d}-"
        seq = self._next_seq(prefix, SpareReturn.return_no, SpareStockLedger.return_no)
        return f"{prefix}{seq:03d}"

    def next_rgp_no(self):
        """RGP-YYYY-NNNNN (e.g. RGP-2026-00125), sequential within the year."""
        prefix = f"RGP-{datetime.now():%Y}-"
        return f"{prefix}{self._next_seq(prefix, SpareRgp.rgp_no):05d}"
