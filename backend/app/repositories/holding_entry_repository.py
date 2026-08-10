"""Holding Area data access layer."""
from app.models.holding_entry import HoldingEntry
from app.repositories.base_repository import BaseRepository


class HoldingEntryRepository(BaseRepository):
    model = HoldingEntry

    def search(self, status=None, part_id=None):
        query = self.model.query
        if status:
            query = query.filter(self.model.holding_status == status)
        if part_id:
            query = query.filter(self.model.part_id == part_id)
        return query.order_by(self.model.fifo_priority.asc().nulls_last(), self.model.holding_date.asc())

    def list_open_by_part(self, part_id):
        """Pending or partially-transferred entries for a part, oldest first — the FIFO queue."""
        return (
            self.model.query
            .filter(self.model.part_id == part_id, self.model.holding_status != "COMPLETED")
            .order_by(self.model.holding_date.asc())
            .all()
        )

    def has_open_for_part(self, part_id):
        return (
            self.model.query
            .filter(self.model.part_id == part_id, self.model.holding_status != "COMPLETED")
            .first() is not None
        )

    def list_all_open_parts(self):
        """Distinct part_ids with an open (non-COMPLETED) holding entry."""
        rows = self.model.query.filter(self.model.holding_status != "COMPLETED").with_entities(self.model.part_id).distinct().all()
        return [r[0] for r in rows]
