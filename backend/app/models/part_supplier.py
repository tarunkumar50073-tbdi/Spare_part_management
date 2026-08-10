"""Part x Supplier breakdown — for parts genuinely sourced from more than
one approved supplier at once (e.g. dual-sourced Import parts). `Part.
supplier_id` stays the single "primary" supplier used everywhere else in
the app (Live Stock, tables, exports); this table is a purely additive
attribution layer showing how a part's current stock splits across its
known suppliers, for display only.

Never create a distinct Part row per supplier for this — Part.part_no must
always match the real ERP part number exactly, since gate-entry/stock-sync
match on that string. See the Import Parts load notes for why."""
from app.extensions import db
from app.models.base import BaseModel


class PartSupplier(BaseModel):
    __tablename__ = "part_suppliers"

    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)
    supplier_id = db.Column(db.Integer, db.ForeignKey("suppliers.id"), nullable=False)
    qty = db.Column(db.Numeric(14, 2), nullable=True)  # this supplier's share of current stock, if known
    share_pct = db.Column(db.Numeric(5, 2), nullable=True)  # SOB % from the supplier planning sheet, if known — a ratio, never merged into qty

    part = db.relationship("Part", backref="supplier_sources")
    supplier = db.relationship("Supplier")

    __table_args__ = (
        db.UniqueConstraint("part_id", "supplier_id", name="uq_part_supplier"),
    )

    def __repr__(self):
        return f"<PartSupplier part={self.part_id} supplier={self.supplier_id} qty={self.qty}>"
