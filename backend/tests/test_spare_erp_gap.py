"""Spare Parts Store ERP-vs-Physical gap (new feature).

ERP comes from the feed (erp_stock); physical comes from the in-app count
(SpareStock.qty_on_hand) — no second upload. Store-scoped via the same
_store_code()/require_store_access gate as the rest of spare-stock.
"""
import pytest

from app.extensions import db
from app.models.base import utcnow
from app.models.part import Part
from app.models.user import User, UserStoreAccess
from app.repositories.erp_stock_repository import ERPStockRepository
from app.services.spare_stock_service import SpareStockService

_seq = {"n": 0}


def _part(store_code="MAINTENANCE"):
    _seq["n"] += 1
    p = Part(part_no=f"GP-{_seq['n']}", part_name=f"Gap Part {_seq['n']}", uom="NO",
             part_type="OTHER", store_code=store_code)
    db.session.add(p)
    db.session.commit()
    return p


def _set_erp(part_id, qty):
    ERPStockRepository().upsert(part_id, qty, utcnow())
    db.session.commit()


def _set_physical(part_id, qty):
    SpareStockService().set_quantity(part_id, float(qty), txn_type="OPENING")


def _user(role, stores=()):
    _seq["n"] += 1
    u = User(username=f"gapuser{_seq['n']}", role=role, is_active=True)
    u.set_password("pw")
    db.session.add(u)
    db.session.flush()
    for code in stores:
        db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
    db.session.commit()
    return u


@pytest.fixture()
def client(app):
    return app.test_client()


def test_gap_status_match_short_excess():
    svc = SpareStockService()
    a = _part(); _set_erp(a.id, 10); _set_physical(a.id, 8)   # physical < ERP -> SHORT, gap -2
    b = _part(); _set_erp(b.id, 5); _set_physical(b.id, 5)    # equal -> MATCH, gap 0
    c = _part(); _set_erp(c.id, 3); _set_physical(c.id, 7)    # physical > ERP -> EXCESS, gap +4

    rows = {r["part_no"]: r for r in svc.erp_gap("MAINTENANCE")}
    assert rows[a.part_no]["status"] == "SHORT" and rows[a.part_no]["gap_qty"] == -2
    assert rows[b.part_no]["status"] == "MATCH" and rows[b.part_no]["gap_qty"] == 0
    assert rows[c.part_no]["status"] == "EXCESS" and rows[c.part_no]["gap_qty"] == 4


def test_gap_not_synced_and_no_physical():
    svc = SpareStockService()
    counted_only = _part(); _set_physical(counted_only.id, 9)   # counted, ERP never pushed -> NOT_SYNCED
    erp_only = _part(); _set_erp(erp_only.id, 4)                # ERP pushed, never counted -> NO_PHYSICAL

    rows = {r["part_no"]: r for r in svc.erp_gap("MAINTENANCE")}
    assert rows[counted_only.part_no]["status"] == "NOT_SYNCED"
    assert rows[counted_only.part_no]["gap_qty"] is None
    assert rows[erp_only.part_no]["status"] == "NO_PHYSICAL"
    assert rows[erp_only.part_no]["gap_qty"] is None


def test_gap_route_enforces_store_access(client):
    user = _user("STORE_USER", stores=["CHILD_PART"])  # assigned to a different store
    with client.session_transaction() as sess:
        sess["user_id"] = user.id
    resp = client.get("/api/v1/spare-stock/erp-gap?store_code=MAINTENANCE")
    assert resp.status_code == 403
