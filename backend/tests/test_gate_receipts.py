"""Receipts from the ERP gate entry (the store, 28 Oct 2026: "gate entry k baad
store verification k baad hi (QR) nikal de" … "store stock to erp api se update
hoga jo erp ka process h"). A spare part's gate entry is a receipt to verify at
once; its QR labels can be made and printed before ERP's QC, but wait as
QC_PENDING — never issued — until ERP accepts the GRN. Stock still comes only
then (ErpGrnPostingService), and the accepted GRN finds the gate receipt: its
labels go on the shelf, or are cancelled for what QC did not accept."""
from datetime import date, datetime, timedelta, timezone

import pytest

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.gate_entry import GateEntry
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.spare_packet import SpareBatch, SparePacket
from app.models.spare_stock import SpareStock
from app.services.erp_grn_posting_service import SETTING_KEY, ErpGrnPostingService
from app.services.spare_packet_service import SINCE_KEY, SparePacketService
from app.services.spare_stock_service import SpareStockService
from app.utils.exceptions import BadRequestError

STORE = "MAINTENANCE"
TODAY = date.today()
svc = SparePacketService()
_n = {"n": 0}


@pytest.fixture(autouse=True)
def _settings():
    AppSetting.set_value(SETTING_KEY, {"enabled": True, "from_date": "2026-08-01"})
    AppSetting.set_value(SINCE_KEY, (datetime.now(timezone.utc) - timedelta(days=3)).isoformat())
    yield


def _part(qty=5):
    _n["n"] += 1
    p = Part(part_no=f"GTE-{_n['n']}", part_name=f"AIR CYLINDER {_n['n']}", uom="NOS", part_type="OTHER",
             store_code=STORE, location=f"R2-S1-B{_n['n']}", specification="MGPM20-150Z")
    db.session.add(p)
    db.session.commit()
    SpareStockService().set_quantity(p.id, qty, txn_type="OPENING")
    SpareStock.query.filter_by(part_id=p.id).update({"count_as_of": TODAY - timedelta(days=10)})
    db.session.commit()
    return p


def _gate(p, qty, day=None, no=None):
    no = no or f"GE-{p.part_no}"
    db.session.add(GateEntry(store_code="CHILD_PART", gate_entry_no=no, gate_entry_dt=day or TODAY - timedelta(days=1),
                             item_code=p.part_no, qty=qty, ven_cd="V9", ven_name="SMC CORPORATION"))
    db.session.commit()
    return no


def _grn(p, qty, accept):
    db.session.add(ReceivingRegister(store_code="CHILD_PART", grn_no=f"IN-{p.part_no}", grn_date=TODAY,
                                     ven_cd="V9", ven_name="SMC CORPORATION", item_cd=p.part_no,
                                     receipt_qty=qty, accept_qty=accept))
    db.session.commit()
    ErpGrnPostingService().post(STORE)


def _receipt(p):
    svc.receipts(STORE)
    return SpareBatch.query.filter_by(part_id=p.id, source="GATE").one()


def _on_hand(p):
    db.session.expire_all()
    return float(SpareStock.query.filter_by(part_id=p.id).one().qty_on_hand)


def _states(p):
    db.session.expire_all()
    return sorted(x.status for x in SparePacket.query.filter_by(part_id=p.id))


def test_a_gate_entry_is_a_receipt_to_verify_once():
    p = _part()
    _gate(p, 6, no=f"GE-{p.part_no}")
    _gate(p, 4, no=f"GE-{p.part_no}")                     # a second line of the same gate entry
    r = _receipt(p)
    assert (float(r.qty), r.verify_status, r.gate_entry_no, r.supplier_name) == (10, "PENDING", f"GE-{p.part_no}",
                                                                                 "SMC CORPORATION")
    d = svc.receipt_dict(r)
    assert (d["qc"], d["accepted_qty"], d["source"]) == ("QC_PENDING", None, "GATE")
    svc.receipts(STORE)
    assert SpareBatch.query.filter_by(part_id=p.id, source="GATE").count() == 1     # never twice
    old = _part()
    _gate(old, 3, day=TODAY - timedelta(days=9))          # before receipts were kept: old stock
    svc.receipts(STORE)
    assert SpareBatch.query.filter_by(part_id=old.id).count() == 0


def test_labels_are_made_after_the_count_but_wait_for_qc():
    p = _part(5)
    _gate(p, 10)
    r = _receipt(p)
    with pytest.raises(BadRequestError, match="Verify"):
        svc.pack(r.id, "UNIT", user="sup")                # the count comes first
    svc.verify(r.id, 10, user="sup")
    made = svc.pack(r.id, "UNIT", user="sup")["packets"]
    assert len(made) == 10 and {m["status"] for m in made} == {"QC_PENDING"}
    assert _on_hand(p) == 5                               # no stock before ERP accepts
    with pytest.raises(BadRequestError, match="waits for quality"):
        svc.issue(made[0]["code"], "Maintenance", user="sup", issued_to="Ravi")
    svc.record_print([m["code"] for m in made], user="sup")             # printed before QC
    svc.cancel(made[0]["code"], "Label torn", user="sup")               # and cancelled if need be
    assert _states(p).count("CANCELLED") == 1


def test_qc_acceptance_puts_the_labels_on_the_shelf():
    p = _part(5)
    _gate(p, 10)
    r = _receipt(p)
    svc.verify(r.id, 10, user="sup")
    made = svc.pack(r.id, "UNIT", user="sup")["packets"]
    _grn(p, 10, 10)
    assert _on_hand(p) == 15                              # stock as ERP accepts it
    assert SpareBatch.query.filter_by(part_id=p.id).count() == 1        # the GRN found the gate receipt
    db.session.refresh(r)
    assert r.grn_no == f"IN-{p.part_no}" and svc.receipt_dict(r)["qc"] == "ACCEPTED"
    assert _states(p) == ["AVAILABLE"] * 10
    svc.issue(made[0]["code"], "Maintenance", user="sup", issued_to="Ravi")
    assert _on_hand(p) == 14


def test_what_qc_does_not_accept_is_cancelled():
    p = _part(0)
    _gate(p, 10)
    r = _receipt(p)
    svc.verify(r.id, 10, user="sup")
    svc.pack(r.id, "UNIT", user="sup")
    _grn(p, 10, 8)
    assert _on_hand(p) == 8
    assert _states(p) == ["AVAILABLE"] * 8 + ["CANCELLED"] * 2
    gone = SparePacket.query.filter_by(part_id=p.id, status="CANCELLED").first()
    assert "Not accepted in ERP QC" in gone.cancel_reason and "8 of 10" in gone.cancel_reason


def test_labels_made_after_acceptance_go_straight_on_the_shelf():
    p = _part(0)
    _gate(p, 10)
    r = _receipt(p)
    _grn(p, 10, 6)                                        # accepted before the store got to it
    db.session.refresh(r)
    assert svc.receipt_dict(r)["accepted_qty"] == 6
    svc.verify(r.id, 10, user="sup")
    made = svc.pack(r.id, "PACKET", packet_qty=3, user="sup")["packets"]
    assert [(m["qty"], m["status"]) for m in made] == [(3, "AVAILABLE"), (3, "AVAILABLE")]   # only the 6 accepted


def test_a_grn_with_no_gate_receipt_is_a_receipt_as_before():
    p = _part(0)
    _grn(p, 4, 4)
    b = SpareBatch.query.filter_by(part_id=p.id).one()
    assert (b.source, float(b.qty)) == ("ERP_GRN", 4)
