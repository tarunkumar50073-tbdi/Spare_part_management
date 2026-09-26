"""Spare receiving read from ERP: an ERP GRN line whose quality was accepted in
ERP becomes store stock exactly once; nothing is counted twice with a physical
count; quality-pending and rejected quantities never become stock."""
from datetime import date, datetime, timezone

import pytest

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.spare_flow import SpareTransaction
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.models.user import User, UserStoreAccess
from app.services.erp_grn_posting_service import SETTING_KEY, ErpGrnPostingService
from app.services.spare_stock_service import SpareStockService

_seq = {"n": 0}
COUNTED_ON = datetime(2026, 9, 1, 4, 0, tzinfo=timezone.utc)


def _part(counted=True):
    _seq["n"] += 1
    p = Part(part_no=f"EG-{_seq['n']}", part_name=f"ERP GRN Part {_seq['n']}", uom="NO",
             part_type="OTHER", store_code="MAINTENANCE")
    db.session.add(p)
    db.session.commit()
    if counted:
        SpareStockService().set_quantity(p.id, 10, txn_type="OPENING")
        # The count happened on 1 Sep — move every stamp there.
        row = SpareStock.query.filter_by(part_id=p.id).first()
        row.last_counted_at = COUNTED_ON
        row.created_at = COUNTED_ON
        for led in SpareStockLedger.query.filter_by(part_id=p.id).all():
            led.created_at = COUNTED_ON
        db.session.commit()
    return p


def _grn(part, grn_no, grn_date, receipt, accept=None, reject=None):
    db.session.add(ReceivingRegister(
        store_code="CHILD_PART", grn_no=grn_no, grn_date=grn_date, ven_cd="V001",
        ven_name="Test Vendor", challan_no="INV-1", item_cd=part.part_no,
        receipt_qty=receipt, accept_qty=accept, reject_qty=reject))
    db.session.commit()


def _on_hand(part):
    row = SpareStock.query.filter_by(part_id=part.id).first()
    return float(row.qty_on_hand) if row else None


def _line(svc, part, grn_no):
    return next(r for r in svc.lines("MAINTENANCE", part_id=part.id) if r["grn_no"] == grn_no)


@pytest.fixture(autouse=True)
def _settings():
    AppSetting.set_value(SETTING_KEY, {"enabled": True, "from_date": "2026-08-01"})
    yield
    AppSetting.set_value(SETTING_KEY, {"enabled": True, "from_date": "2026-09-26"})


def test_accepted_grn_is_added_once_with_ledger_and_journal():
    svc = ErpGrnPostingService()
    p = _part()
    _grn(p, "GRN-A", date(2026, 9, 5), receipt=5, accept=5)
    assert _line(svc, p, "GRN-A")["state"] == "WILL_POST"

    svc.post("MAINTENANCE")
    assert _on_hand(p) == 15.0
    led = SpareStockLedger.query.filter_by(part_id=p.id, txn_type="RECEIPT").all()
    assert len(led) == 1 and led[0].status == "ERP_GRN" and led[0].reference == "GRN-A"
    j = SpareTransaction.query.filter_by(part_id=p.id, txn_type="GRN").one()
    assert float(j.qty) == 5 and j.grn_no == "GRN-A" and j.ledger_id == led[0].id
    assert j.new_status == "STOCK_AVAILABLE"

    svc.post("MAINTENANCE")          # a second sync adds nothing
    assert _on_hand(p) == 15.0
    assert _line(svc, p, "GRN-A")["state"] == "POSTED"


def test_quality_pending_and_rejected_never_become_stock():
    svc = ErpGrnPostingService()
    p = _part()
    _grn(p, "GRN-P", date(2026, 9, 6), receipt=4)
    _grn(p, "GRN-R", date(2026, 9, 6), receipt=2, accept=None, reject=2)
    svc.post("MAINTENANCE")
    assert _on_hand(p) == 10.0
    assert _line(svc, p, "GRN-P")["state"] == "QUALITY_PENDING"
    assert _line(svc, p, "GRN-R")["state"] == "REJECTED"


def test_grn_on_or_before_the_count_is_skipped():
    svc = ErpGrnPostingService()
    p = _part()
    _grn(p, "GRN-OLD", date(2026, 9, 1), receipt=3, accept=3)   # counted the same day
    svc.post("MAINTENANCE")
    assert _on_hand(p) == 10.0
    line = _line(svc, p, "GRN-OLD")
    assert line["state"] == "SKIPPED" and "baseline" in line["reason"]


def test_uncounted_part_is_skipped_and_gets_no_stock_row():
    svc = ErpGrnPostingService()
    p = _part(counted=False)
    _grn(p, "GRN-U", date(2026, 9, 5), receipt=3, accept=3)
    svc.post("MAINTENANCE")
    assert _on_hand(p) is None
    assert _line(svc, p, "GRN-U")["state"] == "SKIPPED"


def test_more_accepted_later_adds_the_difference_and_less_is_flagged():
    svc = ErpGrnPostingService()
    p = _part()
    _grn(p, "GRN-D", date(2026, 9, 5), receipt=6, accept=4)
    svc.post("MAINTENANCE")
    assert _on_hand(p) == 14.0
    rr = ReceivingRegister.query.filter_by(grn_no="GRN-D").one()
    rr.accept_qty = 6
    db.session.commit()
    svc.post("MAINTENANCE")
    assert _on_hand(p) == 16.0
    rr.accept_qty = 5
    db.session.commit()
    svc.post("MAINTENANCE")
    assert _on_hand(p) == 16.0                       # never reversed silently
    assert _line(svc, p, "GRN-D")["state"] == "CHECK"


def test_before_post_from_date_and_switched_off():
    svc = ErpGrnPostingService()
    p = _part()
    _grn(p, "GRN-F", date(2026, 9, 5), receipt=2, accept=2)
    svc.set_settings({"from_date": "2026-09-10"})
    svc.post("MAINTENANCE")
    assert _on_hand(p) == 10.0 and _line(svc, p, "GRN-F")["state"] == "SKIPPED"
    svc.set_settings({"from_date": "2026-09-01", "enabled": False})
    assert _line(svc, p, "GRN-F")["state"] == "OFF"
    assert svc.post("MAINTENANCE")["posted"] == []
    assert _on_hand(p) == 10.0


def test_erp_grn_rows_are_never_pushed_back_to_erp():
    stock = SpareStockService()
    before = stock.pending_erp_count("MAINTENANCE")
    p = _part()
    after_count = stock.pending_erp_count("MAINTENANCE")
    _grn(p, "GRN-E", date(2026, 9, 5), receipt=1, accept=1)
    ErpGrnPostingService().post("MAINTENANCE")
    assert stock.pending_erp_count("MAINTENANCE") == after_count
    assert after_count >= before


def _client_as(app, perms):
    _seq["n"] += 1
    u = User(username=f"eguser{_seq['n']}", role="STORE_USER", is_active=True)
    u.set_password("pw")
    u.set_permissions(perms)
    db.session.add(u)
    db.session.flush()
    db.session.add(UserStoreAccess(user_id=u.id, store_code="MAINTENANCE"))
    db.session.commit()
    client = app.test_client()
    with client.session_transaction() as s:
        s["user_id"] = u.id
    return client


def test_preview_is_readable_but_posting_needs_store_stock_edit(app):
    p = _part()
    _grn(p, "GRN-RT", date(2026, 9, 5), receipt=2, accept=2)
    viewer = _client_as(app, {"spare_store": {"view": True, "edit": False}})
    r = viewer.get("/api/v1/erp-grn/preview?store_code=MAINTENANCE")
    assert r.status_code == 200
    rows = [x for x in r.get_json()["data"]["rows"] if x["grn_no"] == "GRN-RT"]
    assert rows and rows[0]["state"] == "WILL_POST"
    assert viewer.post("/api/v1/erp-grn/post?store_code=MAINTENANCE").status_code == 403
    assert viewer.put("/api/v1/erp-grn/settings", json={"enabled": False}).status_code == 403
    assert _on_hand(p) == 10.0

    editor = _client_as(app, {"store_stock": {"view": True, "edit": True}})
    r = editor.post("/api/v1/erp-grn/post?store_code=MAINTENANCE")
    assert r.status_code == 200
    assert _on_hand(p) == 12.0
