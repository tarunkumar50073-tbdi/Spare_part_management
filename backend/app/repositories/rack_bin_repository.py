"""Rack/Bin master data access layer."""
from sqlalchemy import func
from sqlalchemy.orm import joinedload
from app.extensions import db
from app.models.rack_bin import RackBin, DEAD_STOCK_LOCATION
from app.repositories.base_repository import BaseRepository


class RackBinRepository(BaseRepository):
    model = RackBin

    def list_all(self):
        return (
            self.model.query.options(joinedload(self.model.part))
            .order_by(self.model.location.asc(), self.model.rack_no.asc()).all()
        )

    def list_by_part(self, part_id):
        return self.model.query.filter_by(part_id=part_id).all()

    def get_total_capacity_by_part(self):
        """Rack Capacity per part = sum(bin_capacity x bins_allocated) across
        every rack/bin entry for that part — the "Rack Capacity" figure the
        Excess Parts KPI compares live stock against."""
        rows = (
            db.session.query(
                self.model.part_id,
                func.sum(self.model.bin_capacity * self.model.bins_allocated).label("capacity"),
            ).group_by(self.model.part_id).all()
        )
        return {row.part_id: float(row.capacity or 0) for row in rows}

    def get_dead_stock_part_ids(self):
        """Part ids racked at the Mezzanine (slow-moving/non-moving
        overflow) location — see DEAD_STOCK_LOCATION."""
        rows = self.model.query.filter(self.model.location == DEAD_STOCK_LOCATION).with_entities(self.model.part_id).all()
        return {row.part_id for row in rows}
