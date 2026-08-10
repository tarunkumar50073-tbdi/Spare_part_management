"""In-house Production Receipt data access layer."""
from app.models.production_receipt import ProductionReceipt
from app.repositories.base_repository import BaseRepository


class ProductionReceiptRepository(BaseRepository):
    model = ProductionReceipt

    def search(self, part_id=None):
        query = self.model.query
        if part_id:
            query = query.filter(self.model.part_id == part_id)
        return query.order_by(self.model.produced_at.desc())
