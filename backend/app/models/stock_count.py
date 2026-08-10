"""Daily physical stock count per part — replaces the manual Excel count.
Latest count per part is what COV Days is calculated against."""
from app.extensions import db
from app.models.base import BaseModel


class DailyStockCount(BaseModel):
    __tablename__ = "daily_stock_counts"

    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)
    count_date = db.Column(db.Date, nullable=False, index=True)
    counted_qty = db.Column(db.Numeric(12, 2), nullable=False)

    part = db.relationship("Part")

    __table_args__ = (
        db.UniqueConstraint("part_id", "count_date", name="uq_stock_count_part_date"),
    )

    def __repr__(self):
        return f"<DailyStockCount part={self.part_id} {self.count_date} qty={self.counted_qty}>"
