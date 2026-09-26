"""A stock-in on the part timeline is shown ONCE: the GOOD return inspection
(and quality clearance / RGP GRN) row names the event, the "Added to store
stock" row carries the +qty. Found on the e2e run: both rows said "+1 to stock",
which reads as +2.
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


def test_good_inspection_shows_the_stock_in_once():
    stock = SpareStockService()
    p = _part()
    stock.set_quantity(p.id, 10, txn_type="OPENING")
    issued = stock.issue(p.id, 2, "Maintenance", user="tester")
    issue_id = issued["issue"]["id"]
    ret = SpareReturnService().return_to_store(issue_id, 2, reason="Fitment Issue", user="tester")
    SpareReturnService().inspect(ret["id"], "GOOD", 2, user="tester")

    rows = ScanResultService().timeline(p.id)["rows"]
    inspected = [r for r in rows if r["kind"] == "RETURN_INSPECTION"]
    added = [r for r in rows if r["kind"] == "STOCK_AVAILABLE"]
    assert len(inspected) == 1 and len(added) == 1
    assert inspected[0]["qty_delta"] is None
    assert added[0]["qty_delta"] == 2
    # Every positive stock change on the timeline adds up to what went back on the rack.
    back_in = sum(r["qty_delta"] for r in rows
                  if r["qty_delta"] and r["qty_delta"] > 0 and r["kind"] != "OPENING")
    assert back_in == 2
