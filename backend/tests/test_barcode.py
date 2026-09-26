"""Barcode module — resolve / label print / supplier mapping / audit.

Follows the established test pattern: session-scoped `app` fixture builds + seeds
the DB (incl. the MAINTENANCE store); each test logs in by writing
sess["user_id"]; unique keys per row via a module `_seq` counter (no per-test
rollback). A test that changes the shared label template restores it after.
"""
import json
import queue
from contextlib import contextmanager

import pytest

from app import db
from app.models.app_setting import AppSetting
from app.models.label_print_audit import LabelPrintAudit
from app.models.part import Part
from app.models.scan_audit import ScanAudit
from app.models.user import User, UserStoreAccess
from app.schemas.barcode_schema import SCAN_READ_MAX
from app.services.barcode_service import LABEL_SETTING_KEY, BarcodeService
from app.utils import event_bus

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


def _store_user(stores=("MAINTENANCE",), perms=None):
    u = User(username=f"su{_next()}", full_name="Store User", role="STORE_USER", is_active=True)
    u.set_password("pw")
    if perms:
        u.set_permissions(perms)
    db.session.add(u)
    db.session.flush()
    for code in stores:
        db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
    db.session.commit()
    return u


def _part(store_code="MAINTENANCE", active=True, part_no=None, location=None):
    p = Part(
        part_no=part_no or f"CNTR{_next():04d}",
        part_name="DIE#3 - PILOT PIN (STAL5-LC49-P4.95) MISUMI",
        uom="NO", store_code=store_code, is_active=active,
        min_stock_level=10, max_stock_level=20, location=location,
    )
    db.session.add(p)
    db.session.commit()
    return p


def _resolve(client, code, store="MAINTENANCE", source="MANUAL_ENTRY", mode="LOOKUP"):
    return client.post("/api/v1/barcode/resolve", json={
        "code": code, "store_code": store, "scan_source": source, "scan_mode": mode,
    })


def _print(client, part_id, **extra):
    return client.post("/api/v1/barcode/print", json={"part_id": part_id, **extra})


@pytest.fixture()
def bus():
    """A subscriber on the live-update bus, as an open screen's SSE stream is."""
    q = event_bus.subscribe()
    yield q
    event_bus.unsubscribe(q)


def _events(q):
    out = []
    while True:
        try:
            out.append(json.loads(q.get_nowait()))
        except queue.Empty:
            return out


@contextmanager
def _label_template(value):
    """Temporarily save a label template override (the DB is shared by the
    whole session, so the previous one is put back afterwards)."""
    before = AppSetting.get_value(LABEL_SETTING_KEY)
    AppSetting.set_value(LABEL_SETTING_KEY, value)
    try:
        yield
    finally:
        row = AppSetting.query.filter_by(key=LABEL_SETTING_KEY).first()
        if before is None:
            db.session.delete(row)
            db.session.commit()
        else:
            AppSetting.set_value(LABEL_SETTING_KEY, before)


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
    # The success carries the id of the scan-audit row that recorded it.
    scan = db.session.get(ScanAudit, data["scan_id"])
    assert scan is not None and scan.result == "SUCCESS" and scan.part_id == part.id


def test_unknown_barcode_returns_404(client):
    _login(client, _store_user().id)
    _part()
    r = _resolve(client, "NOPE-DOES-NOT-EXIST")
    assert r.status_code == 404
    # Only this outcome lets the screen offer "Unknown Supplier Barcode -> Map".
    assert r.get_json()["errors"] == {"result": "UNKNOWN_BARCODE", "code": "NOPE-DOES-NOT-EXIST"}


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
    assert r.get_json()["errors"] == {"result": "INACTIVE_PART", "code": part.part_no}
    # Audited with the DB-allowed value (the CHECK only knows SCAN_RESULTS).
    row = ScanAudit.query.filter_by(scanned_code=part.part_no).order_by(ScanAudit.id.desc()).first()
    assert row.result == "INACTIVE_BARCODE" and row.part_id == part.id


def test_other_store_part_reads_other_store_without_leaking_it(client):
    _login(client, _admin().id)
    foreign = _part(store_code="CHILD_PART")
    r = _resolve(client, foreign.part_no)
    assert r.status_code == 404
    # The outcome and the scanned code only — no part id of the other store.
    assert r.get_json()["errors"] == {"result": "OTHER_STORE", "code": foreign.part_no}
    row = ScanAudit.query.filter_by(scanned_code=foreign.part_no).order_by(ScanAudit.id.desc()).first()
    assert row.result == "UNKNOWN_BARCODE" and row.part_id is None


@pytest.mark.parametrize("blank", ["", "   "])
def test_blank_scan_is_failed_and_audited(client, blank):
    """An empty read is a scan too — it reaches the resolver (not a schema 422)
    so it gets the failed-scan shape and an audit row."""
    user = _store_user()
    _login(client, user.id)
    r = _resolve(client, blank)
    assert r.status_code == 400
    assert r.get_json()["errors"] == {"result": "FAILED", "code": ""}
    row = ScanAudit.query.filter_by(user=user.username).one()
    assert (row.scanned_code, row.result, row.part_id) == ("", "FAILED", None)


def test_over_long_code_is_audited_and_never_offered_for_mapping(client):
    """A vendor QR that carries lot and qty is longer than any Part No. or mapped
    barcode (80). It is a normal scan: audited (its first 80 characters, the
    column's width) and answered as {result, code} with the whole read — as
    CODE_TOO_LONG, not UNKNOWN_BARCODE, because "Map to Part" could never
    store a code that long."""
    user = _store_user()
    _login(client, user.id)
    code = f"VQR{_next():05d}|LOT=L2609|QTY=1|".ljust(81, "9")
    assert len(code) == 81
    r = _resolve(client, code, source="USB_SCANNER")
    assert r.status_code == 404
    body = r.get_json()
    assert body["errors"] == {"result": "CODE_TOO_LONG", "code": code}
    assert "Search the Part No." in body["message"]
    row = ScanAudit.query.filter_by(user=user.username).one()
    assert (row.scanned_code, row.result, row.part_id, row.scan_source) == (
        code[:80], "UNKNOWN_BARCODE", None, "USB_SCANNER")


def test_code_of_exactly_80_characters_still_resolves(client):
    """80 is the widest mapped barcode, so a code that long is looked up as usual."""
    _login(client, _admin().id)
    part = _part()
    code = f"SUP80-{_next()}-".ljust(80, "7")
    assert client.post("/api/v1/barcode/mapping", json={"part_id": part.id, "code": code}).status_code == 201
    r = _resolve(client, code)
    assert r.status_code == 200
    assert (r.get_json()["data"]["part_id"], r.get_json()["data"]["resolved_by"]) == (part.id, "SUPPLIER")
    unknown = _resolve(client, "U".ljust(80, "0"))
    assert unknown.get_json()["errors"]["result"] == "UNKNOWN_BARCODE"


def test_absurd_request_body_is_still_capped(client):
    _login(client, _store_user().id)
    assert _resolve(client, "X" * (SCAN_READ_MAX + 1)).status_code == 422


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
    part = _part(location="A1-03")
    r = _print(client, part.id, copies=2, source="SUPPLIER_BARCODE",
               printer_name="Spare Parts Store Label Printer")
    assert r.status_code == 201
    data = r.get_json()["data"]
    # The QR payload is ONLY the Part No. — the description and location are
    # printed on the label as text (spec 3), never encoded.
    assert data["barcode_value"] == part.part_no
    assert (data["part_no"], data["part_name"], data["location"]) == (part.part_no, part.part_name, "A1-03")
    assert data["symbology"] == "QR"
    assert data["copies"] == 2
    assert data["is_reprint"] is False
    # The audit keeps how it was identified, where and what was printed.
    row = db.session.get(LabelPrintAudit, data["print_id"])
    assert (row.source, row.printer_name, row.symbology, row.location_printed) == (
        "SUPPLIER_BARCODE", "Spare Parts Store Label Printer", "QR", "A1-03")
    # The internal barcode now exists, is a QR, and resolves as INTERNAL.
    bcs = client.get(f"/api/v1/barcode/part/{part.id}/barcodes").get_json()["data"]
    internal = next(b for b in bcs if b["source"] == "INTERNAL")
    assert (internal["code"], internal["symbology"]) == (part.part_no, "QR")
    rr = _resolve(client, part.part_no)
    assert rr.get_json()["data"]["resolved_by"] == "INTERNAL"


def test_print_without_location_records_none(client):
    _login(client, _admin().id)
    part = _part()
    data = _print(client, part.id, source="ERP_SEARCH").get_json()["data"]
    assert data["location"] is None
    assert db.session.get(LabelPrintAudit, data["print_id"]).location_printed is None


def test_reprint_requires_reason(client):
    """Legacy callers (no source): printed before = reprint = reason needed."""
    _login(client, _admin().id)
    part = _part()
    assert _print(client, part.id).status_code == 201
    # Second print is a reprint → reason required.
    again = _print(client, part.id)
    assert again.status_code == 422
    ok = _print(client, part.id, reason="label torn")
    assert ok.status_code == 201
    assert ok.get_json()["data"]["is_reprint"] is True


@pytest.mark.parametrize("source", ["SUPPLIER_BARCODE", "ERP_SEARCH", "MANUAL_ENTRY", "QR_SCAN"])
def test_workstation_sources_never_need_a_reason(client, source):
    """New material identified at the workstation gets new labels — even for a
    part labelled before, it is not a reprint and no reason is asked."""
    _login(client, _admin().id)
    part = _part()
    assert _print(client, part.id).status_code == 201           # labelled before
    r = _print(client, part.id, source=source)
    assert r.status_code == 201
    assert r.get_json()["data"]["is_reprint"] is False
    assert r.get_json()["data"]["source"] == source


def test_reprint_source_always_needs_a_reason(client):
    _login(client, _admin().id)
    part = _part()
    # Even as the part's first print, the explicit Reprint action needs a reason.
    assert _print(client, part.id, source="REPRINT").status_code == 422
    ok = _print(client, part.id, source="REPRINT", reason="label faded")
    assert ok.status_code == 201
    assert ok.get_json()["data"]["is_reprint"] is True
    assert ok.get_json()["data"]["reason"] == "label faded"


@pytest.mark.parametrize("source", ["PART_MASTER", "STORE_STOCK"])
def test_master_data_sources_keep_the_printed_before_rule(client, source):
    _login(client, _admin().id)
    part = _part()
    assert _print(client, part.id, source=source).status_code == 201
    assert _print(client, part.id, source=source).status_code == 422
    assert _print(client, part.id, source=source, reason="lost").status_code == 201


def test_unknown_print_source_rejected(client):
    _login(client, _admin().id)
    part = _part()
    assert _print(client, part.id, source="DIRECT").status_code == 422


def test_cannot_print_inactive_part(client):
    _login(client, _admin().id)
    part = _part(active=False)
    r = _print(client, part.id)
    assert r.status_code == 422


def test_print_history(client):
    _login(client, _admin().id)
    part = _part(location="B2-07")
    _print(client, part.id, source="MANUAL_ENTRY", printer_name="Store Zebra")
    h = client.get(f"/api/v1/barcode/print-history?part_id={part.id}")
    assert h.status_code == 200
    rows = h.get_json()["data"]
    assert len(rows) == 1
    assert (rows[0]["source"], rows[0]["printer_name"], rows[0]["location_printed"], rows[0]["symbology"]) == (
        "MANUAL_ENTRY", "Store Zebra", "B2-07", "QR")


def test_print_history_limit_is_capped(client, monkeypatch):
    _login(client, _admin().id)
    part = _part()
    seen = {}
    svc = BarcodeService()

    def spy(part_id, limit=50):
        seen["limit"] = limit
        return []

    monkeypatch.setattr(svc.print_repo, "list_for_part", spy)
    svc.print_history(part.id, limit=5000)
    assert seen["limit"] == 200
    svc.print_history(part.id, limit=0)
    assert seen["limit"] == 50
    # The route passes the query arg through the same cap.
    assert client.get(f"/api/v1/barcode/print-history?part_id={part.id}&limit=5000").status_code == 200


def test_print_pushes_a_stock_event(client, bus):
    """A print changes the part's scan result (printed count, Print vs Reprint,
    printed location), so other open screens are told to refresh."""
    _login(client, _admin().id)
    part = _part()
    assert _print(client, part.id, source="QR_SCAN").status_code == 201
    assert {"event": "stock", "data": {"part_id": part.id, "action": "label_print"}} in _events(bus)
    # A refused print (reprint without a reason) changed nothing: no push.
    assert _print(client, part.id, source="REPRINT").status_code == 422
    assert _events(bus) == []


def test_bulk_print_pushes_the_printed_parts_only(client, bus):
    _login(client, _admin().id)
    fresh, labelled = _part(), _part()
    assert _print(client, labelled.id).status_code == 201
    _events(bus)                                        # drop the single print's push
    r = client.post("/api/v1/barcode/print-bulk", json={"part_ids": [fresh.id, labelled.id]})
    assert r.status_code == 201
    assert [s["part_id"] for s in r.get_json()["data"]["skipped"]] == [labelled.id]
    assert _events(bus) == [{"event": "stock", "data": {"part_ids": [fresh.id], "action": "label_print"}}]
    # A batch that skipped every part pushes nothing.
    r = client.post("/api/v1/barcode/print-bulk", json={"part_ids": [fresh.id, labelled.id]})
    assert r.get_json()["data"]["printed"] == []
    assert _events(bus) == []


def test_template_change_restamps_the_internal_symbology(client):
    _login(client, _admin().id)
    part = _part()
    _print(client, part.id, source="QR_SCAN")
    with _label_template({"symbology": "CODE128"}):
        data = _print(client, part.id, source="QR_SCAN").get_json()["data"]
        assert data["symbology"] == "CODE128"
        bcs = client.get(f"/api/v1/barcode/part/{part.id}/barcodes").get_json()["data"]
        assert next(b for b in bcs if b["source"] == "INTERNAL")["symbology"] == "CODE128"
    # Earlier prints keep the symbology they were printed in.
    hist = client.get(f"/api/v1/barcode/print-history?part_id={part.id}").get_json()["data"]
    assert [h["symbology"] for h in hist] == ["CODE128", "QR"]


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
    r = _resolve(client, code)
    assert r.status_code == 404
    assert r.get_json()["errors"] == {"result": "INACTIVE_BARCODE", "code": code}


def test_mapping_toggle_is_store_checked(client):
    """A supplier-barcode editor of another store can't switch this store's
    mapping off by its raw id."""
    _login(client, _admin().id)
    part = _part()
    code = f"SUP-{_next()}"
    client.post("/api/v1/barcode/mapping", json={"part_id": part.id, "code": code})
    mid = next(b["id"] for b in client.get(f"/api/v1/barcode/part/{part.id}/barcodes").get_json()["data"]
               if b["code"] == code)
    _login(client, _store_user(stores=("CHILD_PART",), perms={"supplier_barcodes": {"edit": True}}).id)
    assert client.put(f"/api/v1/barcode/mapping/{mid}/active", json={"active": False}).status_code == 403
    assert client.put("/api/v1/barcode/mapping/999999/active", json={"active": False}).status_code == 404
    _login(client, _admin().id)
    assert _resolve(client, code).status_code == 200            # still active


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
    # QR + Part No + description + location (spec 3 / 29).
    assert cfg["symbology"] == "QR"
    assert cfg["show_location"] is True


def test_label_config_old_ean13_template_falls_back_to_qr(client):
    """EAN-13 can't carry an alphanumeric Part No; a template saved with it
    before keeps its other values and prints the default QR instead."""
    _login(client, _store_user().id)
    with _label_template({"symbology": "EAN13", "width_mm": 80}):
        cfg = client.get("/api/v1/barcode/label-config").get_json()["data"]
        assert cfg["symbology"] == "QR" and cfg["width_mm"] == 80


def test_label_config_accepts_qr_and_linear_codes_not_ean13(client):
    _login(client, _admin().id)
    before = AppSetting.get_value(LABEL_SETTING_KEY)
    with _label_template(before or {}):
        for sym in ("QR", "CODE128", "CODE39"):
            r = client.put("/api/v1/admin/label-config", json={"symbology": sym, "show_location": False})
            assert r.status_code == 200 and r.get_json()["data"]["symbology"] == sym
            assert r.get_json()["data"]["show_location"] is False
        assert client.put("/api/v1/admin/label-config", json={"symbology": "EAN13"}).status_code == 422
