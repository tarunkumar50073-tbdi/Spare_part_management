"""ERP-synced stock cache data access layer."""
from app.extensions import db
from app.models.erp_stock import ERPStock
from app.repositories.base_repository import BaseRepository
from app.utils.db_tx import maybe_commit


class ERPStockRepository(BaseRepository):
    model = ERPStock

    def upsert(self, part_id, qty_on_hand, synced_at):
        row = self.model.query.filter_by(part_id=part_id).first()
        if row:
            row.qty_on_hand = qty_on_hand
            row.synced_at = synced_at
        else:
            row = self.model(part_id=part_id, qty_on_hand=qty_on_hand, synced_at=synced_at)
            db.session.add(row)
        maybe_commit()
        return row

    def list_all(self):
        return self.model.query.all()

    def get_by_part(self, part_id):
        return self.model.query.filter_by(part_id=part_id).first()
