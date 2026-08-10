"""Customer forecast data access layer, plus the BOM-explosion query that
turns Finished-Good forecast rows into a per-child-part daily requirement
series (used to find the peak)."""
from sqlalchemy import func
from app.extensions import db
from app.models.forecast import CustomerForecast
from app.models.bom import BOM
from app.repositories.base_repository import BaseRepository


class ForecastRepository(BaseRepository):
    model = CustomerForecast

    def upsert(self, finished_good_id, forecast_date, qty, source="EXCEL"):
        row = self.model.query.filter_by(
            finished_good_id=finished_good_id, forecast_date=forecast_date
        ).first()
        if row:
            row.qty = qty
            row.source = source
        else:
            row = self.model(
                finished_good_id=finished_good_id, forecast_date=forecast_date,
                qty=qty, source=source,
            )
            db.session.add(row)
        return row

    def daily_requirement_series(self, part_id):
        """Per-date sum of (forecast qty x BOM qty_per_unit) across every
        Finished Good that uses this child part — the demand series a
        part's peak daily requirement is drawn from."""
        return (
            db.session.query(
                CustomerForecast.forecast_date,
                func.sum(CustomerForecast.qty * BOM.qty_per_unit).label("requirement"),
            )
            .join(BOM, BOM.finished_good_id == CustomerForecast.finished_good_id)
            .filter(BOM.child_part_id == part_id)
            .group_by(CustomerForecast.forecast_date)
            .order_by(CustomerForecast.forecast_date.asc())
            .all()
        )

    def list_by_finished_good(self, finished_good_id):
        return (
            self.model.query.filter_by(finished_good_id=finished_good_id)
            .order_by(self.model.forecast_date.asc())
            .all()
        )

    def summary_by_finished_good(self):
        return (
            db.session.query(
                CustomerForecast.finished_good_id,
                func.min(CustomerForecast.forecast_date).label("from_date"),
                func.max(CustomerForecast.forecast_date).label("to_date"),
                func.count(CustomerForecast.id).label("rows"),
            )
            .group_by(CustomerForecast.finished_good_id)
            .all()
        )
