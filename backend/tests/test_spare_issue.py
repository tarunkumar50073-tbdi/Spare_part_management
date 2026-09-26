"""Spare issue flow (new feature): issuing a spare to a department writes an
ISSUE ledger row tagged with the department, deducts on-hand, and feeds
Department-wise Consumption. Refuses to over-issue below zero.

Since the QR traceability flow (spec 9 / 13 / 14) a return is held for the
store inspection — on-hand moves only when the inspection passes it as GOOD —
and a physical receive records a receipt instead of adding stock.
"""
import pytest

from app.extensions import db
from app.models.part import Part
from app.models.spare_flow import SpareReceipt, SpareReturn
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.models.user import User, UserStoreAccess
from app.services.spare_receipt_service import ReceivingInErpError
from app.services.spare_return_service import SpareReturnService
from app.services.spare_stock_service import SpareStockService
from app.utils.exceptions import BadRequestError, NotFoundError

_seq = {"n": 0}


def _part(store_code="MAINTENANCE"):
    _seq["n"] += 1
    p = Part(part_no=f"IS-{_seq['n']}", part_name=f"Issue Part {_seq['n']}", uom="NO",
             part_type="OTHER", store_code=store_code)
    db.session.add(p)
    db.session.commit()
    return p


def _set_physical(part_id, qty):
    SpareStockService().set_quantity(part_id, float(qty), txn_type="OPENING")


def _on_hand(part_id):
    row = SpareStock.query.filter_by(part_id=part_id).first()
    return float(row.qty_on_hand) if row else 0.0


def _dept_total(rows, name):
    return next((r["value"] for r in rows if r["name"] == name), 0.0)


@pytest.fixture()
def client(app):
    return app.test_client()


def test_issue_deducts_and_tags_department():
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 20)

    svc.issue(p.id, 5, "Press Shop", reference="WO-1", remarks="die repair")

    assert _on_hand(p.id) == 15.0
    row = SpareStockLedger.query.filter_by(part_id=p.id, txn_type="ISSUE").first()
    assert row is not None
    assert float(row.qty_delta) == -5.0
    assert row.department == "Press Shop"


def test_issue_hands_back_its_row_and_journals_it():
    """The response carries the ISSUE row just written (the id installation and
    return point at), and one journal ISSUE row names it as issue and ledger."""
    from app.models.spare_flow import SpareTransaction
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 6)
    res = svc.issue(p.id, 2, "Tool Room", issued_to="Asha", user="storekpr",
                    scanned_code=p.part_no, scan_source="USB_SCANNER")
    assert res["qty_on_hand"] == 4.0
    lid = _last_issue_id(p.id)
    assert res["issue"]["id"] == lid and res["issue"]["qty"] == 2.0
    assert res["issue"]["status"] == "PENDING_USER_CONFIRMATION"
    j = SpareTransaction.query.filter_by(part_id=p.id, txn_type="ISSUE").one()
    assert (j.issue_id, j.ledger_id) == (lid, lid)
    assert (j.from_bucket, j.to_bucket) == ("AVAILABLE", "ISSUED")
    assert (j.department, j.issued_to, j.created_by) == ("Tool Room", "Asha", "storekpr")
    assert (j.scanned_code, j.scan_source) == (p.part_no, "USB_SCANNER")


def test_issue_more_than_on_hand_is_rejected():
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 4)
    with pytest.raises(BadRequestError):
        svc.issue(p.id, 10, "Maintenance")
    assert _on_hand(p.id) == 4.0  # unchanged — the deduction rolled back


def test_issue_invalid_department_is_rejected():
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 10)
    with pytest.raises(BadRequestError):
        svc.issue(p.id, 1, "Canteen")


def test_consumption_by_department_accumulates():
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 50)
    before = _dept_total(svc.consumption_by_department("MAINTENANCE"), "Tool Room")
    svc.issue(p.id, 7, "Tool Room")
    after = _dept_total(svc.consumption_by_department("MAINTENANCE"), "Tool Room")
    assert after - before == 7.0


def test_issue_route_enforces_store_access(client):
    _seq["n"] += 1
    user = User(username=f"issueuser{_seq['n']}", role="STORE_USER", is_active=True)
    user.set_password("pw")
    db.session.add(user)
    db.session.flush()
    db.session.add(UserStoreAccess(user_id=user.id, store_code="CHILD_PART"))  # not MAINTENANCE
    part = _part("MAINTENANCE")
    db.session.commit()

    with client.session_transaction() as sess:
        sess["user_id"] = user.id
    resp = client.post(f"/api/v1/spare-stock/parts/{part.id}/issue",
                       json={"qty": 1, "department": "Press Shop"})
    assert resp.status_code == 403


def test_issue_records_machine_and_machine_consumption():
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 30)

    svc.issue(p.id, 6, "Maintenance", machine="PRESS-05")
    row = SpareStockLedger.query.filter_by(part_id=p.id, txn_type="ISSUE").first()
    assert row.machine == "PRESS-05"

    before = _dept_total(svc.consumption_by_machine("MAINTENANCE"), "PRESS-05")
    svc.issue(p.id, 4, "Maintenance", machine="PRESS-05")
    after = _dept_total(svc.consumption_by_machine("MAINTENANCE"), "PRESS-05")
    assert after - before == 4.0

    assert "PRESS-05" in svc.machines_used("MAINTENANCE")


def test_returnable_issue_is_outstanding_then_returns():
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 10)

    svc.issue(p.id, 2, "Tool Room", machine="DIE-3", returnable=True)
    assert _on_hand(p.id) == 8.0

    mine = [r for r in svc.outstanding_returnables("MAINTENANCE") if r["part_no"] == p.part_no]
    assert len(mine) == 1
    assert mine[0]["machine"] == "DIE-3" and mine[0]["qty"] == 2.0
    assert mine[0]["outstanding_qty"] == 2.0
    ledger_id = mine[0]["id"]

    res = svc.return_item(ledger_id)                    # bring it back
    assert _on_hand(p.id) == 8.0                         # held for inspection, not stock yet
    assert not any(r["id"] == ledger_id for r in svc.outstanding_returnables("MAINTENANCE"))

    with pytest.raises(BadRequestError):                # can't return twice
        svc.return_item(ledger_id)

    SpareReturnService().inspect(res["return"]["id"], "GOOD", 2)
    assert _on_hand(p.id) == 10.0                        # the inspection restores it


def test_non_returnable_issue_is_not_outstanding():
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 5)
    svc.issue(p.id, 1, "Maintenance", returnable=False)
    assert not any(r["part_no"] == p.part_no for r in svc.outstanding_returnables("MAINTENANCE"))


def _last_issue_id(part_id):
    row = (SpareStockLedger.query
           .filter_by(part_id=part_id, txn_type="ISSUE")
           .order_by(SpareStockLedger.id.desc()).first())
    return row.id


# ---- store return slip (a department sending an issued part back) ----

def test_return_goes_to_inspection_and_good_puts_it_back():
    """The user's case: an ordinary part is issued, does not fit, and the dept
    sends it back — even though it was never flagged returnable. It is recorded
    against the original issue and held for inspection (spec 13/14): on-hand
    moves only when the inspection passes it as GOOD."""
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 10)
    svc.issue(p.id, 3, "Press Shop", returnable=False)  # a plain issue
    lid = _last_issue_id(p.id)

    res = svc.return_item(lid, reason="Fitment Issue", returned_by="Ramesh", user="storekpr")
    assert _on_hand(p.id) == 7.0                         # not stock until inspected
    assert res["returned_qty"] == 3.0
    assert res["return_no"].startswith("RET-")           # a return number was raised
    assert res["issue_status"] == "RETURNED"
    doc = res["return"]
    assert doc["status"] == "INSPECTION_PENDING" and doc["qty_pending"] == 3.0
    assert doc["issue_id"] == lid and doc["department"] == "Press Shop"
    assert doc["reason"] == "Fitment Issue" and doc["returned_by"] == "Ramesh"
    assert not SpareStockLedger.query.filter_by(part_id=p.id, txn_type="RETURN").count()
    assert db.session.get(SpareStockLedger, lid).status == "RETURNED"

    SpareReturnService().inspect(doc["id"], "GOOD", 3, user="storekpr")
    assert _on_hand(p.id) == 10.0                        # all 3 back on the shelf
    ret = SpareStockLedger.query.filter_by(part_id=p.id, txn_type="RETURN").one()
    assert ret.return_no == res["return_no"]
    assert ret.return_reason == "Fitment Issue"
    assert ret.returned_by == "Ramesh"
    assert float(ret.qty_delta) == 3.0                   # positive — stock came in
    assert ret.return_of_id == lid
    assert ret.status == "INSPECTED_GOOD"


def test_partial_return_leaves_remainder_outstanding():
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 10)
    svc.issue(p.id, 6, "Maintenance")
    lid = _last_issue_id(p.id)

    r1 = svc.return_item(lid, qty=4, reason="Excess / Not Required")
    assert _on_hand(p.id) == 4.0                          # held for inspection
    assert r1["issue_status"] == "PARTIALLY_RETURNED"

    out = next(r for r in svc.returnable_issues_for_part(p.id) if r["id"] == lid)
    assert out["outstanding_qty"] == 2.0 and out["returned_qty"] == 4.0

    r2 = svc.return_item(lid, qty=2, reason="Excess / Not Required")
    assert _on_hand(p.id) == 4.0                          # still nothing inspected
    assert r2["issue_status"] == "RETURNED"
    assert not any(r["id"] == lid for r in svc.returnable_issues_for_part(p.id))


def test_cannot_return_more_than_is_out():
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 5)
    svc.issue(p.id, 2, "Tool Room")
    lid = _last_issue_id(p.id)
    with pytest.raises(BadRequestError):
        svc.return_item(lid, qty=5)          # only 2 are out
    assert _on_hand(p.id) == 3.0             # nothing credited
    assert not SpareReturn.query.filter_by(issue_id=lid).count()


def test_installed_issue_can_be_returned():
    """An installed part can be removed from the machine and sent back: what is
    still out is issued - returned, whatever was fitted. It still waits for
    inspection before it is stock again."""
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 10)
    svc.issue(p.id, 3, "Maintenance")
    lid = _last_issue_id(p.id)
    svc.confirm_installation(lid, machine="M-1", actual_qty=3)   # all fitted
    res = svc.return_item(lid, reason="Machine Change")
    assert res["returned_qty"] == 3.0 and res["issue_status"] == "RETURNED"
    assert _on_hand(p.id) == 7.0


def test_partially_used_issue_can_return_everything_still_out():
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 10)
    svc.issue(p.id, 5, "Maintenance")
    lid = _last_issue_id(p.id)
    svc.confirm_installation(lid, machine="M-2", actual_qty=2)   # 2 fitted, 3 spare

    out = next(r for r in svc.returnable_issues_for_part(p.id) if r["id"] == lid)
    assert out["outstanding_qty"] == 5.0     # fitted parts can come off the machine too
    assert out["consumed_qty"] == 2.0 and out["actual_qty"] == 2.0   # informational
    assert out["machine"] == "M-2"
    res = svc.return_item(lid, reason="Fitment Issue")
    assert res["returned_qty"] == 5.0
    assert _on_hand(p.id) == 5.0            # 10 - 5 issued; the return waits for inspection


def test_return_numbers_are_sequential_and_never_reused():
    svc = SpareStockService()
    a = _part(); _set_physical(a.id, 5)
    b = _part(); _set_physical(b.id, 5)
    svc.issue(a.id, 1, "Maintenance"); n1 = svc.return_item(_last_issue_id(a.id), reason="Wrong Part")["return_no"]
    svc.issue(b.id, 1, "Maintenance"); n2 = svc.return_item(_last_issue_id(b.id), reason="Wrong Part")["return_no"]
    nos = [r.return_no for r in SpareReturn.query.all()]
    assert len(set(nos)) == len(nos)        # no number reused
    assert n1.startswith("RET-") and n2.startswith("RET-")
    assert int(n2.rsplit("-", 1)[1]) > int(n1.rsplit("-", 1)[1])


def test_cancelled_issue_cannot_be_returned():
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 5)
    svc.issue(p.id, 2, "Maintenance")
    lid = _last_issue_id(p.id)
    issue = SpareStockLedger.query.get(lid)
    issue.status = "CANCELLED"; db.session.commit()
    with pytest.raises(BadRequestError):
        svc.return_item(lid)


def test_receive_by_hand_is_gone_and_adds_nothing():
    """Receiving, the GRN and the quality clearance are done in ERP and read
    from it (ErpGrnPostingService): a manual receive is refused (410) and
    records nothing."""
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 5)
    with pytest.raises(ReceivingInErpError):
        svc.receive(p.id, 8, reference="GRN-77", user="storeman")
    assert _on_hand(p.id) == 5.0
    assert not SpareStockLedger.query.filter_by(part_id=p.id, txn_type="RECEIPT").count()
    assert SpareReceipt.query.filter_by(part_id=p.id).count() == 0


def test_scan_resolves_by_part_no_and_is_store_scoped():
    svc = SpareStockService()
    p = _part()  # in MAINTENANCE
    row = svc.resolve_scan("MAINTENANCE", p.part_no)
    assert row["part_no"] == p.part_no

    with pytest.raises(NotFoundError):        # same code, wrong store
        svc.resolve_scan("CHILD_PART", p.part_no)
    with pytest.raises(NotFoundError):        # unknown code
        svc.resolve_scan("MAINTENANCE", "NO-SUCH-CODE")


def _receipt_row(part_id, qty, status):
    """A RECEIPT ledger row with the given status: a legacy direct receive
    (PHYSICALLY_RECEIVED / None) or an ERP-origin one (STOCK_AVAILABLE after a
    quality clearance, RGP_GRN after an RGP GRN)."""
    svc = SpareStockService()
    row = svc.repo.get_or_create(part_id)
    _, _, ledger = svc._write(part_id, round(float(row.qty_on_hand or 0) + qty, 2), "RECEIPT",
                              extra={"status": status}, return_ledger=True)
    db.session.commit()
    return ledger.id


def test_movements_are_pending_erp_until_synced():
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 10)
    before = svc.pending_erp_count("MAINTENANCE")

    svc.issue(p.id, 2, "Maintenance")
    _receipt_row(p.id, 3, "PHYSICALLY_RECEIVED")               # a legacy direct receive
    after = svc.pending_erp_count("MAINTENANCE")
    assert after - before == 2  # the ISSUE and the legacy RECEIPT are both pending

    # ERP endpoint not configured -> nothing pushed, everything stays pending
    res = svc.sync_pending_to_erp("MAINTENANCE")
    assert res["configured"] is False
    assert svc.pending_erp_count("MAINTENANCE") == after


def test_erp_origin_receipts_are_never_pending_erp():
    """A quality clearance / RGP GRN RECEIPT came in through the supervisor's
    ERP GRN — pushing it would add it to ERP a second time. Legacy RECEIPT rows
    (another status or none) are still pushed."""
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 10)
    before = svc.pending_erp_count("MAINTENANCE")
    cleared = _receipt_row(p.id, 4, "STOCK_AVAILABLE")
    rgp_grn = _receipt_row(p.id, 1, "RGP_GRN")
    no_status = _receipt_row(p.id, 2, None)
    assert svc.pending_erp_count("MAINTENANCE") - before == 1   # only the NULL-status row
    ids = {r["id"] for r in svc.pending_erp_movements("MAINTENANCE")}
    assert no_status in ids and cleared not in ids and rgp_grn not in ids


def test_reorder_list_suggests_qty_up_to_max():
    svc = SpareStockService()
    _seq["n"] += 1
    p = Part(part_no=f"RO-{_seq['n']}", part_name="Reorder Part", uom="NO",
             part_type="OTHER", store_code="MAINTENANCE", min_stock_level=10, max_stock_level=30)
    db.session.add(p); db.session.commit()
    _set_physical(p.id, 4)  # below the minimum of 10

    res = svc.reorder_list("MAINTENANCE")
    mine = [r for r in res["items"] if r["part_no"] == p.part_no]
    assert len(mine) == 1
    assert mine[0]["reorder_qty"] == 26  # bring 4 back up to max 30
    assert mine[0]["status"] == "Below Minimum"


def test_reorder_level_triggers_reorder_status_above_minimum():
    """At/below the reorder level but still above minimum -> a "Reorder" status
    (a step short of critical), and it enters the reorder feed refilling to max."""
    svc = SpareStockService()
    _seq["n"] += 1
    p = Part(part_no=f"ROL-{_seq['n']}", part_name="Reorder Level Part", uom="NO",
             part_type="OTHER", store_code="MAINTENANCE",
             min_stock_level=10, reorder_level=20, max_stock_level=30)
    db.session.add(p); db.session.commit()
    _set_physical(p.id, 15)  # above min (10), at/below reorder level (20)

    mine = next(r for r in svc.list_stock("MAINTENANCE") if r["part_no"] == p.part_no)
    assert mine["status"] == "Reorder"
    assert mine["reorder_level"] == 20

    item = next(r for r in svc.reorder_list("MAINTENANCE")["items"] if r["part_no"] == p.part_no)
    assert item["reorder_qty"] == 15  # 30 - 15

    summ = svc.get_summary("MAINTENANCE")
    assert summ["reorder"] >= 1 and summ["needs_reordering"] >= 1


def test_below_minimum_beats_reorder_when_under_min():
    """Precedence: under the minimum stays Below Minimum even with a reorder level set."""
    svc = SpareStockService()
    _seq["n"] += 1
    p = Part(part_no=f"ROL2-{_seq['n']}", part_name="Critical Part", uom="NO",
             part_type="OTHER", store_code="MAINTENANCE",
             min_stock_level=10, reorder_level=20, max_stock_level=30)
    db.session.add(p); db.session.commit()
    _set_physical(p.id, 8)  # under the minimum
    mine = next(r for r in svc.list_stock("MAINTENANCE") if r["part_no"] == p.part_no)
    assert mine["status"] == "Below Minimum"


def test_today_issues_lists_shift_issues_and_ties_to_summary():
    """The Today's-Issue drill rows must tie out to the card: one row per issue
    line since shift start, qty summing to issued_qty."""
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 20)
    svc.issue(p.id, 3, "Press Shop")
    svc.issue(p.id, 2, "Maintenance")

    rows = svc.today_issues("MAINTENANCE")
    mine = [r for r in rows if r["part_no"] == p.part_no]
    assert len(mine) == 2
    assert all(r["txn_type"] == "ISSUE" for r in mine)
    assert {abs(r["qty_delta"]) for r in mine} == {3.0, 2.0}

    summ = svc.today_movements("MAINTENANCE")
    # Row count == issued_lines and qty magnitude == issued_qty for these two.
    assert sum(1 for r in rows if r["part_no"] == p.part_no) == 2
    assert summ["issued_lines"] >= 2 and summ["issued_qty"] >= 5.0


def test_pending_erp_movements_match_the_count():
    """The Pending-ERP drill list length equals the Pending-ERP count."""
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 20)
    svc.issue(p.id, 4, "Maintenance")
    _receipt_row(p.id, 6, "PHYSICALLY_RECEIVED")   # legacy direct receive: pending
    _receipt_row(p.id, 2, "STOCK_AVAILABLE")       # quality clearance: never pushed

    count = svc.pending_erp_count("MAINTENANCE")
    rows = svc.pending_erp_movements("MAINTENANCE")
    assert len(rows) == count
    # Only stock movements (never OPENING/ADJUSTMENT) are pending.
    assert all(r["txn_type"] in ("ISSUE", "RECEIPT", "RETURN") for r in rows)
    mine = [r for r in rows if r["part_no"] == p.part_no]
    assert sorted(r["txn_type"] for r in mine) == ["ISSUE", "RECEIPT"]


def test_consumption_trend_has_a_point_per_day_and_counts_issue():
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 50)
    before = sum(d["qty"] for d in svc.consumption_trend("MAINTENANCE", days=7))
    svc.issue(p.id, 9, "Maintenance")
    trend = svc.consumption_trend("MAINTENANCE", days=7)
    assert len(trend) == 7                       # one point for every day, gaps filled with 0
    assert sum(d["qty"] for d in trend) - before == 9.0


def test_top_consumed_ranks_by_issued_quantity():
    svc = SpareStockService()
    a = _part(); _set_physical(a.id, 100)
    b = _part(); _set_physical(b.id, 100)
    svc.issue(a.id, 30, "Tool Room")
    svc.issue(b.id, 5, "Tool Room")
    top = svc.top_consumed("MAINTENANCE", limit=100, days=30)
    qa = next((r["qty"] for r in top if r["part_no"] == a.part_no), 0)
    assert qa >= 30.0
    order = {r["part_no"]: i for i, r in enumerate(top)}
    assert order.get(a.part_no, 10 ** 9) < order.get(b.part_no, 10 ** 9 + 1)  # 30 ranks above 5


def test_consumption_window_scopes_breakdowns_to_recent_days():
    """The Day/Week/Month/Year picker: consumption_by_department(days=N) counts
    only issues inside the last N days, while days=None stays all-time. Deltas,
    because the store's totals accumulate across the shared test DB."""
    from datetime import datetime, timedelta
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 50)

    base_all = _dept_total(svc.consumption_by_department("MAINTENANCE"), "Maintenance")
    base_week = _dept_total(svc.consumption_by_department("MAINTENANCE", days=7), "Maintenance")

    svc.issue(p.id, 3, "Maintenance")   # recent — inside every window
    svc.issue(p.id, 9, "Maintenance")   # backdated below to fall outside a short window
    old = (SpareStockLedger.query
           .filter_by(part_id=p.id, txn_type="ISSUE")
           .filter(SpareStockLedger.qty_delta == -9)
           .first())
    old.created_at = datetime.utcnow() - timedelta(days=400)
    db.session.commit()

    all_after = _dept_total(svc.consumption_by_department("MAINTENANCE"), "Maintenance")
    week_after = _dept_total(svc.consumption_by_department("MAINTENANCE", days=7), "Maintenance")
    year_after = _dept_total(svc.consumption_by_department("MAINTENANCE", days=365), "Maintenance")

    assert all_after - base_all == 12.0    # both issues in the all-time view
    assert week_after - base_week == 3.0   # only the recent one in the 7-day window
    assert year_after - base_week == 3.0   # 400 days back is outside a year too


def test_consumption_date_range_scopes_to_the_calendar_window():
    """The Consumption calendar picker: consumption_by_department(date_from,
    date_to) counts only issues whose date falls inside [from, to]."""
    from datetime import datetime
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 100)

    window = ("2000-01-01", "2000-01-31")
    base = _dept_total(svc.consumption_by_department("MAINTENANCE", None, None, *window), "Tool Room")

    svc.issue(p.id, 5, "Tool Room")   # dated today — outside the Jan-2000 window
    svc.issue(p.id, 8, "Tool Room")   # backdated into the window below
    old = (SpareStockLedger.query
           .filter_by(part_id=p.id, txn_type="ISSUE")
           .filter(SpareStockLedger.qty_delta == -8)
           .first())
    old.created_at = datetime(2000, 1, 15, 10, 0, 0)
    db.session.commit()

    inside = _dept_total(svc.consumption_by_department("MAINTENANCE", None, None, *window), "Tool Room")
    assert inside - base == 8.0   # only the 15-Jan-2000 issue lands in the range


def test_consumption_trend_custom_range_spans_every_day():
    """A calendar range builds one point per day across [from, to], zero-filled."""
    svc = SpareStockService()
    trend = svc.consumption_trend("MAINTENANCE", date_from="2000-01-01", date_to="2000-01-07")
    assert len(trend) == 7
    assert trend[0]["d"] == "01 Jan"
    assert all("qty" in t for t in trend)


def test_consumption_report_excel_carries_breakdown_and_period_sheets():
    """The download workbook builds and lays out the breakdown sheets (which
    follow the picked range) ahead of the whole-ledger month/year sheets."""
    from openpyxl import load_workbook
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 20)
    svc.issue(p.id, 4, "Tool Room", machine="PRESS-05")

    buf = svc.consumption_report_excel("MAINTENANCE", days=7)
    wb = load_workbook(buf)
    assert wb.sheetnames == ["By Department", "By Machine", "By Part Type", "Month-wise", "Year-wise"]
    assert wb["By Department"].cell(row=1, column=1).value == "Department"
    assert wb["By Machine"].cell(row=1, column=1).value == "Machine"
