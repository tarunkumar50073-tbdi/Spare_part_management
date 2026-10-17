"""Kiosk part-request -> supervisor issuance flow.

A request is created PENDING, the supervisor scans the bin location (Right/Wrong
validated against the part's own location), and confirms the actual quantity.
The real stock deduction is delegated to the existing issue flow (no double
deduction); the request tracks Issued / Partially Issued. Wrong location,
over-issue, unavailable stock, and a duplicate confirm are all refused.
"""
import pytest

from app.extensions import db
from app.models.part import Part
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.services.part_request_service import PartRequestService
from app.services.spare_stock_service import SpareStockService
from app.utils.exceptions import BadRequestError

_seq = {"n": 0}


def _part(location="R5-S4-B24(2)", store_code="MAINTENANCE"):
    _seq["n"] += 1
    p = Part(part_no=f"REQP-{_seq['n']}", part_name=f"Req Part {_seq['n']}", uom="NO",
             part_type="OTHER", store_code=store_code, location=location)
    db.session.add(p)
    db.session.commit()
    return p


def _set_physical(part_id, qty):
    SpareStockService().set_quantity(part_id, float(qty), txn_type="OPENING")


def _on_hand(part_id):
    row = SpareStock.query.filter_by(part_id=part_id).first()
    return float(row.qty_on_hand) if row else 0.0


def _create(part, qty=5, dept="Press Shop"):
    return PartRequestService().create(
        "MAINTENANCE", {"part_id": part.id, "requested_qty": qty, "department": dept})


def test_create_is_pending_with_reference_and_snapshot():
    p = _part(); _set_physical(p.id, 10)
    r = _create(p, qty=4)
    assert r["status"] == "PENDING"
    assert r["reference_no"].startswith("REQ-")
    assert r["part_no"] == p.part_no
    assert r["assigned_location"] == "R5-S4-B24(2)"
    assert r["requested_qty"] == 4.0 and r["issued_qty"] == 0.0
    assert r["available_qty"] == 10.0


def test_right_location_issues_deducts_and_completes():
    svc = PartRequestService()
    p = _part(); _set_physical(p.id, 10)
    r = _create(p, qty=3)
    out = svc.issue(r["id"], "R5-S4-B24(2)", 3, user="sup1")
    assert out["status"] == "ISSUED"
    assert out["issued_qty"] == 3.0 and out["remaining_qty"] == 0.0
    assert _on_hand(p.id) == 7.0
    led = SpareStockLedger.query.filter_by(part_id=p.id, txn_type="ISSUE").first()
    assert led is not None and float(led.qty_delta) == -3.0


def test_bare_bin_qr_matches_slot_location():
    svc = PartRequestService()
    p = _part(location="R5-S4-B24(2)"); _set_physical(p.id, 5)
    r = _create(p, qty=1)
    out = svc.issue(r["id"], "R5-S4-B24", 1, user="sup1")   # bare bin, no slot
    assert out["status"] == "ISSUED"


def test_wrong_location_blocks_and_leaves_pending():
    svc = PartRequestService()
    p = _part(location="R5-S4-B24(2)"); _set_physical(p.id, 5)
    r = _create(p, qty=1)
    with pytest.raises(BadRequestError):
        svc.issue(r["id"], "R5-S4-B25(1)", 1, user="sup1")
    assert _on_hand(p.id) == 5.0
    assert svc.get(r["id"])["status"] == "PENDING"


def test_issue_less_than_requested_closes_request():
    # Giving less than requested still CLOSES the request (no partial / keep-open).
    svc = PartRequestService()
    p = _part(); _set_physical(p.id, 10)
    r = _create(p, qty=5)
    out = svc.issue(r["id"], "R5-S4-B24(2)", 2, user="sup1")
    assert out["status"] == "ISSUED"
    assert out["issued_qty"] == 2.0
    assert _on_hand(p.id) == 8.0
    # already closed -> a second issue on the same request is refused
    with pytest.raises(BadRequestError):
        svc.issue(r["id"], "R5-S4-B24(2)", 3, user="sup1")


def test_cannot_issue_more_than_remaining():
    svc = PartRequestService()
    p = _part(); _set_physical(p.id, 10)
    r = _create(p, qty=2)
    with pytest.raises(BadRequestError):
        svc.issue(r["id"], "R5-S4-B24(2)", 3, user="sup1")
    assert _on_hand(p.id) == 10.0


def test_duplicate_token_does_not_issue_twice():
    svc = PartRequestService()
    p = _part(); _set_physical(p.id, 10)
    r = _create(p, qty=5)
    svc.issue(r["id"], "R5-S4-B24(2)", 2, user="sup1", token="tok-1")
    assert _on_hand(p.id) == 8.0
    out2 = svc.issue(r["id"], "R5-S4-B24(2)", 2, user="sup1", token="tok-1")  # repeat
    assert _on_hand(p.id) == 8.0           # no second deduction
    assert out2["issued_qty"] == 2.0


def test_stock_unavailable_blocks_issue():
    svc = PartRequestService()
    p = _part()   # never counted -> qty_on_hand None
    r = _create(p, qty=1)
    with pytest.raises(BadRequestError):
        svc.issue(r["id"], "R5-S4-B24(2)", 1, user="sup1")


def test_short_stock_issues_available_and_closes():
    # Only 2 on hand, 5 requested: issue the 2 and the request closes (short).
    svc = PartRequestService()
    p = _part(); _set_physical(p.id, 2)
    r = _create(p, qty=5)
    out = svc.issue(r["id"], "R5-S4-B24(2)", 2, user="sup1")
    assert out["status"] == "ISSUED"                 # closed even though 2 < 5
    assert out["issued_qty"] == 2.0 and out["remaining_qty"] == 3.0
    assert _on_hand(p.id) == 0.0
