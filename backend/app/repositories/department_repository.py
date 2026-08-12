"""Department master data access layer."""
from app.models.department import Department
from app.repositories.base_repository import BaseRepository


class DepartmentRepository(BaseRepository):
    model = Department

    def list_all(self, active_only=True):
        q = self.model.query
        if active_only:
            q = q.filter_by(is_active=True)
        return q.order_by(self.model.sort_order.asc(), self.model.name.asc()).all()

    def get_by_name(self, name):
        """Used when a caller carries a department's name rather than its id
        (e.g. the issue flow's department tag)."""
        if not name:
            return None
        return self.model.query.filter_by(name=name.strip()).first()

    def reorder_recipients(self):
        """Active departments flagged to receive the reorder mail AND carrying
        an address to send it to — the exact list the reorder notifier will
        e-mail. A dept with no address is silently skipped, never mailed to an
        empty string."""
        return [
            d for d in self.list_all(active_only=True)
            if d.notify_reorder and (d.email or "").strip()
        ]
