"""A stock-in on the part timeline is shown ONCE. For a GOOD return inspection
(and quality clearance / RGP GRN) the event row names it and the "Added to
store stock" row carries the +qty. Found on the e2e run: both rows said "+1 to
stock", which reads as +2. A return taken straight back into stock (the
store's rule, 14 Oct 2026) is a single row that carries its own +qty.
"""
from app.extensions import db
from app.models.part import Part
from app.services.scan_result_service import ScanResultService
from app.services.spare_return_service import SpareReturnService
from app.services.spare_stock_service import SpareStockService

_seq = {"n": 0}


def _part():
    _seq["n"] += 1
    p = Part(part_no=f"TL-{_seq['n']}", part_name=f"Timeline Part {_seq['n']}", uom="NO",
             part_type="OTHER", store_code="MAINTENANCE")
    db.session.add(p)
    db.session.commit()
    return p


def _issued(qty=2, stock=10):
    stock_svc = SpareStockService()
    p = _part()
    stock_svc.set_quantity(p.id, stock, txn_type="OPENING")
    return p, stock_svc.issue(p.id, qty, "Maintenance", user="tester")["issue"]["id"]


def _back_in(rows):
    """Every positive stock change on the timeline but the opening count."""
    return sum(r["qty_delta"] for r in rows
               if r["qty_delta"] and r["qty_delta"] > 0 and r["kind"] != "OPENING")


def test_return_taken_straight_back_shows_the_stock_in_once():
    p, issue_id = _issued()
    SpareReturnService().return_to_store(issue_id, 2, reason="Fitment Issue", user="tester")

    rows = ScanResultService().timeline(p.id)["rows"]
    returned = [r for r in rows if r["kind"] == "RETURN_TO_STORE"]
    assert len(returned) == 1 and returned[0]["qty_delta"] == 2
    assert not [r for r in rows if r["kind"] in ("RETURN_INSPECTION", "STOCK_AVAILABLE")]
    assert _back_in(rows) == 2


def test_good_inspection_of_a_waiting_return_shows_the_stock_in_once(waiting_return):
    p, issue_id = _issued()
    ret = waiting_return(issue_id, 2, user="tester")
    SpareReturnService().inspect(ret.id, "GOOD", 2, user="tester")

    rows = ScanResultService().timeline(p.id)["rows"]
    inspected = [r for r in rows if r["kind"] == "RETURN_INSPECTION"]
    added = [r for r in rows if r["kind"] == "STOCK_AVAILABLE"]
    assert len(inspected) == 1 and len(added) == 1
    assert inspected[0]["qty_delta"] is None
    assert added[0]["qty_delta"] == 2
    assert [r["qty_delta"] for r in rows if r["kind"] == "RETURN_TO_STORE"] == [None]
    assert _back_in(rows) == 2
