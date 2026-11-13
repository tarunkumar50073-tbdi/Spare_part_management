"""Line + Machine on the issue (the store, 13 Nov 2026: "scan me jab part issue
karte h to usme kis line par kis m/c par issue hua wo bhi banana h").

His choices: optional; an issue to the Tool Room offers its presses, any other
department the plant's machines (maintenance_db). The issue keeps the line and
the machine code; the Issue list shows them."""
from datetime import date, datetime, timezone

import pytest

from app.extensions import db
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.spare_flow import SpareTransaction
from app.models.spare_packet import SpareBatch
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.models.user import User, UserStoreAccess
from app.models.app_setting import AppSetting
from app.services import machine_list_service as mls
from app.services.erp_grn_posting_service import SETTING_KEY, ErpGrnPostingService
from app.services.spare_packet_service import SparePacketService
from app.services.spare_stock_service import SpareStockService

STORE = "MAINTENANCE"
DEPT = "Maintenance"
_seq = {"n": 0}


def _part(qty=10):
    _seq["n"] += 1
    p = Part(part_no=f"LM-{_seq['n']}", part_name=f"Line Machine Part {_seq['n']}", uom="NOS",
             part_type="OTHER", store_code=STORE)
    db.session.add(p)
    db.session.commit()
    SpareStockService().set_quantity(p.id, qty, txn_type="OPENING")
    # Counted on 1 Sep 2026, so a later GRN is new stock (as test_spare_packets).
    counted = datetime(2026, 9, 1, 4, 0, tzinfo=timezone.utc)
    row = SpareStock.query.filter_by(part_id=p.id).first()
    row.last_counted_at = row.created_at = counted
    for led in SpareStockLedger.query.filter_by(part_id=p.id).all():
        led.created_at = counted
    db.session.commit()
    return p


def test_source_follows_the_department():
    assert mls.source_for("Tool Room") == "TOOL_ROOM"
    assert mls.source_for("Press Tool Room") == "TOOL_ROOM"
    assert mls.source_for("Maintenance") == "MAINTENANCE"
    assert mls.source_for("Purchase") == "MAINTENANCE"
    assert mls.source_for(None) == "MAINTENANCE"


def test_machines_are_grouped_by_line_in_order():
    rows = [("SEAT_SLIDER", "YHB_SS", "YHB_SS_05", "Rail Assy M/c # 02"),
            ("SEAT_SLIDER", "YHB_SS", "YHB_SS_06", "YHB_SS_06"),
            ("CANTEEN", "CANTEEN_", "Canteen  Chapati M/C", "Canteen  Chapati M/C"),
            ("X", None, "  ", "blank code is dropped"),
            ("X", "", "X_01", None)]
    out = mls.group(rows)
    assert [(l["zone"], l["line"]) for l in out] == [("SEAT_SLIDER", "YHB_SS"), ("CANTEEN", "CANTEEN"), ("X", "Other")]
    assert out[0]["machines"] == [{"code": "YHB_SS_05", "name": "Rail Assy M/c # 02"},
                                  {"code": "YHB_SS_06", "name": None}]      # name = code is not repeated
    assert out[1]["machines"] == [{"code": "Canteen Chapati M/C", "name": None}]
    assert out[2]["machines"] == [{"code": "X_01", "name": None}]


def test_qty_issue_keeps_line_and_machine_on_ledger_and_journal():
    p = _part()
    out = SpareStockService().issue(p.id, 2, DEPT, issued_to="Ravi", user="t",
                                    line_name="  YHB_SS ", machine="YHB_SS_05")
    assert out["issue"]["line_name"] == "YHB_SS" and out["issue"]["machine"] == "YHB_SS_05"
    j = SpareTransaction.query.filter_by(part_id=p.id, txn_type="ISSUE").one()
    assert (j.line_name, j.machine) == ("YHB_SS", "YHB_SS_05")
    # Optional: nothing picked leaves both blank.
    out = SpareStockService().issue(p.id, 1, DEPT, issued_to="Ravi", user="t", line_name="", machine=None)
    assert out["issue"]["line_name"] is None and out["issue"]["machine"] is None


@pytest.fixture()
def _grn_settings():
    AppSetting.set_value(SETTING_KEY, {"enabled": True, "from_date": "2026-08-01"})
    yield
    AppSetting.set_value(SETTING_KEY, {"enabled": True, "from_date": "2026-09-26"})


def test_packet_issues_keep_line_and_machine(_grn_settings):
    p = _part(0)
    db.session.add(ReceivingRegister(
        store_code="CHILD_PART", grn_no="GRN-LM", grn_date=date(2026, 10, 25), ven_cd="V001", ven_name="S",
        gate_entry_no="GE-LM", gate_entry_dt=date(2026, 10, 25), challan_no="INV-LM", item_cd=p.part_no,
        receipt_qty=60, accept_qty=60))
    db.session.commit()
    ErpGrnPostingService().post(STORE)
    b = SpareBatch.query.filter_by(part_id=p.id, grn_no="GRN-LM").one()
    svc = SparePacketService()
    svc.verify(b.id, 60, user="sup")
    pk = svc.pack(b.id, "PACKET", packet_qty=20, user="sup")["packets"]
    one = svc.issue(pk[0]["code"], "Tool Room", issued_to="Ravi", user="t", line_name="Line 2", machine="Press-12")
    assert (one["issue"]["line_name"], one["issue"]["machine"]) == ("Line 2", "Press-12")
    many = svc.issue_many([pk[1]["code"], pk[2]["code"]], DEPT, issued_to="Ravi", user="t",
                          line_name="YHB_SS", machine="YHB_SS_05")
    assert {(i["line_name"], i["machine"]) for i in many["issues"]} == {("YHB_SS", "YHB_SS_05")}


def _issuer():
    _seq["n"] += 1
    u = User(username=f"lmuser{_seq['n']}", role="STORE_USER", is_active=True)
    u.set_password("pw-line-machine-1")
    u.set_permissions({"scan_part": {"view": True, "create": True}})
    db.session.add(u)
    db.session.flush()
    db.session.add(UserStoreAccess(user_id=u.id, store_code=STORE))
    db.session.commit()
    return u


def test_api_issue_and_machine_list(app, monkeypatch):
    p = _part()
    c = app.test_client()
    with c.session_transaction() as s:
        s["user_id"] = _issuer().id
    r = c.post(f"/api/v1/spare-stock/parts/{p.id}/issue",
               json={"qty": 1, "department": DEPT, "issued_to": "Ravi", "line_name": "YCA_SS", "machine": "YCA_SS_09"})
    assert r.status_code == 200
    led = SpareStockLedger.query.get(r.get_json()["data"]["issue"]["id"])
    assert (led.line_name, led.machine) == ("YCA_SS", "YCA_SS_09")
    assert c.post(f"/api/v1/spare-stock/parts/{p.id}/issue",
                  json={"qty": 1, "department": DEPT, "machine": "M" * 61}).status_code in (400, 422)

    # The list: a database that cannot be read says so and offers nothing.
    mls._cache.clear()
    monkeypatch.setattr(mls, "_url", lambda roster: None)
    r = c.get("/api/v1/employees/machines", query_string={"department": "Tool Room"})
    assert r.status_code == 200, r.get_json()
    d = r.get_json()["data"]
    assert d == {"source": "TOOL_ROOM", "ok": False, "error": d["error"], "lines": []}
    assert "not set up" in d["error"]
    mls._cache.clear()
