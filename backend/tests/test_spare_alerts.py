"""Notification Center alerts (/api/v1/spare-alerts).

Each test seeds its own throwaway store, so every count is known exactly (the
session DB is shared, and a store-level alert would otherwise count every other
test's MAINTENANCE parts). The store is switched off again afterwards.

Base seed (`seeded`):
    A   0 on hand, min 2, max 10, rate 100 -> Out of Stock   (restock 10 x 100)
    A2  0 on hand, min 1, max 4,  no rate  -> Out of Stock
    B   1,         min 5, max 20, rate 10  -> Below Minimum
    D   30,        min 2, max 10, rate 50  -> Above Maximum  (20 over x 50)
    D2  12,        min 1, max 5,  no rate  -> Above Maximum  (unvalued)
    E   5,         min 2, max 10, rate 1   -> Healthy, with one issue awaiting
                                              confirmation (3 days old) and one
                                              already installed
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.extensions import db
from app.models.erp_stock import ERPStock
from app.models.part import Part
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.models.srv import SRV
from app.models.store import Section, Store
from app.models.user import User, UserStoreAccess
from app.services.erp_sync_service import ERPSyncService
from app.services.spare_alerts_service import MAX_ISSUE_ALERTS, TOP_ZERO_STOCK, SpareAlertsService

_seq = {"n": 0}


def _next():
    _seq["n"] += 1
    return _seq["n"]


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


@pytest.fixture()
def store(monkeypatch):
    # The ERP DB poller's status is process-wide; start each test from "no error".
    monkeypatch.setattr(ERPSyncService, "_last_error", None)
    n = _next()
    s = Store(code=f"ALRT{n}", name=f"Alerts Test Store {n}", sort_order=900)
    db.session.add(s)
    db.session.commit()
    sec = Section(store_id=s.id, name=f"Alerts Section {n}")
    db.session.add(sec)
    db.session.commit()
    yield s, sec
    # Leave no extra ACTIVE store behind for tests that reason about store visibility.
    s.is_active = False
    db.session.commit()


def _part(s, sec, tag, qty, mn=0, mx=None, ro=None, rate=None):
    p = Part(part_no=f"AL-{_next()}-{tag}", part_name=f"Alert part {tag}", uom="NO",
             part_type="OTHER", store_code=s.code, section_id=sec.id, location="R1-S1-B1",
             min_stock_level=mn, max_stock_level=mx, reorder_level=ro, unit_price=rate)
    db.session.add(p)
    db.session.commit()
    if qty is not None:
        db.session.add(SpareStock(part_id=p.id, qty_on_hand=qty))
        db.session.commit()
    return p


def _issue(part, qty=1, status="PENDING_USER_CONFIRMATION", age_hours=72, dept="Maintenance"):
    row = SpareStockLedger(part_id=part.id, qty_delta=-qty, balance_after=5, txn_type="ISSUE",
                           department=dept, issued_to="Ramesh", created_by="store1", status=status,
                           created_at=_now() - timedelta(hours=age_hours))
    db.session.add(row)
    db.session.commit()
    return row


@pytest.fixture()
def seeded(store):
    s, sec = store
    p = {
        "A": _part(s, sec, "A", 0, mn=2, mx=10, rate=100),
        "A2": _part(s, sec, "A2", 0, mn=1, mx=4),
        "B": _part(s, sec, "B", 1, mn=5, mx=20, rate=10),
        "D": _part(s, sec, "D", 30, mn=2, mx=10, rate=50),
        "D2": _part(s, sec, "D2", 12, mn=1, mx=5),
        "E": _part(s, sec, "E", 5, mn=2, mx=10, rate=1),
    }
    pending = _issue(p["E"])
    _issue(p["E"], status="INSTALLED", age_hours=100)
    return s, sec, p, pending


def _by_id(res):
    return {a["id"]: a for a in res["alerts"]}


# ----------------------------------------------------------------- the set

def test_alert_set_on_seeded_state(seeded):
    s, sec, p, pending = seeded
    res = SpareAlertsService().alerts(s.code)
    a = _by_id(res)

    assert [x["id"] for x in res["alerts"]] == [
        "zero_stock", f"zero_stock:{p['A'].id}", f"zero_stock:{p['A2'].id}", "below_min",
        "confirm_pending", f"confirm_pending:{pending.id}", "excess", "erp_snapshot_none",
        "erp_write_queue", "missing_rate",
    ]
    # Headlines only: the two zero-stock parts and the one issue listed under
    # their headlines are detail, not extra alerts.
    assert res["summary"] == {"critical": 2, "warning": 3, "info": 2, "total": 7}
    assert res["generated_at"].endswith("+00:00")
    assert {o["type"] for o in res["omitted"]} == {"count_due"}

    z = a["zero_stock"]
    assert (z["severity"], z["count"], z["part_id"], z["at"]) == ("critical", 2, None, None)
    assert z["action"] == {"label": "Open list", "to": "/store-stock-spare?status=Out%20of%20Stock",
                           "module": "store_stock"}
    assert sec.name in z["message"]                       # the "where"

    # Per-part: dearest restock first; an unrated part says so instead of a price.
    za = a[f"zero_stock:{p['A'].id}"]
    assert (za["part_id"], za["part_no"], za["parent"], za["severity"]) == (p["A"].id, p["A"].part_no, "zero_stock", "critical")
    assert za["value"] == 1000.0 and "₹1,000" in za["message"] and "Restock to max: 10 NO" in za["message"]
    za2 = a[f"zero_stock:{p['A2'].id}"]
    assert za2["value"] is None and "no std rate" in za2["message"]

    assert a["below_min"]["severity"] == "critical" and a["below_min"]["count"] == 1
    assert a["below_min"]["action"]["to"] == "/store-stock-spare?status=Below%20Minimum"

    # Only the unconfirmed issue — the installed one is done.
    c = a["confirm_pending"]
    assert (c["severity"], c["count"]) == ("warning", 1)
    assert c["action"] == {"label": "Confirm on Scan Part", "to": "/scan-part", "module": "scan_part"}
    assert "Oldest waiting 3 days" in c["message"]
    ci = a[f"confirm_pending:{pending.id}"]
    assert (ci["part_id"], ci["parent"], ci["ledger_id"]) == (p["E"].id, "confirm_pending", pending.id)
    assert ci["at"].endswith("+00:00") and 71.5 < ci["age_hours"] < 72.5
    assert "1 NO issued to Maintenance / Ramesh" in ci["message"]

    ex = a["excess"]
    assert (ex["severity"], ex["count"], ex["value"]) == ("warning", 2, 1000.0)
    assert ex["action"]["to"] == "/inventory-control?tab=excess"
    assert "1 part without a rate not included" in ex["message"]

    snap = a["erp_snapshot_none"]
    assert (snap["severity"], snap["state"], snap["action"]["to"]) == ("warning", "NONE", "/erp-control")

    # Both issues are movements ERP has not received; the write-back is off in tests.
    q = a["erp_write_queue"]
    assert (q["severity"], q["count"]) == ("info", 2)
    assert "disabled" in q["message"] and q["at"].endswith("+00:00")

    mr = a["missing_rate"]
    assert (mr["severity"], mr["count"], mr["action"]["to"]) == ("info", 2, "/data-quality")


# The module right each screen's route asks for (App.jsx RequirePermission).
ROUTE_MODULE = {
    "/store-stock-spare": "store_stock", "/inventory-control": "store_stock",
    "/scan-part": "scan_part", "/erp-control": "erp_gap",
    "/data-quality": "part_master", "/receiving": "spare_store",
}


def test_every_action_names_the_right_its_screen_needs(seeded, monkeypatch):
    s = seeded[0]
    monkeypatch.setattr(ERPSyncService, "_last_error", "OperationalError: boom")
    alerts = SpareAlertsService().alerts(s.code)["alerts"]
    assert all(x["action"] for x in alerts)
    for x in alerts:
        path = x["action"]["to"].split("?")[0]
        assert x["action"]["module"] == ROUTE_MODULE[path], x["id"]


def test_no_alert_for_a_type_with_nothing_to_report(store):
    s, sec = store
    healthy = _part(s, sec, "H", 5, mn=2, mx=10, rate=3)
    res = SpareAlertsService().alerts(s.code)
    # Only the ERP state remains: no snapshot has ever arrived for this store.
    assert [x["id"] for x in res["alerts"]] == ["erp_snapshot_none"]

    # A fresh snapshot is not an alert either — nothing left at all.
    db.session.add(ERPStock(part_id=healthy.id, qty_on_hand=5, synced_at=datetime.now(timezone.utc)))
    db.session.commit()
    res = SpareAlertsService().alerts(s.code)
    assert res["alerts"] == []
    assert res["summary"] == {"critical": 0, "warning": 0, "info": 0, "total": 0}


def test_state_alerts_stale_snapshot_and_sync_error(store, monkeypatch):
    s, sec = store
    healthy = _part(s, sec, "H", 5, mn=2, mx=10, rate=3)
    synced = _now() - timedelta(days=3)
    db.session.add(ERPStock(part_id=healthy.id, qty_on_hand=5, synced_at=synced))
    db.session.commit()
    monkeypatch.setattr(ERPSyncService, "_last_error",
                        'OperationalError: connection to server at "10.1.2.3", port 5432 failed '
                        'for user "erp_reader"')
    monkeypatch.setattr(ERPSyncService, "_last_sync_at", None)

    res = SpareAlertsService().alerts(s.code)
    a = _by_id(res)
    assert [x["id"] for x in res["alerts"]] == ["erp_sync_error", "erp_snapshot_stale"]

    err = a["erp_sync_error"]
    assert err["severity"] == "critical" and err["at"] is None
    assert "since the server started" in err["message"]
    # Any store user reads this list: the driver error (ERP host / user) stays
    # on ERP Control.
    assert "10.1.2.3" not in str(err) and "erp_reader" not in str(err)
    assert err["action"]["to"] == "/erp-control" and err["action"]["module"] == "erp_gap"

    st = a["erp_snapshot_stale"]
    assert (st["severity"], st["count"], st["state"]) == ("warning", 1, "STALE")
    assert st["at"] == synced.replace(tzinfo=timezone.utc).isoformat()
    assert "3 days" in st["title"]


def test_other_counts_reorder_never_counted_missing_max_srv(store):
    s, sec = store
    ro = _part(s, sec, "R", 6, mn=2, mx=12, ro=6, rate=5)          # Reorder
    _part(s, sec, "N", None, mn=1, mx=3, rate=2)                   # Not Counted
    _part(s, sec, "M", 5, mn=2, mx=None, rate=2)                   # no max
    _issue(ro, status="ISSUED_BY_STORE", age_hours=5)             # also in the Scan Part queue
    for status in ("PENDING_UNLOAD", "VERIFIED", "FORWARDED_TOOL_ROOM"):
        db.session.add(SRV(vendor_code="V1", supplier_name="Sup", part_id=ro.id, part_no=ro.part_no,
                           part_name=ro.part_name, qty_invoiced=1, status=status))
    db.session.commit()

    a = _by_id(SpareAlertsService().alerts(s.code))
    assert a["reorder"]["severity"] == "warning" and a["reorder"]["count"] == 1
    assert a["reorder"]["action"]["to"] == "/store-stock-spare?status=Reorder"
    assert a["never_counted"]["severity"] == "info" and a["never_counted"]["count"] == 1
    assert a["never_counted"]["action"]["to"] == "/store-stock-spare?status=Not%20Counted"
    assert a["missing_max"]["severity"] == "info" and a["missing_max"]["count"] == 1
    srv = a["srv_pending"]
    assert (srv["severity"], srv["count"], srv["awaiting_srv"], srv["awaiting_clearance"]) == ("warning", 3, 2, 1)
    assert srv["action"]["to"] == "/receiving?tab=srv" and srv["action"]["module"] == "spare_store"
    assert a["confirm_pending"]["count"] == 1 and "waiting 5 h" in a[next(k for k in a if k.startswith("confirm_pending:"))]["message"]
    assert "zero_stock" not in a and "below_min" not in a and "excess" not in a


def test_per_item_alerts_are_capped(store):
    s, sec = store
    # More zero-stock parts than the per-part cap, each dearer than the last.
    zero = [_part(s, sec, f"Z{i}", 0, mn=1, mx=10, rate=10 * (i + 1)) for i in range(TOP_ZERO_STOCK + 2)]
    host = _part(s, sec, "H", 50, mn=1, mx=100, rate=1)
    issues = [_issue(host, age_hours=10 + i) for i in range(MAX_ISSUE_ALERTS + 2)]

    res = SpareAlertsService().alerts(s.code)
    ids = [x["id"] for x in res["alerts"]]
    per_part = [x for x in res["alerts"] if x["type"] == "zero_stock_part"]
    assert [x["part_id"] for x in per_part] == [z.id for z in reversed(zero)][:TOP_ZERO_STOCK]
    assert _by_id(res)["zero_stock"]["count"] == TOP_ZERO_STOCK + 2

    per_issue = [x for x in res["alerts"] if x["type"] == "confirm_pending_issue"]
    assert len(per_issue) == MAX_ISSUE_ALERTS
    # Longest waiting first.
    assert [x["ledger_id"] for x in per_issue] == [r.id for r in reversed(issues)][:MAX_ISSUE_ALERTS]
    head = _by_id(res)["confirm_pending"]
    assert head["count"] == MAX_ISSUE_ALERTS + 2
    assert f"The {MAX_ISSUE_ALERTS} longest waiting are listed below" in head["message"]
    assert ids.index("confirm_pending") < ids.index(per_issue[0]["id"])

    # The summary does not move with the caps: one zero-stock alert, one
    # confirmation alert (plus the store's ERP states).
    assert res["summary"] == {"critical": 1, "warning": 2, "info": 1, "total": 4}
    assert {x["id"] for x in res["alerts"] if not x["parent"]} == {
        "zero_stock", "confirm_pending", "erp_snapshot_none", "erp_write_queue"}


# --------------------------------------------------------------- endpoint

@pytest.fixture()
def client(app):
    return app.test_client()


def _login(client, role="STORE_USER", stores=()):
    u = User(username=f"alertuser{_next()}", role=role, is_active=True)
    u.set_password("pw")
    u.set_permissions({})                   # no module rights: the bell needs none
    db.session.add(u)
    db.session.flush()
    for code in stores:
        db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
    db.session.commit()
    with client.session_transaction() as sess:
        sess["user_id"] = u.id
    return client


def test_endpoint_is_store_scoped(client, seeded):
    s = seeded[0]
    c = _login(client, stores=("MAINTENANCE",))
    assert c.get("/api/v1/spare-alerts").status_code == 400
    assert c.get(f"/api/v1/spare-alerts?store_code={s.code}").status_code == 403

    c = _login(client, stores=(s.code,))
    r = c.get(f"/api/v1/spare-alerts?store_code={s.code}")
    assert r.status_code == 200
    body = r.get_json()["data"]
    assert len(body["alerts"]) == 10 and body["summary"]["total"] == 7
    assert body["store_code"] == s.code


def test_endpoint_requires_sign_in(app, seeded):
    assert app.test_client().get(f"/api/v1/spare-alerts?store_code={seeded[0].code}").status_code == 401


def test_endpoint_unknown_and_switched_off_store(client, store):
    s = store[0]
    c = _login(client, role="ADMIN")
    assert c.get("/api/v1/spare-alerts?store_code=NOPE_STORE").status_code == 404
    s.is_active = False
    db.session.commit()
    assert c.get(f"/api/v1/spare-alerts?store_code={s.code}").status_code == 400


def test_endpoint_on_the_spare_store(client):
    # The real store: whatever the shared DB holds, the summary must tie out.
    c = _login(client, stores=("MAINTENANCE",))
    body = c.get("/api/v1/spare-alerts?store_code=MAINTENANCE").get_json()["data"]
    heads = [x for x in body["alerts"] if x["parent"] is None]
    counts = {sev: sum(1 for x in heads if x["severity"] == sev) for sev in ("critical", "warning", "info")}
    assert body["summary"] == {**counts, "total": len(heads)}
    assert all(x["action"] is None or x["action"]["to"].startswith("/") for x in body["alerts"])
    assert all(x["action"] is None or x["action"]["module"] for x in body["alerts"])
    assert len({x["id"] for x in body["alerts"]}) == len(body["alerts"])
