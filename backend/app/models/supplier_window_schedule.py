"""Standard Supplier Window Schedule — a recurring daily/alternate-day/
weekly delivery time slot per supplier (e.g. "SAR Coating LLP-Bawal,
08:30-10:00, Daily"), fixed for a month/period rather than entered per
vehicle per date. Distinct from SupplierVehicleWindow (that model is a
one-off window for one specific vehicle_no on one specific expected_date).
A supplier can have more than one row here — several suppliers run
multiple slots a day (e.g. SAR Coating has 8 separate daily slots)."""
from app.extensions import db
from app.models.base import BaseModel

FREQUENCIES = ["Daily", "Alternate Day", "Weekly"]


class SupplierWindowSchedule(BaseModel):
    __tablename__ = "supplier_window_schedules"

    vendor_code = db.Column(db.String(20), db.ForeignKey("suppliers.vendor_code"), nullable=False, index=True)
    window_start = db.Column(db.Time, nullable=False)
    window_end = db.Column(db.Time, nullable=False)
    frequency = db.Column(db.String(20), nullable=False, default="Daily")
    effective_from = db.Column(db.Date, nullable=False)
    status = db.Column(db.String(10), nullable=False, default="Active")

    supplier = db.relationship("Supplier")

    __table_args__ = (
        db.CheckConstraint(f"frequency IN ({','.join(repr(f) for f in FREQUENCIES)})", name="ck_window_schedule_frequency"),
        db.CheckConstraint("status IN ('Active','Inactive')", name="ck_window_schedule_status"),
    )

    def __repr__(self):
        return f"<SupplierWindowSchedule {self.vendor_code} {self.window_start}-{self.window_end} {self.frequency}>"
