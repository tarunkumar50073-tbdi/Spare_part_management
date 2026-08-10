"""Supplier Window Schedule data access layer."""
from datetime import time
from sqlalchemy import case
from app.models.supplier_window_schedule import SupplierWindowSchedule
from app.repositories.base_repository import BaseRepository

# The operational day's first vehicle arrives 08:30 and the last one runs
# past midnight (~02:00) — a plain time-of-day sort would put those
# post-midnight slots first, not last. Slots from SHIFT_START onward sort
# first (in their own order); anything before it (i.e. after midnight)
# sorts after all of those, still in time order — reconstructing the real
# "first vehicle to last vehicle" sequence instead of alphabetical-by-vendor.
SHIFT_START = time(8, 30)


class SupplierWindowScheduleRepository(BaseRepository):
    model = SupplierWindowSchedule

    def search(self, vendor_code=None, status=None):
        query = self.model.query
        if vendor_code:
            query = query.filter(self.model.vendor_code == vendor_code)
        if status:
            query = query.filter(self.model.status == status)
        day_order = case((self.model.window_start >= SHIFT_START, 0), else_=1)
        return query.order_by(day_order, self.model.window_start.asc())
