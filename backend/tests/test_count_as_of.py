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


def _upload_with_qc(rows, qc_rows, head=("Part No", "In Stock", "Counted On")):
    """A stock upload with a "Waiting for QC" tab (5 Nov 2026: an opening load
    from ERP's stock, which holds accepted material only)."""
    wb = Workbook()
    ws = wb.active
    ws.title = "Stock"
    ws.append(list(head))
    for r in rows:
        ws.append(list(r))
    qc = wb.create_sheet("Waiting for QC")
    qc.append(["Part No", "Description", "GRN No", "GRN Date", "GRN Qty", "Supplier"])
    for r in qc_rows:
        qc.append(list(r))
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return SpareStockService().bulk_import(buf, store_code=STORE, user="sup")


def test_a_grn_waiting_for_quality_at_the_count_is_added_when_accepted():
    p = _part()
    _grn(p, f"G-{p.id}-OLD", date(2026, 10, 20), 7)                 # accepted before: in the count
    _grn(p, f"G-{p.id}-QC", date(2026, 10, 30), 20, accept=False)   # waiting for QC at the count
    _grn(p, f"G-{p.id}-NO", date(2026, 10, 31), 5, accept=False)    # waiting too, but not in the tab
    report = _upload_with_qc([(p.part_no, 40, "01.11.2026")],
                             [(p.part_no, "X", f"g-{p.id}-qc ", "30.10.2026", 20, "V")])  # GRN no. as typed
    assert report["updated"] == 1 and report["qc_waiting_noted"] == 1 and report["qc_waiting_left"] == []
    assert _on_hand(p) == 40

    # Quality accepts both later: the noted one is added though dated before
    # the count; the one not in the tab is taken as counted.
    ReceivingRegister.query.filter(ReceivingRegister.grn_no.in_([f"G-{p.id}-QC", f"G-{p.id}-NO"])).update(
        {"accept_qty": ReceivingRegister.receipt_qty}, synchronize_session=False)
    db.session.commit()
    lines = {l["grn_no"]: l for l in ErpGrnPostingService().lines(STORE, part_id=p.id)}
    assert lines[f"G-{p.id}-QC"]["state"] == "WILL_POST" and "waiting for quality" in lines[f"G-{p.id}-QC"]["reason"]
    assert lines[f"G-{p.id}-NO"]["state"] == "SKIPPED"
    assert lines[f"G-{p.id}-OLD"]["state"] == "SKIPPED"
    ErpGrnPostingService().post(STORE)
    assert _on_hand(p) == 60
    ErpGrnPostingService().post(STORE)                                # never twice
    assert _on_hand(p) == 60

    # A newer count of the part stands on its own: the old note no longer applies.
    _upload([(p.part_no, 55, "03.11.2026")], head=("Part No", "In Stock", "Counted On"))
    ErpGrnPostingService().post(STORE)
    assert _on_hand(p) == 55


def test_qc_lines_of_a_row_that_did_not_apply_are_left_out():
    p, q = _part(), _part()
    _grn(q, f"G-{q.id}-QC", date(2026, 10, 30), 3, accept=False)
    report = _upload_with_qc([(p.part_no, 5, "01.11.2026"), (q.part_no, -1, "01.11.2026")],
                             [(q.part_no, "X", f"G-{q.id}-QC", "", 3, ""), ("NO-SUCH-PART", "", "G-1", "", 1, "")])
    assert report["updated"] == 1 and report["qc_waiting_noted"] == 0
    assert {r["part_no"] for r in report["qc_waiting_left"]} == {q.part_no, "NO-SUCH-PART"}


def test_a_waiting_for_qc_tab_without_its_columns_stops_the_upload():
    p = _part()
    wb = Workbook()
    ws = wb.active
    ws.append(["Part No", "In Stock"])
    ws.append([p.part_no, 9])
    bad = wb.create_sheet("Waiting for QC")
    bad.append(["Part No", "Something"])
    bad.append([p.part_no, "x"])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    with pytest.raises(Exception) as exc:
        SpareStockService().bulk_import(buf, store_code=STORE, user="sup")
    assert "Waiting for QC" in str(exc.value)
    assert SpareStock.query.filter_by(part_id=p.id).first() is None


def test_an_old_grn_not_on_the_qc_list_is_not_shown_as_quality_pending():
    """5 Nov 2026: "list k alawa grn pending bhi na dikhayen" — a GRN dated
    on/before the count and not on its Waiting for QC list is taken as already
    in that stock: not quality pending, and never added."""
    p = _part()
    _grn(p, f"G-{p.id}-ON", date(2026, 10, 28), 4, accept=False)     # on the list
    _grn(p, f"G-{p.id}-OFF", date(2026, 10, 29), 6, accept=False)    # not on it
    _grn(p, f"G-{p.id}-NEW", date(2026, 11, 2), 2, accept=False)     # after the count
    _upload_with_qc([(p.part_no, 30, "01.11.2026")], [(p.part_no, "X", f"G-{p.id}-ON", "", 4, "")])
    states = {l["grn_no"]: l["state"] for l in ErpGrnPostingService().lines(STORE, part_id=p.id)}
    assert states == {f"G-{p.id}-ON": "QUALITY_PENDING", f"G-{p.id}-OFF": "SKIPPED",
                      f"G-{p.id}-NEW": "QUALITY_PENDING"}
    ReceivingRegister.query.filter(ReceivingRegister.item_cd == p.part_no).update(
        {"accept_qty": ReceivingRegister.receipt_qty}, synchronize_session=False)
    db.session.commit()
    ErpGrnPostingService().post(STORE)
    assert _on_hand(p) == 36                                          # + 4 (on the list) + 2 (after), never the 6
