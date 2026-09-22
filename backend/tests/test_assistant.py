"""In-app assistant API tests: no-crash on odd input, answer shape, and that the
catalogue + suggestions respect the caller's per-module / admin rights."""
import pytest

from app.extensions import db
from app.models.user import User


@pytest.fixture()
def client(app):
    return app.test_client()


_seq = {"n": 0}


def _login(client, user_id):
    with client.session_transaction() as sess:
        sess["user_id"] = user_id


def _make_user(role, perms=None):
    _seq["n"] += 1
    u = User(username=f"asstuser{_seq['n']}", role=role, is_active=True)
    u.set_password("pw")
    if perms:
        u.set_permissions(perms)
    db.session.add(u)
    db.session.commit()
    return u


@pytest.fixture()
def admin(client):
    u = _make_user("ADMIN")
    _login(client, u.id)
    return u


def _routes(items):
    return {i["route"] for i in items}


# ---- no-crash / shape ----

def test_ask_empty_body_ok(client, admin):
    resp = client.post("/api/v1/assistant/ask", json={})
    assert resp.status_code == 200
    d = resp.get_json()["data"]
    assert isinstance(d["answer"], str) and isinstance(d["suggestions"], list)


def test_ask_non_object_json_body_does_not_500(client, admin):
    # force=True parses this as JSON; a non-dict body must not crash the route.
    resp = client.post("/api/v1/assistant/ask", data="[1]", content_type="application/json")
    assert resp.status_code == 200


def test_ask_reorder_shape(client, admin):
    resp = client.post("/api/v1/assistant/ask", json={"query": "reorder"})
    assert resp.status_code == 200
    d = resp.get_json()["data"]
    assert isinstance(d["answer"], str)
    assert isinstance(d["results"], list) and isinstance(d["suggestions"], list)


# ---- rights are respected ----

def test_services_admin_sees_admin_screens(client, admin):
    rows = client.get("/api/v1/assistant/services").get_json()["data"]
    routes = _routes(rows)
    assert "/admin" in routes and "/settings" in routes


def test_services_store_user_hides_forbidden(client):
    # A store user with ONLY store_stock view should not be offered part_master,
    # admin or settings screens.
    u = _make_user("STORE_USER", perms={"store_stock": {"view": True}})
    _login(client, u.id)
    rows = client.get("/api/v1/assistant/services").get_json()["data"]
    routes = _routes(rows)
    assert "/store-stock-spare" in routes        # allowed module
    assert "/suppliers" in routes                # ungated screen stays
    assert "/parts" not in routes                # part_master not granted
    assert "/admin" not in routes and "/settings" not in routes


def test_suggestions_respect_rights(client):
    # Asking about a screen the user may not open must not suggest it.
    u = _make_user("STORE_USER", perms={"store_stock": {"view": True}})
    _login(client, u.id)
    d = client.post("/api/v1/assistant/ask", json={"query": "part master"}).get_json()["data"]
    assert "/parts" not in _routes(d["suggestions"])
