"""Every write that changes what a stock screen shows pushes a "stock" event, so
open dashboards refresh live — a count, a location move and an opening-stock
upload as well as issue/receive/return (the screens cache the stock list and
rely on these pushes to know it changed)."""
import io
import json
import queue

import pytest
from openpyxl import Workbook

from app.extensions import db
from app.models.part import Part
from app.models.user import User
from app.utils import event_bus

_seq = {"n": 0}


@pytest.fixture()
def admin_client(app):
    _seq["n"] += 1
    user = User(username=f"evadmin{_seq['n']}", role="ADMIN", is_active=True)
    user.set_password("pw")
    db.session.add(user)
    db.session.commit()
    client = app.test_client()
    with client.session_transaction() as sess:
        sess["user_id"] = user.id
    return client


def _part():
    _seq["n"] += 1
    p = Part(part_no=f"EV-{_seq['n']}", part_name="Event Part", uom="NO",
             part_type="OTHER", store_code="MAINTENANCE", location="R1-S1-B1")
    db.session.add(p)
    db.session.commit()
    return p


def _events(q):
    out = []
    while True:
        try:
            out.append(json.loads(q.get_nowait()))
        except queue.Empty:
            return out


@pytest.fixture()
def bus():
    q = event_bus.subscribe()
    yield q
    event_bus.unsubscribe(q)


def test_count_publishes_stock_event(admin_client, bus):
    p = _part()
    resp = admin_client.put(f"/api/v1/spare-stock/parts/{p.id}",
                            json={"qty_on_hand": 12, "txn_type": "OPENING"})
    assert resp.status_code == 200, resp.get_json()
    assert {"event": "stock", "data": {"part_id": p.id, "action": "count"}} in _events(bus)


def test_location_move_publishes_stock_event(admin_client, bus):
    p = _part()
    admin_client.put(f"/api/v1/spare-stock/parts/{p.id}", json={"qty_on_hand": 5, "txn_type": "OPENING"})
    _events(bus)  # drop the count's own event
    resp = admin_client.post(f"/api/v1/spare-stock/parts/{p.id}/update-location",
                             json={"new_location": "R2-S1-B1", "reason": "Re-racked"})
    assert resp.status_code == 200, resp.get_json()
    assert {"event": "stock", "data": {"part_id": p.id, "action": "location"}} in _events(bus)


def test_import_publishes_only_when_something_changed(admin_client, bus):
    p = _part()

    def upload(rows):
        wb = Workbook()
        ws = wb.active
        ws.append(["Part No", "Qty On Hand"])
        for r in rows:
            ws.append(r)
        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        return admin_client.post("/api/v1/spare-stock/import",
                                 data={"file": (buf, "stock.xlsx"), "store_code": "MAINTENANCE"},
                                 content_type="multipart/form-data")

    resp = upload([[p.part_no, 9]])
    assert resp.status_code == 201, resp.get_json()
    assert resp.get_json()["data"]["updated"] == 1
    assert any(e["event"] == "stock" and e["data"].get("action") == "import" for e in _events(bus))

    # A sheet that matches no part changes nothing — no reason to refresh anyone.
    resp = upload([["NO-SUCH-PART-XYZ", 3]])
    assert resp.status_code == 201, resp.get_json()
    assert not any(e["data"].get("action") == "import" for e in _events(bus))


def test_part_edit_clears_cached_stock_rows_and_publishes(app, admin_client, bus):
    """A part-master edit changes what a stock row shows (here its minimum), so
    it must drop the backend's cached rows before pushing — otherwise the
    refresh the push triggers would read the pre-edit rows straight back."""
    from app.services.spare_stock_service import SpareStockService

    p = _part()
    svc = SpareStockService()
    app.config["SPARE_STOCK_CACHE_TTL"] = 60       # caching on, as in production
    try:
        before = {r["part_id"]: r for r in svc.list_stock("MAINTENANCE")}
        assert before[p.id]["min_stock_level"] == 0.0
        resp = admin_client.put(f"/api/v1/parts/{p.id}", json={"min_stock_level": 7})
        assert resp.status_code == 200, resp.get_json()
        after = {r["part_id"]: r for r in svc.list_stock("MAINTENANCE")}
        assert after[p.id]["min_stock_level"] == 7.0
    finally:
        app.config["SPARE_STOCK_CACHE_TTL"] = 0
    assert {"event": "stock", "data": {"action": "parts", "part_id": p.id}} in _events(bus)
