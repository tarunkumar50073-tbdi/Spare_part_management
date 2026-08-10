"""Physical Stock — the operator-uploaded physical count used purely for
ERP-vs-Physical reconciliation (see ERPGapService). Deliberately a separate
store from Daily Stock Count (which drives COV/Short/Excess), so uploading
or removing a reconciliation snapshot here never disturbs the COV basis.
One row per part; a new upload upserts, "Remove Physical Data" clears all."""
from app.extensions import db
from app.models.base import BaseModel


class PhysicalStock(BaseModel):
    __tablename__ = "physical_stock"

    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), unique=True, nullable=False, index=True)
    qty = db.Column(db.Numeric(14, 2), nullable=False, default=0)
    uploaded_at = db.Column(db.DateTime(timezone=True), nullable=False)

    part = db.relationship("Part")

    def __repr__(self):
        return f"<PhysicalStock part={self.part_id} qty={self.qty}>"
