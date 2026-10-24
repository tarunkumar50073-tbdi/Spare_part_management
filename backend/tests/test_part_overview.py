"""One spare in one call (/spare-stock/parts/<id>/overview) — the part drawer."""
from datetime import timedelta

import pytest

from app.extensions import db
from app.models.base import utcnow
from app.models.erp_stock import ERPStock
from app.models.gate_entry import GateEntry
from app.models.part import Part
from app.models.user import User, UserStoreAccess
from app.services.spare_part_overview_service import SparePartOverviewService
from app.services.spare_stock_service import SpareStockService

_seq = {"n": 0}


def _part(store="MAINTENANCE", **kw):
    _seq["n"] += 1
    p = Part(part_no=f"PO-{_seq['n']}", part_name="Overview Part", uom="NO", part_type="OTHER",
             store_code=store, **kw)
    db.session.add(p)
    db.session.commit()
    return p


def test_part_overview_reads_every_block_from_real_rows():
    p = _part(min_stock_level=5, reorder_level=8, max_stock_level=20, unit_price=10, location="R1-S1-B1")
    svc = SpareStockService()
    svc.set_quantity(p.id, 12, txn_type="OPENING")
    svc.issue(p.id, 4, "Maintenance")                       # -> 8 on hand: at reorder level
    db.session.add(ERPStock(part_id=p.id, qty_on_hand=10, synced_at=utcnow() - timedelta(hours=48)))
    db.session.add(GateEntry(store_code="CHILD_PART", item_code=p.part_no, ven_cd="VQ-1",
                             ven_name="Q SUPPLY", qty=12, gate_entry_no=f"GE-{p.part_no}"))
    db.session.commit()

    ov = SparePartOverviewService().overview(p.id)

    assert ov["part"]["part_no"] == p.part_no and ov["part"]["specification"] is None
    st = ov["stock"]
    assert (st["qty_on_hand"], st["status"], st["reorder"], st["max"]) == (8.0, "Reorder", 8.0, 20.0)
    assert st["reserved"] is None and st["available"] == 8.0      # reservations not tracked

    c = ov["consumption"]
    assert c["today"] == 4.0 and c["week"] == 4.0 and c["month"] == 4.0 and c["issues"] == 1
    assert len(c["trend"]) == 12 and c["trend"][-1]["qty"] == 4.0
    assert c["ledger_since"] is not None

    e = ov["erp"]
    assert (e["state"], e["erp_qty"], e["physical_qty"], e["difference"]) == ("STALE", 10.0, 8.0, -2.0)

    assert ov["suppliers"][0]["ven_cd"] == "VQ-1"
    assert any(t["txn_type"] == "ISSUE" for t in ov["transactions"])
    assert ov["label"]["labels_printed"] == 0

    labels = {a["label"]: a["severity"] for a in ov["alerts"]}
    assert labels["At reorder level"] == "warning"
    assert labels["Awaiting confirmation"] == "warning"           # issue not yet confirmed
    assert labels["No barcode label"] == "info"


def test_never_counted_part_says_so():
    p = _part()
    ov = SparePartOverviewService().overview(p.id)
    assert ov["stock"]["status"] == "Not Counted"
    assert {"Never counted", "No maximum set", "No rate", "No location"} <= {a["label"] for a in ov["alerts"]}
    assert ov["erp"]["state"] == "NONE" and ov["consumption"]["issues"] == 0


@pytest.fixture()
def client(app):
    return app.test_client()


def test_part_overview_route_is_store_scoped(client):
    _seq["n"] += 1
    u = User(username=f"pouser{_seq['n']}", role="STORE_USER", is_active=True)
    u.set_password("pw")
    u.set_permissions({"spare_store": {"view": True}})   # the spare stock needs a right (24 Oct 2026)
    db.session.add(u)
    db.session.flush()
    db.session.add(UserStoreAccess(user_id=u.id, store_code="MAINTENANCE"))
    db.session.commit()
    with client.session_transaction() as s:
        s["user_id"] = u.id
    mine, theirs = _part(), _part("CHILD_PART")
    assert client.get(f"/api/v1/spare-stock/parts/{mine.id}/overview").status_code == 200
    assert client.get(f"/api/v1/spare-stock/parts/{theirs.id}/overview").status_code == 403
