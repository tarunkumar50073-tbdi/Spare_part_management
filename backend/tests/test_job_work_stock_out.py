"""A new part sent from store stock for coating / job work leaves store stock
(the store, 27-28 Oct 2026: "store person erp me issue slip daalta h supplier k
naam ki and us issue slip se rgp bna deta h"). ERP's returnable challan carries
the issue slip no. (doc_no) when ERP took the part out of its stock by that
slip; the app takes it out of store stock too (JOB_WORK_OUT), and the vendor's
GRN brings it back. A used part (a job work return holds the line), a challan
with no issue slip, one on / before the part's count, or a part never counted
moves nothing; a line found to be a used part later, or cancelled, is put back."""
from datetime import date

import pytest

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.job_work import ErpRgpLine
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.services.erp_grn_posting_service import SETTING_KEY as GRN_KEY, ErpGrnPostingService
from app.services.job_work_service import JobWorkService
from app.services.spare_return_service import SpareReturnService
from app.services.spare_stock_service import SpareStockService

STORE = "MAINTENANCE"
COUNT_DAY = date(2026, 9, 27)
_n = {"n": 0}
jobs = JobWorkService()


@pytest.fixture(autouse=True)
def _auto_stock_on():
    AppSetting.set_value(GRN_KEY, {"enabled": True, "from_date": "2026-09-26"})
    yield


def _part(qty=10, counted=True):
    _n["n"] += 1
    p = Part(part_no=f"JWO-{_n['n']}", part_name="BENDING DIE INSERT", uom="NOS", part_type="OTHER", store_code=STORE)
    db.session.add(p)
    db.session.commit()
    if counted:
        SpareStockService().set_quantity(p.id, qty, txn_type="OPENING")
        SpareStock.query.filter_by(part_id=p.id).update({"count_as_of": COUNT_DAY})
        db.session.commit()
    return p


def _line(p, no, day, qty=1, slip="26-27/001IS7762", status="HOLD"):
    return {"id": None, "challan_no": no, "challan_dt": day.strftime("%d-%m-%Y"), "challan_type": "General FOC",
            "party_cd": "V1", "party_name": "OERLIKON BALZERS COATING INDIA PVT LTD", "status": status,
            "target_date": None, "gate_exit_no": None, "doc_no": slip, "item_cd": p.part_no,
            "item_desc": "BENDING DIE INSERT - COATING", "uom": "NOS", "qty": str(qty)}


def _on_hand(p):
    db.session.expire_all()
    return float(SpareStock.query.filter_by(part_id=p.id).one().qty_on_hand)


def _moves(p):
    return [(float(r.qty_delta), r.reference) for r in SpareStockLedger.query.filter_by(
        part_id=p.id, txn_type="JOB_WORK_OUT").order_by(SpareStockLedger.id)]


def _state(no):
    rows = jobs.lines(q=no)["rows"]
    return next(r for r in rows if r["challan_no"] == no)


def test_a_new_part_goes_out_on_its_challan_and_comes_back_on_the_vendors_grn():
    p = _part(10)
    no = f"FO/{p.part_no}/1"
    rows = [_line(p, no, date(2026, 10, 10), qty=2)]
    jobs.sync(rows=rows)
    assert _on_hand(p) == 8 and _moves(p) == [(-2.0, no)]
    assert _state(no)["stock_state"] == "OUT" and _state(no)["stock_out_qty"] == 2
    # Read again: nothing moves twice.
    jobs.sync(rows=rows)
    assert _on_hand(p) == 8 and len(_moves(p)) == 1
    # Not an issue: no consumption, nothing for the ERP write-back.
    assert not SpareStockLedger.query.filter_by(part_id=p.id, txn_type="ISSUE").count()
    # The coated part comes back on the vendor's GRN.
    db.session.add(ReceivingRegister(store_code="CHILD_PART", grn_no=f"G-{p.part_no}", grn_date=date(2026, 10, 20),
                                     item_cd=p.part_no, receipt_qty=2, accept_qty=2))
    db.session.commit()
    ErpGrnPostingService().post(STORE)
    assert _on_hand(p) == 10


def test_lines_that_move_nothing():
    no_slip = _part(5)
    jobs.sync(rows=[_line(no_slip, f"FO/{no_slip.part_no}/n", date(2026, 10, 10), slip=None)])
    assert _on_hand(no_slip) == 5 and _state(f"FO/{no_slip.part_no}/n")["stock_state"] == "NO_SLIP"

    before = _part(5)
    jobs.sync(rows=[_line(before, f"FO/{before.part_no}/b", COUNT_DAY)])            # the count holds it
    assert _on_hand(before) == 5 and _state(f"FO/{before.part_no}/b")["stock_state"] == "BEFORE_COUNT"

    never = _part(counted=False)
    jobs.sync(rows=[_line(never, f"FO/{never.part_no}/c", date(2026, 10, 10))])
    assert SpareStock.query.filter_by(part_id=never.id).first() is None
    assert _state(f"FO/{never.part_no}/c")["stock_state"] == "NOT_COUNTED"

    off = _part(5)
    AppSetting.set_value(GRN_KEY, {"enabled": False, "from_date": "2026-09-26"})
    jobs.sync(rows=[_line(off, f"FO/{off.part_no}/o", date(2026, 10, 10))])
    assert _on_hand(off) == 5 and _state(f"FO/{off.part_no}/o")["stock_state"] == "OFF"


def test_a_used_part_moves_no_stock():
    p = _part(10)
    issue = SpareStockService().issue(p.id, 1, "Maintenance", issued_to="Ravi")["issue"]["id"]   # 9
    ret = SpareReturnService().job_work_return(issue, 1, reason="Worn", user="store")
    no = f"FO/{p.part_no}/u"
    jobs.sync(rows=[_line(p, no, date.today())])                       # linked to the return by itself
    assert _on_hand(p) == 9 and _moves(p) == []
    st = _state(no)
    assert st["stock_state"] == "USED_PART" and st["linked_return"] == ret["return_no"]


def test_a_line_found_to_be_a_used_part_later_is_put_back():
    p = _part(10)
    no = f"FO/{p.part_no}/l"
    jobs.sync(rows=[_line(p, no, date(2026, 10, 10))])
    assert _on_hand(p) == 9                                            # taken as a new part
    issue = SpareStockService().issue(p.id, 1, "Maintenance", issued_to="Ravi")["issue"]["id"]   # 8
    ret = SpareReturnService().job_work_return(issue, 1, reason="Worn", user="store")
    line = ErpRgpLine.query.filter_by(challan_no=no).one()
    jobs.link(ret["id"], line.id, user="sup")                          # it was the used one
    assert _on_hand(p) == 9 and _moves(p) == [(-1.0, no), (1.0, no)]
    assert _state(no)["stock_state"] == "USED_PART"


def test_a_cancelled_challan_is_put_back_unless_counted_since():
    p = _part(10)
    no = f"FO/{p.part_no}/x"
    rows = [_line(p, no, date(2026, 10, 10), qty=3)]
    jobs.sync(rows=rows)
    assert _on_hand(p) == 7
    rows[0]["status"] = "CANCEL"
    jobs.sync(rows=rows)
    assert _on_hand(p) == 10 and _state(no)["stock_state"] == "CANCELLED"

    q = _part(10)
    no2 = f"FO/{q.part_no}/y"
    rows = [_line(q, no2, date(2026, 10, 10), qty=3)]
    jobs.sync(rows=rows)
    SpareStockService().set_quantity(q.id, 7, txn_type="ADJUSTMENT")   # counted after it went out
    rows[0]["status"] = "CANCEL"
    jobs.sync(rows=rows)
    assert _on_hand(q) == 7 and _moves(q) == [(-3.0, no2)]             # the count holds it now


def test_store_stock_never_goes_below_zero():
    p = _part(1)
    no = f"FO/{p.part_no}/s"
    jobs.sync(rows=[_line(p, no, date(2026, 10, 10), qty=3)])
    assert _on_hand(p) == 1 and _moves(p) == []
    assert _state(no)["stock_state"] == "SHORT"
