"""Spare issue flow (new feature): issuing a spare to a department writes an
ISSUE ledger row tagged with the department, deducts on-hand, and feeds
Department-wise Consumption. Refuses to over-issue below zero.
"""
import pytest

from app.extensions import db
from app.models.part import Part
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.models.user import User, UserStoreAccess
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
    ledger_id = mine[0]["id"]

    svc.return_item(ledger_id)                          # bring it back
    assert _on_hand(p.id) == 10.0                        # stock restored
    assert not any(r["id"] == ledger_id for r in svc.outstanding_returnables("MAINTENANCE"))

    with pytest.raises(BadRequestError):                # can't return twice
        svc.return_item(ledger_id)


def test_non_returnable_issue_is_not_outstanding():
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 5)
    svc.issue(p.id, 1, "Maintenance", returnable=False)
    assert not any(r["part_no"] == p.part_no for r in svc.outstanding_returnables("MAINTENANCE"))


def test_receive_adds_stock():
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 5)
    svc.receive(p.id, 8, reference="GRN-77")
    assert _on_hand(p.id) == 13.0
    row = SpareStockLedger.query.filter_by(part_id=p.id, txn_type="RECEIPT").first()
    assert row is not None and float(row.qty_delta) == 8.0


def test_scan_resolves_by_part_no_and_is_store_scoped():
    svc = SpareStockService()
    p = _part()  # in MAINTENANCE
    row = svc.resolve_scan("MAINTENANCE", p.part_no)
    assert row["part_no"] == p.part_no

    with pytest.raises(NotFoundError):        # same code, wrong store
        svc.resolve_scan("CHILD_PART", p.part_no)
    with pytest.raises(NotFoundError):        # unknown code
        svc.resolve_scan("MAINTENANCE", "NO-SUCH-CODE")


def test_movements_are_pending_erp_until_synced():
    svc = SpareStockService()
    p = _part(); _set_physical(p.id, 10)
    before = svc.pending_erp_count("MAINTENANCE")

    svc.issue(p.id, 2, "Maintenance")
    svc.receive(p.id, 5, reference="GRN-1")
    after = svc.pending_erp_count("MAINTENANCE")
    assert after - before == 2  # the ISSUE and the RECEIPT are both pending

    # ERP endpoint not configured -> nothing pushed, everything stays pending
    res = svc.sync_pending_to_erp("MAINTENANCE")
    assert res["configured"] is False
    assert svc.pending_erp_count("MAINTENANCE") == after


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
