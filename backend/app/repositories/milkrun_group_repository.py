"""Milkrun grouping data access layer."""
from app.models.milkrun_group import MilkrunGroup, SupplierMilkrunMapping
from app.repositories.base_repository import BaseRepository


class MilkrunGroupRepository(BaseRepository):
    model = MilkrunGroup

    def list_all(self, status=None):
        query = self.model.query
        if status:
            query = query.filter(self.model.status == status)
        return query.order_by(self.model.group_name.asc()).all()


class SupplierMilkrunMappingRepository(BaseRepository):
    model = SupplierMilkrunMapping

    def list_by_group(self, group_id):
        return self.model.query.filter_by(milkrun_group_id=group_id).all()

    def map_by_vendor_code(self):
        """{vendor_code: SupplierMilkrunMapping} in one query — batched, so
        callers enriching many supplier rows don't query per row."""
        return {m.vendor_code: m for m in self.model.query.all()}

    def get_by_vendor_code(self, vendor_code):
        return self.model.query.filter_by(vendor_code=vendor_code).first()
