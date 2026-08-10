"""One row per calendar day of Total/Short/Excess Parts counts (plus a
per-category breakdown), upserted on every dashboard summary read (see
StoreDashboardService.record_snapshot) — no scheduler, matches this app's
request-driven style. Powers the Dashboard's Inventory Trend chart and the
KPI cards' "vs yesterday" delta.

category_counts_json is a JSON-serialized {category: count} dict rather
than fixed columns — Part.CATEGORIES has already changed shape once
(SOB/BOP/Import -> 5 categories), so the snapshot storage shouldn't need a
migration every time the taxonomy does."""
import json
from app.extensions import db
from app.models.base import BaseModel


class DashboardSnapshot(BaseModel):
    __tablename__ = "dashboard_snapshots"

    snapshot_date = db.Column(db.Date, unique=True, nullable=False, index=True)
    total_parts = db.Column(db.Integer, nullable=False, default=0)
    short_parts = db.Column(db.Integer, nullable=False, default=0)
    excess_parts = db.Column(db.Integer, nullable=False, default=0)
    category_counts_json = db.Column(db.Text, nullable=False, default="{}")

    @property
    def category_counts(self):
        return json.loads(self.category_counts_json or "{}")

    @category_counts.setter
    def category_counts(self, value):
        self.category_counts_json = json.dumps(value or {})

    def __repr__(self):
        return f"<DashboardSnapshot {self.snapshot_date} total={self.total_parts} short={self.short_parts} excess={self.excess_parts}>"
