"""Audit trail data access layer."""
from sqlalchemy import func, or_

from app.models.audit_log import AuditLog
from app.repositories.base_repository import BaseRepository


class AuditLogRepository(BaseRepository):
    model = AuditLog

    def search(self, entity_type=None, action=None, entity_id=None, q=None, date_from=None, date_to=None):
        query = self.model.query
        if entity_type:
            query = query.filter(self.model.entity_type == entity_type)
        if action:
            query = query.filter(self.model.action == action)
        if entity_id:
            query = query.filter(self.model.entity_id == entity_id)
        if q:
            like = f"%{q.strip()}%"
            query = query.filter(or_(
                self.model.action.ilike(like),
                self.model.entity_type.ilike(like),
                self.model.remarks.ilike(like),
                self.model.user.ilike(like),
            ))
        # Bound on the calendar date (YYYY-MM-DD); func.date() drops the time so
        # a single day's `from == to` returns that whole day.
        if date_from:
            query = query.filter(func.date(self.model.created_at) >= date_from)
        if date_to:
            query = query.filter(func.date(self.model.created_at) <= date_to)
        return query.order_by(self.model.created_at.desc())
