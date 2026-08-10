"""Audit trail — one call point for every important action logged across
the store process. `user` is always 'SYSTEM' (ERP-inbound/automated) or
'STORE' (store-operator action) — see AuditLog model docstring."""
from app.repositories.audit_log_repository import AuditLogRepository


class AuditLogService:
    def __init__(self):
        self.repo = AuditLogRepository()

    def log(self, action, entity_type, entity_id, user="SYSTEM", old_location=None, new_location=None, quantity=None, remarks=None):
        return self.repo.create(
            action=action, entity_type=entity_type, entity_id=entity_id, user=user,
            old_location=old_location, new_location=new_location, quantity=quantity, remarks=remarks,
        )

    def list_all(self, entity_type=None, action=None, entity_id=None):
        return self.repo.search(entity_type=entity_type, action=action, entity_id=entity_id)
