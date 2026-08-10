"""Holding Area: material that couldn't be placed into its assigned rack(s)
during Put Away (rack full/blocked, or the part's total assigned capacity
is smaller than the incoming quantity) lands here instead of being forced
into storage. FIFO is mandatory across a part's open holding entries —
see HoldingService.transfer_to_rack, which enforces `fifo_priority` order."""
from app.extensions import db
from app.models.base import BaseModel

HOLDING_REASONS = ["ASSIGNED_RACK_FULL", "OVERFLOW", "SUPERVISOR_HOLD"]
HOLDING_STATUSES = ["PENDING", "PARTIAL_TRANSFER", "COMPLETED"]


class HoldingEntry(BaseModel):
    __tablename__ = "holding_entries"

    srv_id = db.Column(db.Integer, db.ForeignKey("srvs.id"), nullable=False, index=True)
    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)
    invoice_no = db.Column(db.String(50), nullable=True)

    holding_qty = db.Column(db.Numeric(12, 2), nullable=False)  # original qty put into holding
    remaining_qty = db.Column(db.Numeric(12, 2), nullable=False)  # decremented by each (partial) transfer

    temporary_location = db.Column(db.String(30), nullable=False)
    assigned_rack_id = db.Column(db.Integer, db.ForeignKey("rack_bins.id"), nullable=True)

    holding_reason = db.Column(db.String(20), nullable=False)
    holding_status = db.Column(db.String(20), nullable=False, default="PENDING")

    holding_date = db.Column(db.DateTime(timezone=True), nullable=False)
    transfer_date = db.Column(db.DateTime(timezone=True), nullable=True)  # most recent transfer, if any

    # FIFO Priority — 1 = oldest, recomputed across a part's open entries
    # whenever one is created or completed (HoldingService._renumber_fifo).
    fifo_priority = db.Column(db.Integer, nullable=True)

    remarks = db.Column(db.String(255), nullable=True)

    srv = db.relationship("SRV")
    part = db.relationship("Part")
    assigned_rack = db.relationship("RackBin")

    __table_args__ = (
        db.CheckConstraint(f"holding_reason IN ({','.join(repr(r) for r in HOLDING_REASONS)})", name="ck_holding_reason"),
        db.CheckConstraint(f"holding_status IN ({','.join(repr(s) for s in HOLDING_STATUSES)})", name="ck_holding_status"),
    )

    def __repr__(self):
        return f"<HoldingEntry part={self.part_id} remaining={self.remaining_qty} {self.holding_status}>"
