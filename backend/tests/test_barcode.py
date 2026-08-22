"""Barcode module — Phase 1 (resolve / label print / supplier mapping / audit).

Follows the established test pattern: session-scoped `app` fixture builds + seeds
the DB (incl. the MAINTENANCE store); each test logs in by writing
sess["user_id"]; unique keys per row via a module `_seq` counter (no per-test
rollback).
"""
import pytest

from app import db
from app.models.part import Part
from app.models.user import User, UserStoreAccess

_seq = 0


def _next():
    global _seq
    _seq += 1
    return _seq


@pytest.fixture()
def client(app):
    return app.test_client()


def _login(client, user_id):
    with client.session_transaction() as sess:
        sess["user_id"] = user_id


def _admin():
    u = User(username=f"adm{_next()}", full_name="Admin", role="ADMIN", is_active=True)
    u.set_password("pw")
    db.session.add(u)
    db.session.commit()
    return u


def _store_user(stores=("MAINTENANCE",)):
    u = User(username=f"su{_next()}", full_name="Store User", role="STORE_USER", is_active=True)
    u.set_password("pw")
    db.session.add(u)
    db.session.flush()
    for code in stores:
        db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
    db.session.commit()
    return u


def _part(store_code="MAINTENANCE", active=True, part_no=None):
    p = Part(
        part_no=part_no or f"CNTR{_next():04d}",
        part_name="DIE#3 - PILOT PIN (STAL5-LC49-P4.95) MISUMI",
        uom="NO", store_code=store_code, is_active=active,
        min_stock_level=10, max_stock_level=20,
    )
    db.session.add(p)
    db.session.commit()
    return p


def _resolve(client, code, store="MAINTENANCE", source="MANUAL_ENTRY", mode="LOOKUP"):
    return client.post("/api/v1/barcode/resolve", json={
        "code": code, "store_code": store, "scan_source": source, "scan_mode": mode,
    })


# ---- resolve ----

def test_internal_part_no_resolves(client):
    _login(client, _store_user().id)
    part = _part()
    r = _resolve(client, part.part_no)
    assert r.status_code == 200
    data = r.get_json()["data"]
    assert data["part_no"] == part.part_no
    assert data["resolved_by"] == "PART_NO"
    assert data["scanned_code"] == part.part_no
    # Honest data-status, never fake ERP live stock.
    assert data["data_status"]["stock_source"] == "MANUAL"


def test_unknown_barcode_returns_404(client):
    _login(client, _store_user().id)
    _part()
    r = _resolve(client, "NOPE-DOES-NOT-EXIST")
    assert r.status_code == 404


def test_empty_master_does_not_crash(client):
    """No parts at all → clean 404, not a 500."""
    _login(client, _store_user().id)
    r = _resolve(client, "ANYTHING")
    assert r.status_code == 404
    # label-config still serves.
    assert client.get("/api/v1/barcode/label-config").status_code == 200


def test_inactive_part_rejected(client):
    _login(client, _store_user().id)
    part = _part(active=False)
    r = _resolve(client, part.part_no)
    assert r.status_code == 404


def test_whitespace_is_trimmed_not_mangled(client):
    _login(client, _store_user().id)
    part = _part()
    r = _resolve(client, f"  {part.part_no}  ")
    assert r.status_code == 200
    assert r.get_json()["data"]["part_no"] == part.part_no


# ---- auth ----

def test_unauthenticated_gets_401(client):
    r = _resolve(client, "X")  # no login
    assert r.status_code == 401


def test_no_spare_access_gets_403(client):
    _login(client, _store_user(stores=("CHILD_PART",)).id)
    part = _part()
    r = _resolve(client, part.part_no)
    assert r.status_code == 403


# ---- label print ----

def test_print_records_audit_and_barcode_is_part_no_only(client):
    _login(client, _admin().id)
    part = _part()
    r = client.post("/api/v1/barcode/print", json={"part_id": part.id, "copies": 2})
    assert r.status_code == 201
    data = r.get_json()["data"]
    # Barcode payload is ONLY the Part No. — nothing else encoded.
    assert data["barcode_value"] == part.part_no
    assert data["copies"] == 2
    assert data["is_reprint"] is False
    # The internal barcode now exists and resolves as INTERNAL.
    rr = _resolve(client, part.part_no)
    assert rr.get_json()["data"]["resolved_by"] == "INTERNAL"


def test_reprint_requires_reason(client):
    _login(client, _admin().id)
    part = _part()
    assert client.post("/api/v1/barcode/print", json={"part_id": part.id}).status_code == 201
    # Second print is a reprint → reason required.
    again = client.post("/api/v1/barcode/print", json={"part_id": part.id})
    assert again.status_code == 422
    ok = client.post("/api/v1/barcode/print", json={"part_id": part.id, "reason": "label torn"})
    assert ok.status_code == 201
    assert ok.get_json()["data"]["is_reprint"] is True


def test_cannot_print_inactive_part(client):
    _login(client, _admin().id)
    part = _part(active=False)
    r = client.post("/api/v1/barcode/print", json={"part_id": part.id})
    assert r.status_code == 422


def test_print_history(client):
    _login(client, _admin().id)
    part = _part()
    client.post("/api/v1/barcode/print", json={"part_id": part.id})
    h = client.get(f"/api/v1/barcode/print-history?part_id={part.id}")
    assert h.status_code == 200
    assert len(h.get_json()["data"]) == 1


# ---- supplier mapping ----

def test_supplier_barcode_resolves_same_part(client):
    _login(client, _admin().id)
    part = _part()
    code = f"SUP-{_next()}"
    m = client.post("/api/v1/barcode/mapping", json={"part_id": part.id, "code": code})
    assert m.status_code == 201
    r = _resolve(client, code)
    assert r.status_code == 200
    assert r.get_json()["data"]["part_no"] == part.part_no
    assert r.get_json()["data"]["resolved_by"] == "SUPPLIER"


def test_duplicate_mapping_blocked(client):
    _login(client, _admin().id)
    part = _part()
    code = f"SUP-{_next()}"
    assert client.post("/api/v1/barcode/mapping", json={"part_id": part.id, "code": code}).status_code == 201
    dup = client.post("/api/v1/barcode/mapping", json={"part_id": part.id, "code": code})
    assert dup.status_code == 409


def test_mapping_is_admin_only(client):
    _login(client, _store_user().id)
    part = _part()
    r = client.post("/api/v1/barcode/mapping", json={"part_id": part.id, "code": f"SUP-{_next()}"})
    assert r.status_code == 403


def test_deactivated_supplier_barcode_reads_inactive(client):
    _login(client, _admin().id)
    part = _part()
    code = f"SUP-{_next()}"
    client.post("/api/v1/barcode/mapping", json={"part_id": part.id, "code": code})
    # Find the mapping id and deactivate it.
    bcs = client.get(f"/api/v1/barcode/part/{part.id}/barcodes").get_json()["data"]
    mid = next(b["id"] for b in bcs if b["code"] == code)
    assert client.put(f"/api/v1/barcode/mapping/{mid}/active", json={"active": False}).status_code == 200
    # Now that code no longer resolves (still 404, and audited as INACTIVE).
    assert _resolve(client, code).status_code == 404


# ---- scan audit ----

def test_scan_audit_records_success_and_failure(client):
    admin = _admin()
    _login(client, admin.id)
    part = _part()
    _resolve(client, part.part_no)          # SUCCESS
    _resolve(client, "GHOST-CODE")           # UNKNOWN_BARCODE
    rows = client.get("/api/v1/barcode/scan-audit?store_code=MAINTENANCE").get_json()["data"]
    results = {row["scanned_code"]: row["result"] for row in rows}
    assert results.get(part.part_no) == "SUCCESS"
    assert results.get("GHOST-CODE") == "UNKNOWN_BARCODE"


def test_scan_audit_is_admin_only(client):
    _login(client, _store_user().id)
    r = client.get("/api/v1/barcode/scan-audit?store_code=MAINTENANCE")
    assert r.status_code == 403


def test_label_config_defaults(client):
    _login(client, _store_user().id)
    cfg = client.get("/api/v1/barcode/label-config").get_json()["data"]
    assert cfg["width_mm"] == 100
    assert cfg["height_mm"] == 50
    assert cfg["symbology"] == "CODE128"
