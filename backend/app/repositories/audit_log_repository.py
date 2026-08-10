"""Audit trail data access layer."""
from app.models.audit_log import AuditLog
from app.repositories.base_repository import BaseRepository


class AuditLogRepository(BaseRepository):
    model = AuditLog

    def search(self, entity_type=None, action=None, entity_id=None):
        query = self.model.query
        if entity_type:
            query = query.filter(self.model.entity_type == entity_type)
        if action:
            query = query.filter(self.model.action == action)
        if entity_id:
            query = query.filter(self.model.entity_id == entity_id)
        return query.order_by(self.model.created_at.desc())
