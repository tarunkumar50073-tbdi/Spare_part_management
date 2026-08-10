"""Authorization tests (audit finding AUTHZ-1).

Exercises the full guard -> decorator -> route stack via the Flask test client:
  * master-data mutations are ADMIN-only for people (machine passes)
  * the ERP receiving pipeline is machine-only (even an admin human is blocked)
  * store-scoped stock can't be read/written across stores (the spare-stock IDOR)

Assertions use "== 403" for a denial and "!= 403" for an allow, so the tests
check the authorization decision itself, not the downstream payload validation.
"""
import pytest

from app.extensions import db
from app.models.part import Part
from app.models.user import User, UserStoreAccess


@pytest.fixture()
def client(app):
    return app.test_client()


@pytest.fixture()
def api_key(app):
    return app.config["API_KEY"]


def _login(client, user_id):
    with client.session_transaction() as sess:
        sess["user_id"] = user_id


_seq = {"n": 0}


def _make_user(role, stores=()):
    _seq["n"] += 1
    user = User(username=f"authuser{_seq['n']}", role=role, is_active=True)
    user.set_password("pw")
    db.session.add(user)
    db.session.flush()
    for code in stores:
        db.session.add(UserStoreAccess(user_id=user.id, store_code=code))
    db.session.commit()
    return user


def _make_part(store_code):
    _seq["n"] += 1
    part = Part(part_no=f"AZ-{_seq['n']}", part_name="Authz Part", uom="PCS",
                part_type="OTHER", store_code=store_code)
    db.session.add(part)
    db.session.commit()
    return part


# --- admin_required: master-data mutations ---

def test_store_user_cannot_create_master_data(client):
    user = _make_user("STORE_USER", stores=["MAINTENANCE"])
    _login(client, user.id)
    resp = client.post("/api/v1/suppliers", json={"vendor_code": "AZ1", "supplier_name": "X"})
    assert resp.status_code == 403


def test_admin_can_create_master_data(client):
    admin = _make_user("ADMIN")
    _login(client, admin.id)
    resp = client.post("/api/v1/suppliers", json={"vendor_code": "AZ2", "supplier_name": "Y"})
    assert resp.status_code != 403


def test_machine_can_create_master_data(client, api_key):
    resp = client.post("/api/v1/suppliers", json={"vendor_code": "AZ3", "supplier_name": "Z"},
                       headers={"X-API-Key": api_key})
    assert resp.status_code != 403


# --- machine_required: ERP receiving pipeline ---

def test_human_admin_cannot_drive_erp_pipeline(client):
    admin = _make_user("ADMIN")  # even an admin human is rejected — this is ERP's to drive
    _login(client, admin.id)
    resp = client.post("/api/v1/store/gate-entry", json={})
    assert resp.status_code == 403


def test_machine_reaches_erp_pipeline(client, api_key):
    # Machine passes authz; an empty body then fails validation (4xx) — the point
    # is only that it was NOT stopped at 403.
    resp = client.post("/api/v1/store/gate-entry", json={}, headers={"X-API-Key": api_key})
    assert resp.status_code != 403


# --- require_store_access: the spare-stock IDOR ---

def test_store_user_cannot_write_another_stores_stock(client):
    user = _make_user("STORE_USER", stores=["MAINTENANCE"])
    other = _make_part("CHILD_PART")  # a store this user is NOT assigned to
    _login(client, user.id)
    resp = client.put(f"/api/v1/spare-stock/parts/{other.id}", json={"qty_on_hand": 5})
    assert resp.status_code == 403


def test_store_user_can_write_own_stores_stock(client):
    user = _make_user("STORE_USER", stores=["MAINTENANCE"])
    own = _make_part("MAINTENANCE")
    _login(client, user.id)
    resp = client.put(f"/api/v1/spare-stock/parts/{own.id}", json={"qty_on_hand": 5})
    assert resp.status_code != 403


def test_machine_can_write_any_stores_stock(client, api_key):
    part = _make_part("CHILD_PART")
    resp = client.put(f"/api/v1/spare-stock/parts/{part.id}", json={"qty_on_hand": 5},
                      headers={"X-API-Key": api_key})
    assert resp.status_code != 403
