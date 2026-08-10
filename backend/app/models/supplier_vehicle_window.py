"""Supplier Vehicle Management — the delivery time window is decided and
entered manually in Part Store (this is a store-floor planning action, same
category as Rack/Bin Master entries); the actual arrival time comes from
ERP's own gate-entry push (SRV.gate_entry_time, see SRVService.
ingest_gate_entry) and is matched in at read time, not stored here — so a
correction to a gate entry's time on the ERP side is reflected immediately
without needing to touch this table."""
from app.extensions import db
from app.models.base import BaseModel


class SupplierVehicleWindow(BaseModel):
    __tablename__ = "supplier_vehicle_windows"

    vendor_code = db.Column(db.String(20), db.ForeignKey("suppliers.vendor_code"), nullable=False, index=True)
    vehicle_no = db.Column(db.String(20), nullable=False, index=True)
    expected_date = db.Column(db.Date, nullable=False, index=True)
    # Nullable: an ad-hoc vehicle (outside the standard window schedule) can
    # have no decided time at all — logged for count/tracking purposes only,
    # with no On-Time/Early/Late judgement possible. See
    # SupplierVehicleService._enrich().
    window_start = db.Column(db.DateTime(timezone=True), nullable=True)
    window_end = db.Column(db.DateTime(timezone=True), nullable=True)
    notes = db.Column(db.String(200), nullable=True)

    supplier = db.relationship("Supplier")

    def __repr__(self):
        return f"<SupplierVehicleWindow {self.vendor_code}/{self.vehicle_no} {self.expected_date}>"
