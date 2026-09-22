"""Settings API tests: barcode-label editor, read-only system status, and
store/section visibility — admin-only, secrets never echoed, last-store guard."""
import json

import pytest

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.store import Store
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
    u = User(username=f"setuser{_seq['n']}", role=role, is_active=True)
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


# ---- barcode label editor ----

def test_label_config_default(client, admin):
    resp = client.get("/api/v1/admin/label-config")
    assert resp.status_code == 200
    data = resp.get_json()["data"]
    assert data["width_mm"] == 100 and data["symbology"] == "CODE128"


def test_label_config_put_persists_and_reflects_everywhere(client, admin):
    resp = client.put("/api/v1/admin/label-config", json={"width_mm": 80, "description_max_chars": 30})
    assert resp.status_code == 200
    saved = resp.get_json()["data"]
    assert saved["width_mm"] == 80 and saved["description_max_chars"] == 30
    # Persisted in app_settings...
    assert AppSetting.get_value("barcode_label")["width_mm"] == 80
    # ...and served by the public barcode label-config the label renderer reads.
    pub = client.get("/api/v1/barcode/label-config").get_json()["data"]
    assert pub["width_mm"] == 80


def test_label_config_rejects_bad_value(client, admin):
    resp = client.put("/api/v1/admin/label-config", json={"symbology": "NOPE"})
    assert resp.status_code == 422   # marshmallow validation failure


# ---- read-only system status ----

def test_system_status_shape_and_no_secrets(client, admin):
    resp = client.get("/api/v1/admin/system-status")
    assert resp.status_code == 200
    data = resp.get_json()["data"]
    assert set(["email", "erp", "uploads", "label"]).issubset(data.keys())
    # No secret value ever leaves the server — the blob must not contain any
    # password/user/host/key/url field anywhere.
    blob = json.dumps(data).lower()
    for banned in ("password", "secret", "api_key", "smtp_user", "erp_db_host", "database_url"):
        assert banned not in blob


# ---- store / section visibility ----

def test_store_visibility_lists_all_including_inactive(client, admin):
    # Hide one store, then confirm the visibility listing still returns it.
    Store.query.filter_by(code="CHILD_PART").update({"is_active": False})
    db.session.commit()
    try:
        rows = client.get("/api/v1/admin/store-visibility").get_json()["data"]
        codes = {r["code"]: r["is_active"] for r in rows}
        assert "CHILD_PART" in codes and codes["CHILD_PART"] is False
        assert "MAINTENANCE" in codes
    finally:
        Store.query.filter_by(code="CHILD_PART").update({"is_active": True})
        db.session.commit()


def test_cannot_hide_last_active_store(client, admin):
    # Leave only MAINTENANCE active, then try to hide it too -> refused.
    Store.query.filter_by(code="CHILD_PART").update({"is_active": False})
    db.session.commit()
    try:
        resp = client.put("/api/v1/admin/stores/MAINTENANCE/active", json={"is_active": False})
        assert resp.status_code == 400
        assert Store.query.filter_by(code="MAINTENANCE").first().is_active is True
    finally:
        Store.query.filter_by(code="CHILD_PART").update({"is_active": True})
        db.session.commit()


def test_toggle_store_requires_boolean(client, admin):
    resp = client.put("/api/v1/admin/stores/MAINTENANCE/active", json={})
    assert resp.status_code == 400


# ---- admin-only ----

def test_settings_endpoints_are_admin_only(client):
    user = _make_user("STORE_USER", perms={"store_stock": {"edit": True}})
    _login(client, user.id)
    assert client.get("/api/v1/admin/system-status").status_code == 403
    assert client.get("/api/v1/admin/label-config").status_code == 403
    assert client.put("/api/v1/admin/label-config", json={"width_mm": 90}).status_code == 403
    assert client.get("/api/v1/admin/store-visibility").status_code == 403
