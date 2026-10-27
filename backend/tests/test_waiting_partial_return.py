"""The Waiting list (Confirm Installation) and an issue partly returned before
anyone confirmed it — store, 16 Oct 2026: "Waiting list wali kami theek karo".

The store issues 3, the user sends 1 back before confirming where the other 2
went: the issue turns PARTIALLY_RETURNED, yet 2 are still out and unconfirmed,
so it must stay under Waiting (with "1 returned · 2 still out") until the fitter
confirms those 2 — and every count of that queue (alerts bell, dashboard tile,
management board / attention pop-up, Work Queue) must agree with the list.

Each test seeds its own store: the session DB is shared, and MAINTENANCE holds
every other test's issues.
"""
import pytest

from app.extensions import db
from app.models.part import Part
from app.models.spare_stock import SpareStockLedger
from app.models.store import Section, Store
from app.services.scan_result_service import ScanResultService
from app.services.spare_alerts_service import SpareAlertsService
from app.services.spare_dashboard_service import SpareDashboardService
from app.services.spare_management_service import SpareManagementService
from app.services.spare_stock_service import SpareStockService
from app.utils.exceptions import BadRequestError

_seq = {"n": 0}


def _next():
    _seq["n"] += 1
    return _seq["n"]


@pytest.fixture()
def store():
    n = _next()
    s = Store(code=f"WAIT{n}", name=f"Waiting Test Store {n}", sort_order=950)
    db.session.add(s)
    db.session.commit()
    sec = Section(store_id=s.id, name=f"Waiting Section {n}")
    db.session.add(sec)
    db.session.commit()
    yield s, sec
    # Leave no extra ACTIVE store behind for tests that reason about store visibility.
    s.is_active = False
    db.session.commit()


def _part(store, stock=10):
    s, sec = store
    p = Part(part_no=f"WT-{_next()}", part_name="Waiting part", uom="NO", part_type="OTHER",
             store_code=s.code, section_id=sec.id, location="R1-S1-B1")
    db.session.add(p)
    db.session.commit()
    SpareStockService().set_quantity(p.id, float(stock), txn_type="OPENING")
    return p


def _issue(part, qty=3):
    res = SpareStockService().issue(part.id, qty, "Maintenance", issued_to="Ravi")
    return res["issue"]["id"]


def _waiting(code):
    return {r["id"]: r for r in SpareStockService().pending_confirmations(code)}


def test_partial_return_before_confirmation_keeps_it_waiting(store):
    p = _part(store)
    lid = _issue(p, 3)
    SpareStockService().return_item(lid, qty=1, reason="Excess / Not Required")
    assert db.session.get(SpareStockLedger, lid).status == "PARTIALLY_RETURNED"

    row = _waiting(store[0].code)[lid]
    assert (row["qty"], row["issued_qty"], row["returned_qty"], row["outstanding_qty"]) == (3, 3, 1, 2)
    assert row["status"] == "PARTIALLY_RETURNED" and row["confirmed_at"] is None
    # The part's own queue (Part Overview) reads the same rule.
    per_part = SpareStockService().pending_confirmations_for_part(p.id)
    assert [(r["id"], r["outstanding_qty"]) for r in per_part] == [(lid, 2)]


def test_confirming_what_is_still_out_works_and_leaves_waiting(store):
    p = _part(store)
    lid = _issue(p, 3)
    svc = SpareStockService()
    svc.return_item(lid, qty=1, reason="Excess / Not Required")

    # More than is still out is refused — 1 already came back.
    with pytest.raises(BadRequestError, match="at most 2"):
        svc.confirm_installation(lid, machine="MC-1", actual_qty=3)
    res = svc.confirm_installation(lid, line_name="Seat Slider", machine="MC-1", actual_qty=2, user="fitter")
    assert (res["status"], res["returned_qty"], res["outstanding_qty"]) == ("INSTALLED", 1, 2)
    row = db.session.get(SpareStockLedger, lid)
    assert row.status == "INSTALLED" and float(row.actual_qty) == 2 and row.confirmed_at is not None
    assert lid not in _waiting(store[0].code)
    # It moved to the Installed tab.
    assert lid in [r["id"] for r in svc.installations(store[0].code)]


def test_confirming_part_of_what_is_still_out_is_partly_used(store):
    p = _part(store)
    lid = _issue(p, 3)
    svc = SpareStockService()
    svc.return_item(lid, qty=1, reason="Excess / Not Required")
    res = svc.confirm_installation(lid, machine="MC-2", actual_qty=1)
    assert res["status"] == "PARTIALLY_USED"
    assert lid not in _waiting(store[0].code)


def test_a_full_return_removes_it_from_waiting(store):
    p = _part(store)
    svc = SpareStockService()
    in_two = _issue(p, 3)
    svc.return_item(in_two, qty=1, reason="Excess / Not Required")
    assert in_two in _waiting(store[0].code)
    svc.return_item(in_two, qty=2, reason="Excess / Not Required")
    assert db.session.get(SpareStockLedger, in_two).status == "RETURNED"
    assert in_two not in _waiting(store[0].code)

    at_once = _issue(p, 2)
    svc.return_item(at_once)   # everything still out
    assert db.session.get(SpareStockLedger, at_once).status == "RETURNED"
    assert at_once not in _waiting(store[0].code)
    assert SpareStockService().pending_confirmations_for_part(p.id) == []


def test_a_confirmed_issue_partly_returned_stays_off_waiting(store):
    p = _part(store)
    svc = SpareStockService()
    lid = _issue(p, 3)
    svc.confirm_installation(lid, machine="MC-3")          # all 3 fitted
    svc.return_item(lid, qty=1, reason="Machine Change")   # one taken off again
    row = db.session.get(SpareStockLedger, lid)
    assert row.status == "PARTIALLY_RETURNED" and row.confirmed_at is not None
    assert lid not in _waiting(store[0].code)
    assert SpareStockService().pending_confirmations_for_part(p.id) == []


def test_cancelled_and_legacy_fully_returned_rows_never_wait(store):
    p = _part(store)
    cancelled = _issue(p, 1)
    db.session.get(SpareStockLedger, cancelled).status = "CANCELLED"
    # A PARTIALLY_RETURNED row whose returns already cover it (old data):
    # nothing is still out, so nothing waits.
    legacy = _issue(p, 2)
    db.session.get(SpareStockLedger, legacy).status = "PARTIALLY_RETURNED"
    db.session.add(SpareStockLedger(part_id=p.id, qty_delta=2, balance_after=9, txn_type="RETURN",
                                    return_of_id=legacy))
    db.session.commit()
    waiting = _waiting(store[0].code)
    assert cancelled not in waiting and legacy not in waiting


def test_no_screen_counts_the_waiting_list_any_more(store):
    """Confirm Installation was taken out on 27 Oct 2026 ("haan teeno hata de"):
    the bell, the dashboard, the Live Board tracker and the Work Queue no longer
    count issues waiting for a fitter. The list itself still reads."""
    code = store[0].code
    svc = SpareStockService()
    p, q = _part(store), _part(store)
    plain = _issue(p, 1)                     # waiting, nothing back
    partly = _issue(p, 3)                    # waiting, 1 back, 2 still out
    svc.return_item(partly, qty=1, reason="Excess / Not Required")
    confirmed_then_back = _issue(q, 3)       # fitted, then 1 back: not waiting
    svc.confirm_installation(confirmed_then_back, machine="MC-4")
    svc.return_item(confirmed_then_back, qty=1, reason="Machine Change")
    all_back = _issue(q, 2)                  # all returned: not waiting
    svc.return_item(all_back)

    assert set(_waiting(code)) == {plain, partly}
    alerts = {a["id"] for a in SpareAlertsService().alerts(code)["alerts"]}
    assert not any(a.startswith("confirm_pending") for a in alerts)
    assert "confirm_pending" not in {a["key"] for a in SpareDashboardService().overview(code)["attention"]}
    tracker = SpareManagementService().management(code)["tracker"]["items"]
    assert "confirm_pending" not in {it["key"] for it in tracker}
    assert "awaiting_confirmation" not in ScanResultService().queues(code)["counts"]
