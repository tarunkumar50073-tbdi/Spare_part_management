"""Notification data access layer."""
from app.models.notification import Notification
from app.repositories.base_repository import BaseRepository


class NotificationRepository(BaseRepository):
    model = Notification

    def list_active(self, type_=None):
        query = self.model.query.filter(self.model.status == "ACTIVE")
        if type_:
            query = query.filter(self.model.type == type_)
        return query.order_by(self.model.created_at.desc()).all()

    def find_active(self, type_, part_id):
        return self.model.query.filter(
            self.model.type == type_, self.model.part_id == part_id, self.model.status == "ACTIVE"
        ).first()
