"""Quality pending follows ERP's own figure (5 Nov 2026): ERP's current stock
holds per part what is still under inspection (under_insp). The newest GRN
lines with no accepted qty, up to it, are quality pending; an older one ERP
holds nothing of under inspection was cleared into ERP's stock though the SRV
line has no accepted qty (ERP often leaves it empty) — taken as accepted at
its receipt qty: added once if dated after the part's count, already in the
count if dated on/before it — unless ERP held it under inspection after that
count (noted on every read, and at an upload without a Waiting for QC list)."""
import io
from datetime import date, datetime, time

import pytest
from openpyxl import Workbook

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.base import utcnow
from app.models.erp_stock import ERPStock
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.spare_stock import SpareStock
from app.services.erp_grn_posting_service import PENDING_KEY, SETTING_KEY, SNAPSHOT_KEY, ErpGrnPostingService
from app.services.erp_sync_service import ERPSyncService
from app.services.spare_stock_service import SpareStockService

STORE = "MAINTENANCE"
_n = {"n": 0}


@pytest.fixture(autouse=True)
def _clean():
    AppSetting.set_value(SETTING_KEY, {"enabled": True, "from_date": "2026-08-01"})
    yield
    # Leave no ERP figure behind for the other test files sharing this database.
    ERPStock.query.filter(ERPStock.under_insp.isnot(None)).delete(synchronize_session=False)
    AppSetting.query.filter_by(key=PENDING_KEY).delete()
    AppSetting.query.filter_by(key=SNAPSHOT_KEY).delete()
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


def test_a_rejected_line_stays_rejected_and_a_part_erp_does_not_list_keeps_the_old_way():
    p, q = _part(), _part()
    _upload(p, 3, "01.10.2026")
    _grn(p, f"R-{p.id}", date(2026, 10, 10), 4, reject=4)
    _erp(p, 3, 0)
    assert _states(p) == {f"R-{p.id}": "REJECTED"}
    # A part ERP's current stock does not list is not read as "nothing under
    # inspection": ERP leaves out every item with 0 accepted stock, even with
    # material in QC (CNEI1500, 5 Nov 2026). The count rules decide for it.
    _upload(q, 2, "01.10.2026")
    _grn(q, f"Q-{q.id}", date(2026, 10, 12), 3)
    _grn(q, f"O-{q.id}", date(2026, 9, 25), 4)
    assert _states(q) == {f"Q-{q.id}": "QUALITY_PENDING", f"O-{q.id}": "SKIPPED"}
    ErpGrnPostingService().post(STORE)
    assert _on_hand(q) == 2                           # nothing guessed into stock


def test_each_grn_line_names_its_department_from_the_parts_section():
    """5 Nov 2026: "jo 5 grn pending h usme dept bhi h kya" — ERP's SRV copy has
    no GRN location, so the line carries the part's section and its group."""
    from app.models.store import Section, Store
    store = Store.query.filter_by(code=STORE).first()
    press = Section(store_id=store.id, name=f"Press Tool Room {_n['n']}", group_name="Tool Room")
    maint = Section(store_id=store.id, name=f"Maintenance {_n['n']}")
    db.session.add_all([press, maint])
    db.session.commit()
    p, q, r = _part(), _part(), _part()
    p.section_id, q.section_id = press.id, maint.id
    db.session.commit()
    for part in (p, q, r):
        _grn(part, f"DP-{part.id}", date(2026, 11, 3), 2)
    dept = {l["part_no"]: (l["dept"], l["section"]) for l in ErpGrnPostingService().lines(STORE)
            if l["grn_no"].startswith("DP-")}
    assert dept[p.part_no] == ("Tool Room", press.name)
    assert dept[q.part_no] == (maint.name, maint.name)
    assert dept[r.part_no] == (None, None)


# ---- ERP's figure is as of its nightly rebuild (12 Nov 2026) ----
# termsdb.current_stock is rebuilt once a night (created_at ~02:00) while GRN
# lines reach srv_report in the day: GRNs 1085 / 1086 (6 Nov) and 1090 / 1091
# (11 Nov) were added the same evening as "cleared" while ERP held them in QC.

def _snap(day):
    """ERP's current stock as rebuilt at 02:00 on `day`."""
    AppSetting.set_value(SNAPSHOT_KEY, {"mark": f"test-{day}", "seen_at": f"{day.isoformat()}T02:02:00",
                                        "taken_at": f"{day.isoformat()}T02:00:48"})


def _line(p, grn):
    return next(l for l in ErpGrnPostingService().lines(STORE, part_id=p.id) if l["grn_no"] == grn)


def test_a_grn_newer_than_erps_figure_is_quality_pending_until_the_next_rebuild():
    p = _part()
    _upload(p, 10, "01.11.2026")
    grn = f"N-{p.id}"
    _grn(p, grn, date(2026, 11, 6), 15)               # made on 6 Nov, after that night's rebuild
    _erp(p, 10, 0)                                    # the 02:00 figure cannot have it yet
    _snap(date(2026, 11, 6))
    line = _line(p, grn)
    assert line["state"] == "QUALITY_PENDING" and line["newer_than_erp_figure"]
    assert "06.11.2026" in line["reason"] and not line["accept_inferred"]
    ErpGrnPostingService().post(STORE)
    assert _on_hand(p) == 10                          # not added as "cleared"

    _snap(date(2026, 11, 7))                          # the next rebuild: ERP holds it in QC
    _erp(p, 10, 15)
    assert _line(p, grn)["state"] == "QUALITY_PENDING"
    ErpGrnPostingService().post(STORE)
    assert _on_hand(p) == 10

    _snap(date(2026, 11, 8))                          # quality cleared it; SRV still shows no accepted qty
    _erp(p, 25, 0)
    assert _line(p, grn)["state"] == "WILL_POST"
    ErpGrnPostingService().post(STORE)
    assert _on_hand(p) == 25


def test_a_new_grn_takes_none_of_the_figure_from_an_older_line():
    p = _part()
    _upload(p, 0, "01.11.2026")
    old, new = f"OL-{p.id}", f"NW-{p.id}"
    _grn(p, old, date(2026, 11, 5), 10)               # in the 6 Nov figure: ERP holds its 10 in QC
    _grn(p, new, date(2026, 11, 6), 10)               # made on 6 Nov: in no figure yet
    _erp(p, 0, 10)
    _snap(date(2026, 11, 6))
    assert _states(p) == {old: "QUALITY_PENDING", new: "QUALITY_PENDING"}
    assert _line(p, old)["under_inspection"] and not _line(p, new)["under_inspection"]
    ErpGrnPostingService().post(STORE)
    assert _on_hand(p) == 0


def test_every_erp_read_notes_when_erps_stock_was_rebuilt(monkeypatch):
    svc = ErpGrnPostingService
    rows = [{"item_cd": "A", "unit_cd": "10001", "clos_stock": "1", "under_insp": "0", "created_at": time(2, 0, 9)},
            {"item_cd": "B", "unit_cd": "10001", "clos_stock": "2", "under_insp": "1", "created_at": time(2, 0, 48)}]
    note = svc.record_snapshot(rows, now=datetime(2026, 11, 12, 19, 0))
    db.session.commit()
    assert note["taken_at"] == "2026-11-12T02:00:48" and svc.snapshot_day() == date(2026, 11, 12)
    # The same rows read the next day: ERP did not rebuild, so the figure is still of the 12th.
    svc.record_snapshot(rows, now=datetime(2026, 11, 13, 10, 0))
    db.session.commit()
    assert svc.snapshot_day() == date(2026, 11, 12)
    # New rows read at 01:00, before that night's 02:00: the rebuild was the day before.
    rows[0]["clos_stock"] = "3"
    svc.record_snapshot(rows, now=datetime(2026, 11, 14, 1, 0))
    db.session.commit()
    assert svc.snapshot_day() == date(2026, 11, 13)
    # Text times, as some drivers give them, read the same.
    rows[1].update(created_at="02:00:48.123456", clos_stock="9")
    assert svc.record_snapshot(rows, now=datetime(2026, 11, 14, 9, 0))["taken_at"] == "2026-11-14T02:00:48"
    db.session.commit()

    # The ERP read notes it: with created_at, and still reads the stock without it.
    p = _part()
    sync = ERPSyncService()
    erp_rows = [{"item_cd": p.part_no, "unit_cd": "10001", "clos_stock": "4", "under_insp": "0",
                 "created_at": time(2, 0, 30)}]
    asked = []

    def fetch(table, cols, **kw):
        asked.append(list(cols))
        return erp_rows
    monkeypatch.setattr(sync.erp, "fetch_rows", fetch)
    sync.sync_current_stock()
    assert "created_at" in asked[-1]
    assert AppSetting.get_value(SNAPSHOT_KEY)["taken_at"].endswith("T02:00:30")

    def no_created_at(table, cols, **kw):
        if "created_at" in cols:
            raise RuntimeError('column "created_at" does not exist')
        return [{k: v for k, v in dict(erp_rows[0], clos_stock="6").items() if k != "created_at"}]
    monkeypatch.setattr(sync.erp, "fetch_rows", no_created_at)
    sync.sync_current_stock()
    assert float(ERPStock.query.filter_by(part_id=p.id).one().qty_on_hand) == 6
    assert AppSetting.get_value(SNAPSHOT_KEY)["taken_at"] is None
    assert svc.snapshot_day() is not None             # from the app's last read instead


def _check_line(p, grn, qty=15):
    """A GRN added to stock that ERP then shows with no accepted qty, held in QC: "Check with ERP"."""
    _upload(p, 5, "01.11.2026")
    _grn(p, grn, date(2026, 11, 3), qty, accept=qty)
    _erp(p, 5 + qty, 0)
    _snap(date(2026, 11, 4))
    ErpGrnPostingService().post(STORE)
    assert _on_hand(p) == 5 + qty
    row = ReceivingRegister.query.filter_by(grn_no=grn).one()
    row.accept_qty = None
    db.session.commit()
    _erp(p, 5, qty)
    _snap(date(2026, 11, 5))
    assert _line(p, grn)["state"] == "CHECK"


def test_a_check_with_erp_line_is_taken_back_and_added_again_when_quality_accepts():
    from app.models.spare_flow import SpareTransaction
    from app.models.spare_stock import SpareStockLedger
    p = _part()
    grn = f"TB-{p.id}"
    _check_line(p, grn)
    done = ErpGrnPostingService().take_back(STORE, p.id, grn, user="store1")
    assert (done["qty"], done["stock_now"]) == (15, 5) and _on_hand(p) == 5
    back = SpareStockLedger.query.filter_by(part_id=p.id, reference=grn).order_by(SpareStockLedger.id.desc()).first()
    assert (back.txn_type, float(back.qty_delta), back.status, back.created_by) == ("RECEIPT", -15, "ERP_GRN", "store1")
    assert "still holds it under quality inspection" in back.remarks
    journal = SpareTransaction.query.filter_by(part_id=p.id, grn_no=grn).order_by(SpareTransaction.id.desc()).first()
    assert (journal.from_bucket, journal.to_bucket, float(journal.qty)) == ("AVAILABLE", "QUALITY_PENDING", 15)
    line = _line(p, grn)
    assert (line["state"], line["posted_qty"]) == ("QUALITY_PENDING", 0)
    ErpGrnPostingService().post(STORE)
    assert _on_hand(p) == 5                           # still in QC: not added again yet

    row = ReceivingRegister.query.filter_by(grn_no=grn).one()
    row.accept_qty = 15                               # quality accepts it in ERP
    db.session.commit()
    _erp(p, 20, 0)
    ErpGrnPostingService().post(STORE)
    assert _on_hand(p) == 20 and _line(p, grn)["state"] == "POSTED"


def test_take_back_is_refused_for_any_other_line_or_stock_already_gone():
    from app.utils.exceptions import BadRequestError
    p = _part()
    grn = f"TR-{p.id}"
    _check_line(p, grn, qty=10)
    stock = SpareStock.query.filter_by(part_id=p.id).one()
    stock.qty_on_hand = 4                             # most of it has gone out since
    db.session.commit()
    with pytest.raises(BadRequestError, match="Only 4"):
        ErpGrnPostingService().take_back(STORE, p.id, grn)
    assert _on_hand(p) == 4

    q = _part()
    _upload(q, 3, "01.11.2026")
    _grn(q, f"OK-{q.id}", date(2026, 11, 3), 2, accept=2)
    _erp(q, 5, 0)
    ErpGrnPostingService().post(STORE)
    with pytest.raises(BadRequestError, match="Check with ERP"):
        ErpGrnPostingService().take_back(STORE, q.id, f"OK-{q.id}")
    with pytest.raises(BadRequestError, match="No ERP GRN line"):
        ErpGrnPostingService().take_back(STORE, q.id, "NO-SUCH-GRN")


def test_the_take_back_route_needs_the_stock_edit_right():
    from flask import current_app

    from app.models.user import User, UserStoreAccess
    p = _part()
    grn = f"TA-{p.id}"
    _check_line(p, grn, qty=3)
    client = current_app.test_client()

    def login(name, perms):
        user = User(username=name, role="STORE_USER", is_active=True)
        user.set_password("pw")
        user.set_permissions(perms)
        db.session.add(user)
        db.session.flush()
        db.session.add(UserStoreAccess(user_id=user.id, store_code=STORE))
        db.session.commit()
        with client.session_transaction() as sess:
            sess["user_id"] = user.id

    url = f"/api/v1/erp-grn/take-back?store_code={STORE}"
    login(f"tbview{p.id}", {"store_stock": {"view": True}, "receiving": {"view": True}})
    assert client.post(url, json={"part_id": p.id, "grn_no": grn}).status_code == 403
    assert _on_hand(p) == 8
    login(f"tbedit{p.id}", {"store_stock": {"view": True, "update": True}})
    resp = client.post(url, json={"part_id": p.id, "grn_no": grn})
    assert resp.status_code == 200, resp.get_json()
    assert resp.get_json()["data"]["qty"] == 3 and _on_hand(p) == 5
    assert client.post(url, json={"grn_no": grn}).status_code == 400
