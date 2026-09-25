"""Endpoints that used to be open to every signed-in user now check a right.

Reports and the audit trail are read-gated; the Child Parts Store write screens
(put-away, holding transfer, daily count, rack-alert resolve) need the
`child_store` right while that store is switched off; the spare ERP push needs
Store Stock edit. "== 403" checks a denial and "!= 403" an allow, so the test
pins the authorization decision, not the downstream payload validation.
"""
import pytest

from app.extensions import db
from app.models.user import User, UserStoreAccess

_seq = {"n": 0}


@pytest.fixture()
def client(app):
    return app.test_client()


def _user(role="STORE_USER", perms=None, stores=("MAINTENANCE",)):
    _seq["n"] += 1
    u = User(username=f"gateuser{_seq['n']}", role=role, is_active=True)
    u.set_password("pw")
    if perms:
        u.set_permissions(perms)
    db.session.add(u)
    db.session.flush()
    for code in stores:
        db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
    db.session.commit()
    return u


def _as(client, user):
    with client.session_transaction() as sess:
        sess["user_id"] = user.id
    return client


GATED = [
    ("get", "/api/v1/reports/srv/excel", None),
    ("get", "/api/v1/reports/srv/csv", None),
    ("get", "/api/v1/audit-logs", None),
    ("post", "/api/v1/notifications/999999/resolve", None),
    ("post", "/api/v1/holding/999999/transfer", {}),
    ("post", "/api/v1/store/srvs/999999/put-away/confirm", {}),
    ("post", "/api/v1/stock-count/submit", {}),
    ("post", "/api/v1/stock-count/import", None),
    ("post", "/api/v1/spare-stock/erp-sync?store_code=MAINTENANCE", None),
]


@pytest.mark.parametrize("method,url,body", GATED)
def test_plain_user_is_refused(client, method, url, body):
    c = _as(client, _user())
    resp = getattr(c, method)(url, json=body) if body is not None else getattr(c, method)(url)
    assert resp.status_code == 403, (url, resp.status_code, resp.get_json())


@pytest.mark.parametrize("method,url,body", GATED)
def test_admin_passes_the_gate(client, method, url, body):
    c = _as(client, _user(role="ADMIN", stores=()))
    resp = getattr(c, method)(url, json=body) if body is not None else getattr(c, method)(url)
    assert resp.status_code != 403, (url, resp.status_code, resp.get_json())


def test_granted_rights_open_exactly_their_endpoints(client):
    c = _as(client, _user(perms={"reports": {"view": True}, "audit_trail": {"view": True}}))
    assert c.get("/api/v1/reports/srv/csv").status_code != 403
    assert c.get("/api/v1/audit-logs").status_code != 403
    # ...but not the Child store's writes.
    assert c.post("/api/v1/stock-count/submit", json={}).status_code == 403
