"""Daily physical stock count data access layer."""
from app.extensions import db
from app.models.stock_count import DailyStockCount
from app.repositories.base_repository import BaseRepository
from app.utils.db_tx import maybe_commit


class StockCountRepository(BaseRepository):
    model = DailyStockCount

    def upsert(self, part_id, count_date, counted_qty):
        row = self.model.query.filter_by(part_id=part_id, count_date=count_date).first()
        if row:
            row.counted_qty = counted_qty
        else:
            row = self.model(part_id=part_id, count_date=count_date, counted_qty=counted_qty)
            db.session.add(row)
        return row

    def get_latest_by_part(self, part_id):
        return (
            self.model.query.filter_by(part_id=part_id)
            .order_by(self.model.count_date.desc())
            .first()
        )

    def latest_by_part_map(self):
        """Latest count per part_id, as {part_id: DailyStockCount}."""
        latest = {}
        for row in self.model.query.order_by(self.model.count_date.asc()).all():
            latest[row.part_id] = row
        return latest

    def list_by_date(self, count_date):
        return self.model.query.filter_by(count_date=count_date).all()

    def delete_by_date(self, count_date):
        """Bulk-clear a day's physical counts (Remove Physical Data on the
        ERP-vs-Physical Gap screen). Returns how many rows were removed."""
        n = self.model.query.filter_by(count_date=count_date).delete()
        maybe_commit()
        return n
