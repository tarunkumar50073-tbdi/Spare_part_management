"""Quality pending follows ERP's own figure (5 Nov 2026): ERP's current stock
holds per part what is still under inspection (under_insp). The newest GRN
lines with no accepted qty, up to it, are quality pending; an older one ERP
holds nothing of under inspection was cleared into ERP's stock though the SRV
line has no accepted qty (ERP often leaves it empty) — taken as accepted at
its receipt qty: added once if dated after the part's count, already in the
count if dated on/before it — unless ERP held it under inspection after that
count (noted on every read, and at an upload without a Waiting for QC list)."""
import io
from datetime import date

import pytest
from openpyxl import Workbook

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.base import utcnow
from app.models.erp_stock import ERPStock
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.spare_stock import SpareStock
from app.services.erp_grn_posting_service import PENDING_KEY, SETTING_KEY, ErpGrnPostingService
from app.services.erp_sync_service import ERPSyncService
from app.services.spare_stock_service import SpareStockService

STORE = "MAINTENANCE"
_n = {"n": 0}


@pytest.fixture(autouse=True)
def _clean():
    AppSetting.set_value(SETTING_KEY, {"enabled": True, "from_date": "2026-08-01"})
    yield
    # Once any part has ERP's figure, every part is read by it: leave none
    # behind for the other test files sharing this database.
    ERPStock.query.filter(ERPStock.under_insp.isnot(None)).delete(synchronize_session=False)
    AppSetting.query.filter_by(key=PENDING_KEY).delete()
    db.session.commit()


def _part():
    _n["n"] += 1
    p = Part(part_no=f"UI-{_n['n']}", part_name="UNDER INSPECTION SENSOR", uom="NOS", part_type="OTHER",
             store_code=STORE)
    db.session.add(p)
    db.session.commit()
    return p


def _grn(p, no, day, qty, accept=None, reject=None):
    db.session.add(ReceivingRegister(store_code="CHILD_PART", grn_no=no, grn_date=day, item_cd=p.part_no,
                                     receipt_qty=qty, accept_qty=accept, reject_qty=reject))
    db.session.commit()


def _erp(p, clos, under):
    row = ERPStock.query.filter_by(part_id=p.id).first()
    if row is None:
        db.session.add(ERPStock(part_id=p.id, qty_on_hand=clos, under_insp=under, synced_at=utcnow()))
    else:
        row.qty_on_hand, row.under_insp = clos, under
    db.session.commit()


def _upload(p, qty, day, qc=None):
    wb = Workbook()
    ws = wb.active
    ws.append(["Part No", "In Stock", "Counted On"])
    ws.append([p.part_no, qty, day])
    if qc is not None:
        tab = wb.create_sheet("Waiting for QC")
        tab.append(["Part No", "GRN No"])
        for grn in qc:
            tab.append([p.part_no, grn])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return SpareStockService().bulk_import(buf, store_code=STORE, user="sup")


def _on_hand(p):
    return float(SpareStock.query.filter_by(part_id=p.id).one().qty_on_hand)


def _states(p):
    return {l["grn_no"]: l["state"] for l in ErpGrnPostingService().lines(STORE, part_id=p.id)}


def test_the_erp_read_keeps_the_under_inspection_figure(monkeypatch):
    p = _part()
    svc = ERPSyncService()
    rows = [{"item_cd": p.part_no, "clos_stock": "2", "under_insp": "5"},
            {"item_cd": p.part_no.lower(), "clos_stock": "1", "under_insp": "0"}]
    monkeypatch.setattr(svc.erp, "fetch_rows", lambda table, cols, **kw: rows)
    svc.sync_current_stock()
    row = ERPStock.query.filter_by(part_id=p.id).one()
    assert float(row.qty_on_hand) == 3 and float(row.under_insp) == 5
    rows[0]["under_insp"] = "0"                 # quality cleared it
    svc.sync_current_stock()
    assert float(ERPStock.query.filter_by(part_id=p.id).one().under_insp) == 0


def test_only_what_erp_holds_under_inspection_is_quality_pending():
    p = _part()
    _upload(p, 10, "01.10.2026")
    _grn(p, f"A-{p.id}", date(2026, 9, 20), 7)      # before the count, cleared in ERP: in the count
    _grn(p, f"B-{p.id}", date(2026, 10, 20), 20)    # after it, cleared in ERP with no accepted qty
    _grn(p, f"C-{p.id}", date(2026, 11, 3), 5)      # ERP holds 5 under inspection: this one
    _erp(p, 30, 5)
    assert _states(p) == {f"A-{p.id}": "SKIPPED", f"B-{p.id}": "WILL_POST", f"C-{p.id}": "QUALITY_PENDING"}
    line = next(l for l in ErpGrnPostingService().lines(STORE, part_id=p.id) if l["grn_no"] == f"B-{p.id}")
    assert line["accept_inferred"] and line["accept_qty"] == 20 and "receipt qty" in line["reason"]
    ErpGrnPostingService().post(STORE)
    assert _on_hand(p) == 30                          # + B once, never A, not C yet
    ErpGrnPostingService().post(STORE)
    assert _on_hand(p) == 30


def test_a_line_held_after_the_count_is_added_when_quality_clears_it():
    p = _part()
    _grn(p, f"D-{p.id}", date(2026, 11, 3), 5)      # under inspection at the count
    _grn(p, f"E-{p.id}", date(2026, 11, 2), 8)      # already cleared into ERP's stock
    _erp(p, 8, 5)
    report = _upload(p, 8, "04.11.2026")             # no Waiting for QC tab: ERP's figure is the list
    assert report["qc_waiting_noted"] == 1 and report["qc_waiting_source"] == "erp"
    assert _states(p) == {f"D-{p.id}": "QUALITY_PENDING", f"E-{p.id}": "SKIPPED"}
    ErpGrnPostingService().post(STORE)
    assert _on_hand(p) == 8

    _erp(p, 13, 0)                                    # quality clears D; the SRV line still has no accepted qty
    assert _states(p)[f"D-{p.id}"] == "WILL_POST"
    ErpGrnPostingService().post(STORE)
    assert _on_hand(p) == 13
    assert _states(p) == {f"D-{p.id}": "POSTED", f"E-{p.id}": "SKIPPED"}


def test_every_erp_read_notes_what_erp_still_holds_under_inspection():
    p = _part()
    _upload(p, 4, "04.11.2026", qc=[])               # an empty list given: nothing noted at the upload
    _grn(p, f"F-{p.id}", date(2026, 11, 4), 6)        # GRN made later on the count day
    _erp(p, 4, 6)
    ErpGrnPostingService().post(STORE)                # the read notes it
    _erp(p, 10, 0)
    ErpGrnPostingService().post(STORE)
    assert _on_hand(p) == 10


def test_a_rejected_line_stays_rejected_and_an_unread_part_keeps_the_old_way():
    p, q = _part(), _part()
    _upload(p, 3, "01.10.2026")
    _grn(p, f"R-{p.id}", date(2026, 10, 10), 4, reject=4)
    _erp(p, 3, 0)
    assert _states(p) == {f"R-{p.id}": "REJECTED"}
    # With ERP's figure read for some part, a part ERP's stock does not list
    # holds nothing under inspection.
    _upload(q, 2, "01.10.2026")
    _grn(q, f"Q-{q.id}", date(2026, 10, 12), 3)
    assert _states(q) == {f"Q-{q.id}": "WILL_POST"}
