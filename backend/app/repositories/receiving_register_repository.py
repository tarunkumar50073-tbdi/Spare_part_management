"""Receiving Register data access — GRN receiving rows, filterable by item for
a part's receipt history."""
from app.extensions import db
from app.models.receiving_register import ReceivingRegister
from app.repositories.base_repository import BaseRepository


class ReceivingRegisterRepository(BaseRepository):
    model = ReceivingRegister

    def list_rows(self, store_code=None, item_cd=None, limit=None):
        q = self.model.query
        if store_code:
            q = q.filter_by(store_code=store_code)
        if item_cd:
            q = q.filter_by(item_cd=item_cd)
        q = q.order_by(self.model.grn_date.desc(), self.model.id.desc())
        return q.limit(limit).all() if limit else q.all()

    def replace_all(self, store_code, instances):
        """Snapshot sync — swap this store's rows for a fresh ERP set."""
        self.model.query.filter_by(store_code=store_code).delete()
        db.session.add_all(instances)
        db.session.commit()
        return len(instances)
