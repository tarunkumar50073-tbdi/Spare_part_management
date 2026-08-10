"""ERP-synced live stock cache — inbound push from ERP (POST
/api/v1/erp/stock-sync). ERP is the master inventory; this table is what
Dashboard/Store Stock/Reports read for "Available Store Stock" once ERP has
synced a part. Falls back to the internally-computed PartStock sum for any
part ERP hasn't synced yet (same mock-now/real-later shape as ERPClient) —
PartStock/StockLedger are kept as-is for DX-side transactional audit trail,
not replaced."""
from app.extensions import db
from app.models.base import BaseModel


class ERPStock(BaseModel):
    __tablename__ = "erp_stock"

    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), unique=True, nullable=False, index=True)
    qty_on_hand = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    synced_at = db.Column(db.DateTime(timezone=True), nullable=False)

    part = db.relationship("Part")

    def __repr__(self):
        return f"<ERPStock part={self.part_id} qty={self.qty_on_hand}>"
