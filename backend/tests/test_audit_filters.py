"""Audit trail search + date-range filters (Phase C)."""
from datetime import date

from app.services.audit_log_service import AuditLogService


def test_audit_search_and_date_filters(app):
    svc = AuditLogService()
    svc.log(action="USER_CREATED", entity_type="user", entity_id=1, user="STORE", remarks="marker ZQ7X created")
    svc.log(action="RACK_CHANGE", entity_type="RACK_BIN", entity_id=2, user="SYSTEM", remarks="moved bin")

    # Free-text matches across action / entity / remarks / user.
    hits = svc.list_all(q="ZQ7X").all()
    assert len(hits) == 1 and hits[0].action == "USER_CREATED"

    # Entity-type filter still works alongside it.
    assert all(r.entity_type == "user" for r in svc.list_all(entity_type="user").all())

    # Today's window keeps it; a future-only window drops it.
    today = date.today().isoformat()
    assert svc.list_all(q="ZQ7X", date_from=today, date_to=today).count() == 1
    assert svc.list_all(q="ZQ7X", date_from="2999-01-01").count() == 0
