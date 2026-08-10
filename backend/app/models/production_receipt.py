"""In-house Production Receipt — inbound push from ERP's own Production
Punch event (the same event that already confirms BOM-child consumption in
SRV.confirm_consumption, but here it's the finished-good output side: a raw
material like CTL pipe gets consumed on the shop floor and the resulting
finished part_no's stock is added into Store Stock). Same part_no as any
BOP-purchased unit of that part — Part.part_no stays a single identifier;
this table exists only to tag *that specific receipt* as in-house-made so
the Source Breakdown view (see StockLedger.source_type) can tell it apart
from a purchased (SRV) receipt."""
from app.extensions import db
from app.models.base import BaseModel


class ProductionReceipt(BaseModel):
    __tablename__ = "production_receipts"

    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)
    qty_produced = db.Column(db.Numeric(12, 2), nullable=False)
    produced_at = db.Column(db.DateTime(timezone=True), nullable=False)
    production_order_no = db.Column(db.String(30), nullable=True)  # ERP's own production/work-order punch reference

    part = db.relationship("Part")

    def __repr__(self):
        return f"<ProductionReceipt part={self.part_id} qty={self.qty_produced}>"
