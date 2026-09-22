"""Phase 2 — two-stage issue, structured receiving, update-location + history.

Stage 1: store issues to department + person (no machine/line).
Stage 2: user confirms line + machine + installation (by re-scanning).
"""
import pytest

from app.extensions import db
from app.models.department import Department
from app.models.part import Part
from app.models.spare_stock import SpareStockLedger
from app.models.location_history import SpareLocationHistory
from app.models.user import User, UserStoreAccess
from app.services.spare_stock_service import SpareStockService
from app.utils.exceptions import BadRequestError, NotFoundError

_seq = {"n": 0}


def _part(store_code="MAINTENANCE", location=None):
    _seq["n"] += 1
    p = Part(part_no=f"TS-{_seq['n']}", part_name=f"Two Stage {_seq['n']}", uom="NO",
             part_type="OTHER", store_code=store_code, location=location)
    db.session.add(p)
    db.session.commit()
    return p


def _stock(part_id, qty):
    SpareStockService().set_quantity(part_id, float(qty), txn_type="OPENING")


def _issue_row(part_id):
    return SpareStockLedger.query.filter_by(part_id=part_id, txn_type="ISSUE").first()


@pytest.fixture()
def client(app):
    return app.test_client()


def _login(client, user_id):
    with client.session_transaction() as sess:
        sess["user_id"] = user_id


def _store_user(stores=("MAINTENANCE",), perms=None):
    _seq["n"] += 1
    u = User(username=f"tsu{_seq['n']}", role="STORE_USER", is_active=True)
    u.set_password("pw")
    # The scan/issue/receive flow needs scan_part.edit; the stock write needs
    # store_stock.edit. Grant both by default so these flow tests exercise the
    # route, not the (separately tested) module gate.
    u.set_permissions(perms or {"scan_part": {"edit": True}, "store_stock": {"edit": True}})
    db.session.add(u)
    db.session.flush()
    for code in stores:
        db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
    db.session.commit()
    return u


# ---- Stage 1: store issue ----

def test_stage1_issue_has_no_machine_and_is_pending():
    svc = SpareStockService()
    p = _part(); _stock(p.id, 20)
    svc.issue(p.id, 3, "Press Shop", issued_to="Ravi Kumar")
    row = _issue_row(p.id)
    assert row.issued_to == "Ravi Kumar"
    assert row.machine is None        # store does not know the machine yet
    assert row.status == "PENDING_USER_CONFIRMATION"


def test_stage1_machine_not_mandatory():
    svc = SpareStockService()
    p = _part(); _stock(p.id, 5)
    # No machine, no issued_to — still allowed (machine never mandatory here).
    svc.issue(p.id, 1, "Maintenance")
    assert _issue_row(p.id).status == "PENDING_USER_CONFIRMATION"


def test_issue_department_from_master_dynamic():
    svc = SpareStockService()
    db.session.add(Department(name="Weld Shop", is_active=True))
    db.session.commit()
    p = _part(); _stock(p.id, 5)
    svc.issue(p.id, 1, "Weld Shop")           # newly-added dept works, no code change
    assert _issue_row(p.id).department == "Weld Shop"
    with pytest.raises(BadRequestError):       # unknown dept still rejected
        svc.issue(p.id, 1, "Nowhere Dept")


def test_issue_over_stock_and_zero_rejected():
    svc = SpareStockService()
    p = _part(); _stock(p.id, 2)
    with pytest.raises(BadRequestError):
        svc.issue(p.id, 5, "Maintenance")
    with pytest.raises(BadRequestError):
        svc.issue(p.id, 0, "Maintenance")


# ---- Stage 2: user confirmation ----

def test_stage2_confirm_sets_line_machine_installed():
    svc = SpareStockService()
    p = _part(); _stock(p.id, 10)
    svc.issue(p.id, 4, "Press Shop", issued_to="Amit")
    lid = _issue_row(p.id).id

    res = svc.confirm_installation(lid, line_name="Seat Slider", line_no="L2",
                                   machine="MC-14", user="amit")
    assert res["line_name"] == "Seat Slider"
    assert res["line_no"] == "L2"
    assert res["machine"] == "MC-14"
    assert res["status"] == "INSTALLED"
    assert res["issued_to"] == "Amit"     # Stage 1 detail preserved


def test_stage2_partial_usage_marks_partially_used():
    svc = SpareStockService()
    p = _part(); _stock(p.id, 10)
    svc.issue(p.id, 6, "Tool Room")
    lid = _issue_row(p.id).id
    res = svc.confirm_installation(lid, line_name="Recliner", machine="MC-2", actual_qty=4)
    assert res["status"] == "PARTIALLY_USED"
    assert res["actual_qty"] == 4.0


def test_cannot_confirm_twice():
    svc = SpareStockService()
    p = _part(); _stock(p.id, 10)
    svc.issue(p.id, 2, "Maintenance")
    lid = _issue_row(p.id).id
    svc.confirm_installation(lid, machine="MC-1")
    with pytest.raises(BadRequestError):
        svc.confirm_installation(lid, machine="MC-1")


def test_cannot_reconfirm_partially_used():
    """A partially-used issue is terminal too — re-confirming it would silently
    overwrite the recorded line/machine/actual_qty (audit finding)."""
    svc = SpareStockService()
    p = _part(); _stock(p.id, 10)
    svc.issue(p.id, 6, "Tool Room")
    lid = _issue_row(p.id).id
    svc.confirm_installation(lid, machine="MC-2", actual_qty=4)   # -> PARTIALLY_USED
    with pytest.raises(BadRequestError):
        svc.confirm_installation(lid, machine="MC-2", actual_qty=5)


# ---- returnable guards (audit: double-return / return-after-install) ----

def test_returnable_double_return_rejected():
    svc = SpareStockService()
    p = _part(); _stock(p.id, 5)
    svc.issue(p.id, 1, "Tool Room", returnable=True)
    lid = _issue_row(p.id).id
    svc.return_item(lid)                       # first return credits the shelf
    with pytest.raises(BadRequestError):       # second return must not double-credit
        svc.return_item(lid)


def test_installed_returnable_cannot_be_returned():
    svc = SpareStockService()
    p = _part(); _stock(p.id, 5)
    svc.issue(p.id, 1, "Tool Room", returnable=True)
    lid = _issue_row(p.id).id
    svc.confirm_installation(lid, machine="MC-1")   # -> INSTALLED
    with pytest.raises(BadRequestError):
        svc.return_item(lid)


def test_pending_confirmations_queue():
    svc = SpareStockService()
    p = _part(); _stock(p.id, 10)
    svc.issue(p.id, 1, "Maintenance", issued_to="X")
    lid = _issue_row(p.id).id
    pending = [r for r in svc.pending_confirmations("MAINTENANCE") if r["id"] == lid]
    assert len(pending) == 1
    svc.confirm_installation(lid, machine="MC-9")
    assert not any(r["id"] == lid for r in svc.pending_confirmations("MAINTENANCE"))


# ---- structured receiving ----

def test_receive_structured_fields_stored():
    svc = SpareStockService()
    p = _part(); _stock(p.id, 0)
    svc.receive(p.id, 8, invoice_no="INV-9", check_result="OK", reference="GRN-1")
    row = SpareStockLedger.query.filter_by(part_id=p.id, txn_type="RECEIPT").first()
    assert row.invoice_no == "INV-9"
    assert row.check_result == "OK"
    assert row.status == "PHYSICALLY_RECEIVED"


def test_receive_invalid_check_result_rejected():
    svc = SpareStockService()
    p = _part(); _stock(p.id, 0)
    with pytest.raises(BadRequestError):
        svc.receive(p.id, 1, check_result="BROKEN")


def test_receive_plain_call_still_works():
    """The simple qty+reference receive keeps working (no structured fields)."""
    svc = SpareStockService()
    p = _part(); _stock(p.id, 5)
    svc.receive(p.id, 3, reference="GRN-77")
    from app.models.spare_stock import SpareStock
    assert float(SpareStock.query.filter_by(part_id=p.id).first().qty_on_hand) == 8.0


# ---- update location + history ----

def test_update_location_records_history():
    svc = SpareStockService()
    p = _part(location="R4-S1-B1 (1)")
    res = svc.update_location(p.id, "R5-S2-B3 (2)", reason="rack reorg", user="raj")
    assert res["old_location"] == "R4-S1-B1 (1)"
    assert res["new_location"] == "R5-S2-B3 (2)"
    assert Part.query.get(p.id).location == "R5-S2-B3 (2)"
    hist = svc.location_history_for_part(p.id)
    assert len(hist) == 1
    assert hist[0]["old_location"] == "R4-S1-B1 (1)"
    assert hist[0]["new_location"] == "R5-S2-B3 (2)"


def test_update_location_same_and_empty_rejected():
    svc = SpareStockService()
    p = _part(location="A-1")
    with pytest.raises(BadRequestError):
        svc.update_location(p.id, "A-1", reason="x")
    with pytest.raises(BadRequestError):
        svc.update_location(p.id, "   ", reason="x")


# ---- history carries the two-stage detail ----

def test_history_now_carries_department_and_machine():
    svc = SpareStockService()
    p = _part(); _stock(p.id, 10)
    svc.issue(p.id, 2, "Press Shop", issued_to="Sam")
    lid = _issue_row(p.id).id
    svc.confirm_installation(lid, line_name="Seat Slider", machine="MC-7")
    hist = svc.history_for_part(p.id)
    issue = next(h for h in hist if h["txn_type"] == "ISSUE")
    assert issue["department"] == "Press Shop"
    assert issue["issued_to"] == "Sam"
    assert issue["machine"] == "MC-7"
    assert issue["line_name"] == "Seat Slider"


# ---- route: two-stage via HTTP ----

def test_two_stage_via_routes(client):
    _login(client, _store_user().id)
    p = _part(); _stock(p.id, 10)
    r = client.post(f"/api/v1/spare-stock/parts/{p.id}/issue",
                    json={"qty": 2, "department": "Maintenance", "issued_to": "Vijay"})
    assert r.status_code == 200
    lid = _issue_row(p.id).id
    c = client.post(f"/api/v1/spare-stock/issues/{lid}/confirm",
                    json={"line_name": "Recliner", "line_no": "L1", "machine": "MC-3"})
    assert c.status_code == 200
    assert c.get_json()["data"]["status"] == "INSTALLED"


def test_consumption_by_period_month_and_year():
    svc = SpareStockService()
    p = _part(); _stock(p.id, 20)
    svc.issue(p.id, 3, "Maintenance")
    m = svc.consumption_by_period("MAINTENANCE", "month")
    y = svc.consumption_by_period("MAINTENANCE", "year")
    assert any(r["qty"] >= 3 for r in m) and all(len(r["period"]) == 7 for r in m)  # YYYY-MM
    assert any(r["qty"] >= 3 for r in y) and all(len(r["period"]) == 4 for r in y)  # YYYY


def test_update_location_via_route(client):
    _login(client, _store_user().id)
    p = _part(location="A-1")
    r = client.post(f"/api/v1/spare-stock/parts/{p.id}/update-location",
                    json={"new_location": "B-2", "reason": "moved"})
    assert r.status_code == 200
    assert Part.query.get(p.id).location == "B-2"


# ---- ERP add/less write is gated OFF by default (safe until approved) ----

def test_erp_write_disabled_by_default_movements_stay_pending():
    svc = SpareStockService()
    st = svc.erp_write_status()
    assert st["write_enabled"] is False and st["active"] is False
    p = _part(); _stock(p.id, 10)
    svc.issue(p.id, 2, "Maintenance")     # would be ERP minus
    svc.receive(p.id, 5)                   # would be ERP plus
    res = svc.sync_pending_to_erp("MAINTENANCE")
    assert res["configured"] is False
    assert res["write_enabled"] is False   # nothing pushed — ERP untouched
    assert res["pending"] >= 2


def test_erp_write_needs_both_flag_and_url(app):
    """Even with the flag ON, no endpoint URL = still no write (both gates)."""
    svc = SpareStockService()
    p = _part(); _stock(p.id, 5)
    svc.issue(p.id, 1, "Maintenance")
    app.config["ERP_STOCK_WRITE_ENABLED"] = True
    app.config["ERP_API_BASE_URL"] = None
    try:
        res = svc.sync_pending_to_erp("MAINTENANCE")
        assert res["configured"] is False
        assert res["write_enabled"] is True and res["api_configured"] is False
    finally:
        app.config["ERP_STOCK_WRITE_ENABLED"] = False
