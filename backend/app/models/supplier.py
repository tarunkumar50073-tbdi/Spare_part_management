"""Supplier (Vendor) master model."""
from app.extensions import db
from app.models.base import BaseModel


class Supplier(BaseModel):
    __tablename__ = "suppliers"

    vendor_code = db.Column(db.String(20), unique=True, nullable=False, index=True)
    supplier_name = db.Column(db.String(150), nullable=False)
    status = db.Column(db.String(10), nullable=False, default="Active")  # Active / Inactive

    # Scopes Vehicle Management (Supplier Window Schedule + ad-hoc Supplier
    # Vehicle Management) to BOP/Import suppliers only — Purchase/Tool Room/
    # Consumable suppliers must never appear there, even after their parts
    # get added to the Part master later. Only gates which suppliers can be
    # newly selected in those Add forms; does not retroactively hide any
    # already-existing schedule/window rows for an untracked supplier.
    vehicle_tracking_enabled = db.Column(db.Boolean, nullable=False, default=False)

    __table_args__ = (
        db.CheckConstraint("status IN ('Active','Inactive')", name="ck_supplier_status"),
    )

    def __repr__(self):
        return f"<Supplier {self.vendor_code} {self.supplier_name}>"
