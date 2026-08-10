"""Physical Stock (ERP-vs-Physical reconciliation) data access layer."""
from app.extensions import db
from app.models.physical_stock import PhysicalStock
from app.repositories.base_repository import BaseRepository
from app.utils.db_tx import maybe_commit


class PhysicalStockRepository(BaseRepository):
    model = PhysicalStock

    def upsert(self, part_id, qty, uploaded_at):
        row = self.model.query.filter_by(part_id=part_id).first()
        if row:
            row.qty = qty
            row.uploaded_at = uploaded_at
        else:
            row = self.model(part_id=part_id, qty=qty, uploaded_at=uploaded_at)
            db.session.add(row)
        maybe_commit()
        return row

    def map_by_part(self):
        """{part_id: PhysicalStock} for all uploaded rows in one query."""
        return {r.part_id: r for r in self.model.query.all()}

    def clear_all(self):
        n = self.model.query.delete()
        maybe_commit()
        return n
