"""Pending RGP data access. 'Pending' = Balance Qty still greater than 0."""
from app.extensions import db
from app.models.rgp import RGP
from app.repositories.base_repository import BaseRepository


class RGPRepository(BaseRepository):
    model = RGP

    def list_for_store(self, store_code, pending_only=False):
        q = self.model.query
        if store_code:
            q = q.filter_by(store_code=store_code)
        if pending_only:
            q = q.filter(self.model.balance_qty > 0)
        # Most-overdue first, so the worst pending returns sit on top.
        return q.order_by(self.model.pend_days.desc(), self.model.id.desc()).all()

    def pending_count(self, store_code=None):
        q = self.model.query.filter(self.model.balance_qty > 0)
        if store_code:
            q = q.filter_by(store_code=store_code)
        return q.count()

    def replace_all(self, store_code, instances):
        """Snapshot sync: swap this store's RGP rows for a fresh set — the way an
        ERP 'current pending' feed updates (the report is a snapshot, not a
        ledger)."""
        self.model.query.filter_by(store_code=store_code).delete()
        db.session.add_all(instances)
        db.session.commit()
        return len(instances)
