"""Dashboard Snapshot data access layer."""
from app.extensions import db
from app.models.dashboard_snapshot import DashboardSnapshot
from app.repositories.base_repository import BaseRepository
from app.utils.db_tx import maybe_commit


class DashboardSnapshotRepository(BaseRepository):
    model = DashboardSnapshot

    def upsert(self, snapshot_date, total_parts, short_parts, excess_parts, category_counts):
        row = self.model.query.filter_by(snapshot_date=snapshot_date).first()
        if row:
            row.total_parts = total_parts
            row.short_parts = short_parts
            row.excess_parts = excess_parts
            row.category_counts = category_counts
        else:
            row = self.model(
                snapshot_date=snapshot_date, total_parts=total_parts,
                short_parts=short_parts, excess_parts=excess_parts,
            )
            row.category_counts = category_counts
            db.session.add(row)
        maybe_commit()
        return row

    def list_recent(self, days=7):
        return (
            self.model.query.order_by(self.model.snapshot_date.desc())
            .limit(days).all()[::-1]
        )

    def get_before(self, snapshot_date):
        """Most recent snapshot strictly before `snapshot_date` — used for
        the KPI cards' "vs yesterday" delta."""
        return (
            self.model.query.filter(self.model.snapshot_date < snapshot_date)
            .order_by(self.model.snapshot_date.desc()).first()
        )
