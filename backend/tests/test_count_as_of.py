"""A physical count loaded later than it was taken (27 Oct 2026: the DX sheet's
count "as on 27.09" loaded a month on): the upload's Counted On day is the
baseline, so ERP GRNs after it are added on top — already accepted ones at the
next post, pending ones once quality accepts — and those on / before it are
already in the count. A later count with no date goes back to "now"."""
import io
from datetime import date

import pytest
from openpyxl import Workbook

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.spare_stock import SpareStock
from app.services.erp_grn_posting_service import SETTING_KEY, ErpGrnPostingService
from app.services.spare_stock_service import SpareStockService

STORE = "MAINTENANCE"
_n = {"n": 0}


@pytest.fixture(autouse=True)
def _grn_on():
    AppSetting.set_value(SETTING_KEY, {"enabled": True, "from_date": "2026-08-01"})
    yield


def _part():
    _n["n"] += 1
    p = Part(part_no=f"CAO-{_n['n']}", part_name="COUNT AS OF BEARING", uom="NOS", part_type="OTHER", store_code=STORE)
    db.session.add(p)
    db.session.commit()
    return p


def _grn(p, no, day, qty, accept=True):
    db.session.add(ReceivingRegister(store_code="CHILD_PART", grn_no=no, grn_date=day, item_cd=p.part_no,
                                     receipt_qty=qty, accept_qty=qty if accept else None))
    db.session.commit()


def _upload(rows, head=("Part No", "Physical Stock", "Counted On")):
    wb = Workbook()
    ws = wb.active
    ws.append(list(head))
    for r in rows:
        ws.append(list(r))
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return SpareStockService().bulk_import(buf, store_code=STORE, user="sup")


def _on_hand(p):
    return float(SpareStock.query.filter_by(part_id=p.id).one().qty_on_hand)


def test_a_count_as_on_an_earlier_day_takes_the_grns_after_it():
    p = _part()
    _grn(p, f"G-{p.id}-A", date(2026, 9, 20), 4)              # before the count: in it already
    _grn(p, f"G-{p.id}-B", date(2026, 9, 28), 6)              # after it, accepted
    _grn(p, f"G-{p.id}-C", date(2026, 10, 3), 10, accept=False)   # after it, quality pending
    report = _upload([(p.part_no, 50, "27.09.2026")])
    assert report["updated"] == 1 and _on_hand(p) == 50
    assert SpareStock.query.filter_by(part_id=p.id).one().count_as_of == date(2026, 9, 27)

    ErpGrnPostingService().post(STORE)
    assert _on_hand(p) == 56                                   # + the 28.09 GRN, never the 20.09 one
    states = {l["grn_no"]: l["state"] for l in ErpGrnPostingService().lines(STORE, part_id=p.id)}
    assert states == {f"G-{p.id}-A": "SKIPPED", f"G-{p.id}-B": "POSTED", f"G-{p.id}-C": "QUALITY_PENDING"}

    # Quality accepts the pending one later: it is added, not taken as counted.
    ReceivingRegister.query.filter_by(grn_no=f"G-{p.id}-C").update({"accept_qty": 10})
    db.session.commit()
    ErpGrnPostingService().post(STORE)
    assert _on_hand(p) == 66

    # A fresh count with no date stands for now again.
    _upload([(p.part_no, 60)], head=("Part No", "Physical Stock"))
    assert SpareStock.query.filter_by(part_id=p.id).one().count_as_of is None


def test_a_bad_or_future_count_date_is_refused_for_its_row():
    p = _part()
    report = _upload([(p.part_no, 5, "31.12.2099")])
    assert report["updated"] == 0 and "future" in str(report.get("errors"))
    report = _upload([(p.part_no, 5, "someday")])
    assert report["updated"] == 0 and "not a date" in str(report.get("errors"))
