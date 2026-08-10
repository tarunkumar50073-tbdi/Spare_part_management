"""Supplier master data access layer."""
from app.models.supplier import Supplier
from app.repositories.base_repository import BaseRepository


class SupplierRepository(BaseRepository):
    model = Supplier

    def get_by_vendor_code(self, vendor_code):
        return self.model.query.filter_by(vendor_code=vendor_code).first()

    def search(self, keyword=None, status=None, vehicle_tracking=None):
        query = self.model.query
        if keyword:
            like = f"%{keyword}%"
            query = query.filter(
                (self.model.vendor_code.ilike(like)) | (self.model.supplier_name.ilike(like))
            )
        if status:
            query = query.filter(self.model.status == status)
        if vehicle_tracking is not None:
            query = query.filter(self.model.vehicle_tracking_enabled == vehicle_tracking)
        return query.order_by(self.model.vendor_code.asc())

    def get_active_suppliers(self):
        return self.model.query.filter_by(status="Active").all()
