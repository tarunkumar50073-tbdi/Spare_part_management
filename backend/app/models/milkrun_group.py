"""Milkrun grouping: material from multiple suppliers arrives together in
one shared vehicle, grouped under a single named route (e.g. "Milkrun
Manesar" carries 3 suppliers' material, "Milkrun Faridabad" carries 4 —
each its own separate vehicle/route, confirmed by the user). A supplier
belongs to at most one milkrun group; suppliers not in any group are
delivered individually (their own dedicated vehicle)."""
from app.extensions import db
from app.models.base import BaseModel


class MilkrunGroup(BaseModel):
    __tablename__ = "milkrun_groups"

    group_code = db.Column(db.String(20), unique=True, nullable=False)
    group_name = db.Column(db.String(100), unique=True, nullable=False)
    window_start = db.Column(db.Time, nullable=True)
    window_end = db.Column(db.Time, nullable=True)
    status = db.Column(db.String(10), nullable=False, default="Active")

    __table_args__ = (
        db.CheckConstraint("status IN ('Active','Inactive')", name="ck_milkrun_group_status"),
    )

    def __repr__(self):
        return f"<MilkrunGroup {self.group_code} {self.group_name}>"


class SupplierMilkrunMapping(BaseModel):
    """vendor_code -> milkrun_group static mapping — fixed which suppliers
    share which route's vehicle, independent of any specific day's trip."""
    __tablename__ = "supplier_milkrun_mapping"

    vendor_code = db.Column(
        db.String(20), db.ForeignKey("suppliers.vendor_code"), unique=True, nullable=False, index=True,
    )
    milkrun_group_id = db.Column(
        db.Integer, db.ForeignKey("milkrun_groups.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    status = db.Column(db.String(10), nullable=False, default="Active")

    milkrun_group = db.relationship("MilkrunGroup", backref="supplier_mappings")

    __table_args__ = (
        db.CheckConstraint("status IN ('Active','Inactive')", name="ck_supplier_milkrun_mapping_status"),
    )

    def __repr__(self):
        return f"<SupplierMilkrunMapping {self.vendor_code} -> group_id={self.milkrun_group_id}>"
