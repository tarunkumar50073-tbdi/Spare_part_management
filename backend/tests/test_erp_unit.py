"""Plant 1 is ERP unit 10001 (the store, 5 Nov 2026: "plant-1 me unit-10001 ka
stock hi dikhana chahiye and app me bhi unit-code 10001 k according stock
update hona chahiye"): ERP's current stock is read for that unit only, and only
GRNs / gate entries whose number carries it (IN2627/001/..., 2627/001/...)
count — never Plant 2's (IN2627/002/..., 2627/002/...)."""
from datetime import date, datetime, timedelta, timezone

import pytest

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.erp_stock import ERPStock
from app.models.gate_entry import GateEntry
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.spare_packet import SpareBatch
from app.services.erp_grn_posting_service import SETTING_KEY, ErpGrnPostingService
from app.services.erp_sync_service import ERPSyncService
from app.services.spare_packet_service import SINCE_KEY, SparePacketService
from app.utils.erp_unit import is_plant_doc, is_plant_unit, unit_segment

STORE = "MAINTENANCE"
TODAY = date.today()
_n = {"n": 0}


@pytest.fixture(autouse=True)
def _settings():
    AppSetting.set_value(SETTING_KEY, {"enabled": True, "from_date": "2026-08-01"})
    AppSetting.set_value(SINCE_KEY, (datetime.now(timezone.utc) - timedelta(days=3)).isoformat())
    yield
    ERPStock.query.filter(ERPStock.under_insp.isnot(None)).delete(synchronize_session=False)
    db.session.commit()


def _part():
    _n["n"] += 1
    p = Part(part_no=f"UNIT-{_n['n']}", part_name="PLANT ONE SENSOR", uom="NOS", part_type="OTHER", store_code=STORE)
    db.session.add(p)
    db.session.commit()
    return p


def test_the_plant_unit_and_its_document_numbers():
    assert unit_segment() == "001"
    assert is_plant_doc("IN2627/001/1069") and is_plant_doc("2627/001/13971") and is_plant_doc("CN2627/001/660")
    assert not is_plant_doc("IN2627/002/163") and not is_plant_doc("2627/002/288")
    assert is_plant_doc("GRN-A") and is_plant_doc(None)          # no unit part: kept
    assert is_plant_unit("10001") and is_plant_unit(" 10001 ") and is_plant_unit(None)
    assert not is_plant_unit("10002") and not is_plant_unit("10005")


def test_erp_stock_is_read_for_unit_10001_only(monkeypatch):
    p, q = _part(), _part()
    svc = ERPSyncService()
    rows = [{"item_cd": p.part_no, "clos_stock": "17", "under_insp": "2", "unit_cd": "10001"},
            {"item_cd": p.part_no, "clos_stock": "30", "under_insp": "5", "unit_cd": "10002"},   # Plant 2
            {"item_cd": q.part_no, "clos_stock": "8", "under_insp": "0", "unit_cd": "10002"}]    # Plant 2 only
    monkeypatch.setattr(svc.erp, "fetch_rows", lambda table, cols, **kw: rows)
    svc.sync_current_stock()
    row = ERPStock.query.filter_by(part_id=p.id).one()
    assert float(row.qty_on_hand) == 17 and float(row.under_insp) == 2
    assert ERPStock.query.filter_by(part_id=q.id).first() is None    # not in Plant 1's stock


def test_another_plants_grn_and_gate_entry_do_not_count_here():
    p = _part()
    for no in ("IN2627/001/9001", "IN2627/002/9002"):
        db.session.add(ReceivingRegister(store_code="CHILD_PART", grn_no=f"{no}-{p.id}", grn_date=TODAY,
                                         item_cd=p.part_no, receipt_qty=3))
    for no in (f"2627/001/{p.id}1", f"2627/002/{p.id}2"):
        db.session.add(GateEntry(store_code="CHILD_PART", gate_entry_no=no, gate_entry_dt=TODAY - timedelta(days=1),
                                 item_code=p.part_no, qty=3, ven_cd="V1", ven_name="SUPPLIER"))
    db.session.commit()
    grns = {l["grn_no"] for l in ErpGrnPostingService().lines(STORE, part_id=p.id)}
    assert grns == {f"IN2627/001/9001-{p.id}"}
    svc = SparePacketService()
    svc.receipts(STORE)
    gates = {b.gate_entry_no for b in SpareBatch.query.filter_by(part_id=p.id, source="GATE")}
    assert gates == {f"2627/001/{p.id}1"}
    # A Plant 2 receipt made before this rule is not listed.
    db.session.add(SpareBatch(receipt_no=f"RCP-U{p.id}", store_code=STORE, part_id=p.id, source="GATE",
                              received_on=TODAY, qty=3, uom="NOS", gate_entry_no=f"2627/002/{p.id}9",
                              gate_entry_dt=TODAY, created_by="ERP-GATE"))
    db.session.commit()
    listed = {r["gate_entry_no"] for r in svc.receipts(STORE)["rows"] if r["part"]["id"] == p.id}
    assert listed == {f"2627/001/{p.id}1"}
