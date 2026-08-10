"""Customer schedule / forecast from the SCM system — one row per Finished
Good per date, carrying that day's requirement quantity. Ingested today via
Excel upload; the SCM app will push this via API directly once it's live
(see `source`)."""
from app.extensions import db
from app.models.base import BaseModel


class CustomerForecast(BaseModel):
    __tablename__ = "customer_forecasts"

    finished_good_id = db.Column(db.Integer, db.ForeignKey("finished_goods.id"), nullable=False, index=True)
    forecast_date = db.Column(db.Date, nullable=False, index=True)
    qty = db.Column(db.Numeric(12, 2), nullable=False)
    source = db.Column(db.String(10), nullable=False, default="EXCEL")  # EXCEL / API

    finished_good = db.relationship("FinishedGood")

    __table_args__ = (
        db.UniqueConstraint("finished_good_id", "forecast_date", name="uq_forecast_fg_date"),
        db.CheckConstraint("source IN ('EXCEL','API')", name="ck_forecast_source"),
    )

    def __repr__(self):
        return f"<CustomerForecast fg={self.finished_good_id} {self.forecast_date} qty={self.qty}>"
