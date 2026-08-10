"""Store / Section master data access layer."""
from app.models.store import Section, Store
from app.repositories.base_repository import BaseRepository


class StoreRepository(BaseRepository):
    model = Store

    def get_by_code(self, code):
        if not code:
            return None
        return self.model.query.filter_by(code=code).first()

    def list_active(self):
        return self.model.query.filter_by(is_active=True).order_by(
            self.model.sort_order.asc(), self.model.name.asc()
        ).all()


class SectionRepository(BaseRepository):
    model = Section

    def list_for_store(self, store_id, active_only=True):
        q = self.model.query.filter_by(store_id=store_id)
        if active_only:
            q = q.filter_by(is_active=True)
        return q.order_by(self.model.sort_order.asc(), self.model.name.asc()).all()

    def get_by_name(self, store_id, name):
        """Used by the Excel import, which carries a section's name rather
        than its id."""
        if not name:
            return None
        return self.model.query.filter_by(store_id=store_id, name=name.strip()).first()
