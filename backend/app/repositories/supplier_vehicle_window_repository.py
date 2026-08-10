"""Supplier Vehicle Window data access layer."""
from app.models.supplier_vehicle_window import SupplierVehicleWindow
from app.repositories.base_repository import BaseRepository


class SupplierVehicleWindowRepository(BaseRepository):
    model = SupplierVehicleWindow

    def search(self, vendor_code=None, expected_date=None):
        query = self.model.query
        if vendor_code:
            query = query.filter(self.model.vendor_code == vendor_code)
        if expected_date:
            query = query.filter(self.model.expected_date == expected_date)
        return query.order_by(self.model.expected_date.desc(), self.model.window_start.asc())
