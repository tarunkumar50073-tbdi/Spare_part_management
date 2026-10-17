"""Kiosk part-request + its issuance link (QR-based issuance flow).

The spare store is locked; a requester uses the kiosk OUTSIDE the store to ask
for a part (employee + department + part + qty). The request lands here as
PENDING and shows on the supervisor's screen. The supervisor scans the bin's
location QR (Right/Wrong check), verifies the part and the ACTUAL quantity, and
confirms.

The real stock deduction + transaction is done by the existing
SpareStockService.issue (never re-implemented here), so there is no double
deduction; this row only tracks the request and links to that issue ledger row.
A request is PENDING until the supervisor issues it, which CLOSES it in one step
(ISSUED) — if stock was short, issued_qty < requested_qty records the shortfall.
There is no partial / keep-open: PROCESSING and PARTIALLY_ISSUED are reserved
(kept in the enum) but not used by the current flow.
"""
from app.extensions import db
from app.models.base import BaseModel

# PROCESSING / PARTIALLY_ISSUED are reserved (unused today); the live flow only
# produces PENDING -> ISSUED (or CANCELLED). Kept in the enum + CHECK so the
# values stay valid if a future flow needs them.
PART_REQUEST_STATUSES = ("PENDING", "PROCESSING", "PARTIALLY_ISSUED", "ISSUED", "CANCELLED")


class PartRequest(BaseModel):
    __tablename__ = "part_requests"

    # Human reference shown to requester + supervisor (REQ-YYYYMMDD-NNNNN).
    reference_no = db.Column(db.String(30), unique=True, index=True, nullable=True)
    store_code = db.Column(db.String(30), nullable=True, index=True)

    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)
    part_no = db.Column(db.String(30), nullable=True)
    part_name = db.Column(db.String(150), nullable=True)         # description snapshot
    assigned_location = db.Column(db.String(40), nullable=True)  # part.location snapshot

    requested_qty = db.Column(db.Numeric(12, 2), nullable=False)
    issued_qty = db.Column(db.Numeric(12, 2), nullable=False, default=0)

    # Requester, from the Employee master (free-text fallback allowed).
    employee_id = db.Column(db.Integer, db.ForeignKey("employees.id"), nullable=True, index=True)
    requester_name = db.Column(db.String(120), nullable=True)
    requester_code = db.Column(db.String(60), nullable=True)
    requester_mobile = db.Column(db.String(20), nullable=True)
    department = db.Column(db.String(40), nullable=True)

    status = db.Column(db.String(20), nullable=False, default="PENDING", index=True)
    scanned_location = db.Column(db.String(40), nullable=True)
    # The last issue ledger row this request produced (the issue document id).
    issue_ledger_id = db.Column(db.Integer, db.ForeignKey("spare_stock_ledger.id"), nullable=True)
    supervisor = db.Column(db.String(60), nullable=True)
    issued_at = db.Column(db.DateTime(timezone=True), nullable=True)
    remarks = db.Column(db.String(255), nullable=True)
    # Idempotency guard against a double "Confirm Issue" click.
    last_issue_token = db.Column(db.String(64), nullable=True)

    part = db.relationship("Part")
    employee = db.relationship("Employee")

    __table_args__ = (
        db.CheckConstraint(
            "status in ('PENDING','PROCESSING','PARTIALLY_ISSUED','ISSUED','CANCELLED')",
            name="ck_part_request_status",
        ),
    )

    def __repr__(self):
        return f"<PartRequest {self.reference_no} {self.part_no} {self.status}>"
