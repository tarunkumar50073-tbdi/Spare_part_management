"""The management block (/api/v1/dashboard/spare/management) and the notes an
administrator saves on its Action Tracker (/action-tracker/<key>).

The test database is shared by the whole session, so every figure is asserted
on a section made for the test — or, at store level, relationally against the
overview — never as a store-wide absolute. One part per stock status, as in
test_spare_overview:

    A  0 on hand, min 2, max 10, rate 100   -> Out of Stock   (restock 10 x 100)
    B  1,          min 5, max 20, rate 10   -> Below Minimum  (restock 19 x 10)
    C  6, min 2, reorder 6, max 12, rate 5  -> Reorder        (restock 6 x 5)
    D  30,         min 2, max 10, rate 50   -> Above Maximum  (excess 20 x 50)
    E  5,          min 2, max 10, no rate   -> Healthy
    F  never counted, nothing planned, no rate -> Not Counted
"""
import json
from datetime import date, datetime, time, timedelta

import pytest

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.base import utcnow
from app.models.erp_stock import ERPStock
from app.models.gate_entry import GateEntry
from app.models.part import Part
from app.models.part_request import PartRequest
from app.models.put_away_log import PutAwayLog
from app.models.receiving_register import ReceivingRegister
from app.models.scan_audit import ScanAudit
from app.models.spare_flow import SpareTransaction
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.models.store import Section, Store
from app.models.user import User, UserStoreAccess
from app.services import spare_management_service as management_module
from app.services.consumption_analytics_service import _local_offset
from app.services.erp_grn_posting_service import ErpGrnPostingService
from app.services.spare_dashboard_service import SpareDashboardService
from app.services.spare_management_service import SETTING_KEY, TRACKER_ITEMS, SpareManagementService
from app.services.spare_stock_service import SpareStockService
from app.utils import event_bus

STORE = "MAINTENANCE"
BASE = "/api/v1/dashboard/spare"
BUCKETS = ["0-30", "31-90", "91+", "none"]
_seq = {"n": 0}


@pytest.fixture(autouse=True)
def mirror_cache_off(app):
    """The running app keeps the ERP-mirror aggregates for minutes. A test must
    read what it just seeded, never another test's cached copy."""
    before = app.config.get("SPARE_MGMT_CACHE_TTL")
    app.config["SPARE_MGMT_CACHE_TTL"] = 0
    try:
        yield
    finally:
        if before is None:
            app.config.pop("SPARE_MGMT_CACHE_TTL", None)
        else:
            app.config["SPARE_MGMT_CACHE_TTL"] = before


@pytest.fixture()
def tracker_notes():
    """The saved notes are ONE settings row shared by the whole session — put
    it back the way it was."""
    row = AppSetting.query.filter_by(key=SETTING_KEY).first()
    before = row.value if row else None
    try:
        yield
    finally:
        db.session.rollback()
        row = AppSetting.query.filter_by(key=SETTING_KEY).first()
        if row is not None and before is None:
            db.session.delete(row)
        elif row is not None:
            row.value = before
        db.session.commit()


@pytest.fixture()
def client(app):
    return app.test_client()


def _n():
    _seq["n"] += 1
    return _seq["n"]


def _section(tag="Section"):
    store = Store.query.filter_by(code=STORE).first()
    s = Section(store_id=store.id, name=f"MG {tag} {_n()}")
    db.session.add(s)
    db.session.commit()
    return s


def _part(sec, tag, qty, mn=0, mx=None, ro=None, rate=None, loc="R1-S1-B1"):
    p = Part(part_no=f"MG-{_n()}-{tag}", part_name=f"Management {tag}", uom="NO",
             part_type="OTHER", store_code=STORE, section_id=sec.id, location=loc,
             min_stock_level=mn, max_stock_level=mx, reorder_level=ro, unit_price=rate)
    db.session.add(p)
    db.session.commit()
    if qty is not None:
        db.session.add(SpareStock(part_id=p.id, qty_on_hand=qty))
        db.session.commit()
    return p


@pytest.fixture()
def seeded():
    sec = _section()
    parts = {
        "A": _part(sec, "A", 0, mn=2, mx=10, rate=100),
        "B": _part(sec, "B", 1, mn=5, mx=20, rate=10),
        "C": _part(sec, "C", 6, mn=2, mx=12, ro=6, rate=5),
        "D": _part(sec, "D", 30, mn=2, mx=10, rate=50),
        "E": _part(sec, "E", 5, mn=2, mx=10),
        "F": _part(sec, "F", None, loc=""),
    }
    return sec, parts


def _login(client, role="STORE_USER", perms=None, stores=(STORE,)):
    u = User(username=f"mguser{_n()}", role=role, is_active=True)
    u.set_password("pw")
    if perms:
        u.set_permissions(perms)
    db.session.add(u)
    db.session.flush()
    for code in stores:
        db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
    db.session.commit()
    with client.session_transaction() as s:
        s["user_id"] = u.id
    return client, u


def _grn(item_cd, day, receipt=1, accept=None):
    """One ERP GRN line. The mirror always carries store_code CHILD_PART."""
    db.session.add(ReceivingRegister(store_code="CHILD_PART", grn_no=f"GRN-MG-{_n()}", item_cd=item_cd,
                                     grn_date=day, receipt_qty=receipt, accept_qty=accept))
    db.session.commit()


def _gate(item_code, day):
    # No vendor on the row, so it never becomes another test's "last supplier".
    db.session.add(GateEntry(store_code="CHILD_PART", gate_entry_no=f"GE-MG-{_n()}", item_code=item_code,
                             gate_entry_dt=day, qty=1))
    db.session.commit()


def _ledger(part, delta, txn_type, at=None, **cols):
    """A raw ledger row, optionally back-dated (`at` = naive UTC, as stored)."""
    row = SpareStockLedger(part_id=part.id, qty_delta=delta, balance_after=0, txn_type=txn_type, **cols)
    if at is not None:
        row.created_at = at
    db.session.add(row)
    db.session.commit()
    return row


def _months(today):
    """The first day of the last six months, oldest first."""
    out = [today.replace(day=1)]
    while len(out) < 6:
        out.append((out[-1] - timedelta(days=1)).replace(day=1))
    return out[::-1]


def _plant(day, clock=time(12)):
    """A plant-clock moment as the naive UTC instant the ledger stores."""
    return datetime.combine(day, clock) - _local_offset()


def _items(payload):
    return {it["key"]: it for it in payload["tracker"]["items"]}


# ---- permissions ----

def test_management_endpoint_permissions(client):
    url = f"{BASE}/management?store_code={STORE}"
    c, _ = _login(client)                                              # store access, no right
    assert c.get(url).status_code == 403
    c, _ = _login(client, perms={"live_dashboard": {"view": True}}, stores=())
    assert c.get(url).status_code == 403                               # the right, not the store

    c, _ = _login(client, perms={"live_dashboard": {"view": True}})    # the wallboard account
    assert c.get(f"{BASE}/management").status_code == 400
    r = c.get(url)
    assert r.status_code == 200
    body = r.get_json()["data"]
    assert {"store_code", "section_id", "section_ids", "generated_at", "as_of",
            "tracker", "excess_aging", "movement", "scan"} <= set(body)
    assert body["tracker"]["can_edit"] is False

    c, _ = _login(client, role="ADMIN", stores=())
    assert c.get(url).get_json()["data"]["tracker"]["can_edit"] is True


def test_a_stray_section_in_the_url_never_breaks_the_dashboard(client, seeded):
    """A section id that is not one is dropped, as the helper promises — "²"
    is a digit to str.isdigit but not to int, and twenty digits do not fit the
    database's INTEGER."""
    sec, _ = seeded
    c, _ = _login(client, role="ADMIN", stores=())
    for path in ("management", "overview"):
        url = f"{BASE}/{path}?store_code={STORE}"
        for stray in ("section_ids=%C2%B2", "section_ids=" + "9" * 20, "section_id=" + "9" * 20,
                      "section_id=%C2%B2", "section_ids=,,x,"):
            r = c.get(f"{url}&{stray}")
            assert r.status_code == 200, (path, stray)
            data = r.get_json()["data"]
            assert (data["section_id"], data["section_ids"]) == (None, None), (path, stray)
        # A real id beside a stray one still narrows the call.
        data = c.get(f"{url}&section_ids=%C2%B2,{sec.id},{'9' * 20}").get_json()["data"]
        assert data["section_ids"] == [sec.id]
        assert c.get(f"{url}&section_id={sec.id}").get_json()["data"]["section_id"] == sec.id


def test_action_tracker_put_is_admin_only(client, tracker_notes):
    url = f"{BASE}/action-tracker/critical"
    c, _ = _login(client, perms={"spare_store": {"view": True, "edit": True},
                                 "live_dashboard": {"view": True}})
    assert c.put(url, json={"store_code": STORE, "owner": "Not an admin"}).status_code == 403
    assert "Not an admin" not in json.dumps(AppSetting.get_value(SETTING_KEY))

    c, admin = _login(client, role="ADMIN", stores=())
    assert c.put(url, json={"owner": "Purchase"}).status_code == 400   # store_code is required
    bus = event_bus.subscribe()
    try:
        r = c.put(url, json={"store_code": STORE, "owner": "Purchase — Mr. Sharma"})
        assert r.status_code == 200
        # Open dashboards and the wallboard refetch on the "stock" push.
        assert json.loads(bus.get_nowait()) == {
            "event": "stock", "data": {"store_code": STORE, "action": "action_tracker"}}
    finally:
        event_bus.unsubscribe(bus)
    assert r.get_json()["data"]["updated_by"] == admin.username


# ---- action tracker ----

def test_tracker_figures_for_a_section(seeded):
    sec, _ = seeded
    m = SpareManagementService().management(STORE, section_id=sec.id)
    assert (m["store_code"], m["section_id"], m["section_ids"]) == (STORE, sec.id, None)
    assert m["as_of"] == date.today().isoformat()

    t = m["tracker"]
    # The store-only lines (the ERP queues) are left out of a section call.
    assert [it["key"] for it in t["items"]] == [
        "critical", "reorder", "excess", "confirm_pending", "kiosk_open",
        "returns_pending", "rgp_overdue", "no_rate"]
    it = _items(m)
    here = [{"section_id": sec.id, "name": sec.name, "count": 2}]

    crit = it["critical"]
    assert (crit["count"], crit["value"], crit["value_label"]) == (2, 1000 + 190, "to restock to max")
    assert crit["detail"] == "1 zero stock · 1 below minimum"
    assert (crit["severity"], crit["status"], crit["scope"]) == ("critical", "OPEN", "section")
    assert crit["sections"] == here
    assert crit["link"] == {"label": "Open list", "to": "/store-stock-spare", "status": "Critical"}
    assert (crit["action"], crit["owner"], crit["owner_is_default"]) == ("Raise / expedite PO", "Purchase", True)
    assert (crit["target_date"], crit["overdue"], crit["days_to_target"], crit["remarks"]) == (None, False, None, "")
    assert (crit["updated_by"], crit["updated_at"]) == (None, None)

    assert (it["reorder"]["count"], it["reorder"]["value"], it["reorder"]["severity"]) == (1, 30.0, "warning")
    excess = it["excess"]
    assert (excess["count"], excess["value"], excess["value_label"]) == (1, 1000.0, "tied up above max")
    # D has never come in, so all of it is undated — said only when the ERP
    # mirror has a horizon to date it against.
    horizon = m["excess_aging"]["horizon"]
    assert excess["detail"] == (
        f"₹ 1,000 with no ERP inward on record since {date.fromisoformat(horizon):%d %b}" if horizon else "")
    no_rate = it["no_rate"]                                             # E and F
    assert (no_rate["count"], no_rate["severity"], no_rate["status"], no_rate["sections"]) == (2, "info", "OPEN", here)
    assert no_rate["detail"] == "Not valued — left out of stock value and excess"
    for key in ("confirm_pending", "kiosk_open", "returns_pending", "rgp_overdue"):
        line = it[key]
        # A zero count is never a warning — it is simply "ok".
        assert (line["count"], line["status"], line["severity"]) == (0, "CLEAR", "ok")
        assert (line["value"], line["value_label"], line["detail"], line["sections"]) == (None, None, "", [])

    assert t["summary"] == {"open": 4, "clear": 4, "overdue": 0, "critical_parts": 2,
                            "to_restock": 1220.0, "tied_up": 1000.0}
    # The restock money is the overview's, split by status.
    assert crit["value"] + it["reorder"]["value"] == t["summary"]["to_restock"]
    ov = SpareDashboardService().overview(STORE, section_id=sec.id)
    assert (t["summary"]["to_restock"], t["summary"]["tied_up"]) == (ov["value"]["to_restock"], ov["value"]["excess"])
    assert t["can_edit"] is False                                       # no user: nobody to edit

    # A group wins over a single section, and is not the whole store either.
    grp = SpareManagementService().management(STORE, section_id=10 ** 9, section_ids=[sec.id])
    assert (grp["section_ids"], _items(grp)["critical"]["count"]) == ([sec.id], 2)
    assert "srv_pending" not in _items(grp)
    assert grp["scan"]["not_found_scope"] == "section"


def test_store_level_tracker_adds_the_store_only_lines(seeded):
    _, p = seeded
    gap_before = _items(SpareManagementService().management(STORE))["erp_gap"]["count"]
    # ERP's snapshot against the count: A 0 on hand vs 5 (short), D 30 vs 10
    # (excess), C 6 vs 6 (match); F has an ERP figure and no count at all.
    for key, erp_qty in (("A", 5), ("D", 10), ("C", 6), ("F", 3)):
        db.session.add(ERPStock(part_id=p[key].id, qty_on_hand=erp_qty, synced_at=utcnow()))
    db.session.commit()

    m = SpareManagementService().management(STORE)
    it = _items(m)
    assert list(it) == [spec["key"] for spec in TRACKER_ITEMS]
    assert {k for k, line in it.items() if line["scope"] == "store"} == {"srv_pending", "erp_gap", "erp_pending"}
    assert it["srv_pending"]["link"] == {"label": "Open Receiving & GRN", "to": "/receiving"}

    # Every count shared with the overview is the overview's own.
    ov = SpareDashboardService().overview(STORE)
    att = {a["key"]: a for a in ov["attention"]}
    assert it["critical"]["count"] == att["zero_stock"]["count"] + att["below_min"]["count"]
    assert it["reorder"]["count"] == att["reorder"]["count"]
    assert (it["excess"]["count"], it["excess"]["value"]) == (att["excess"]["count"], att["excess"]["value"])
    assert m["tracker"]["summary"]["to_restock"] == ov["value"]["to_restock"]
    assert it["critical"]["value"] + it["reorder"]["value"] == pytest.approx(ov["value"]["to_restock"], abs=0.011)
    assert it["srv_pending"]["count"] == ov["receiving_pending"]["total"]
    assert it["erp_pending"]["count"] == att["erp_pending"]["count"]
    assert it["confirm_pending"]["count"] == att["confirm_pending"]["count"]
    assert it["no_rate"]["count"] == ov["data_quality"]["missing_rate"]
    returns = ov["returns_pending"]
    assert it["returns_pending"]["count"] == returns["inspection"] + returns["hold"] + returns["damaged"]
    assert it["rgp_overdue"]["count"] == ov["rgp"]["overdue"]
    # The ERP vs Physical screen's own figures.
    gap = SpareStockService().erp_gap_summary(STORE)
    assert it["erp_gap"]["count"] == gap["short"] + gap["excess"] == gap_before + 2
    assert it["erp_gap"]["detail"] == f"{gap['short']:,} short · {gap['excess']:,} excess vs the ERP snapshot"

    summary = m["tracker"]["summary"]
    assert summary["open"] + summary["clear"] == len(it)
    assert m["scan"]["not_found_scope"] == "store"


def test_tracker_notes_are_saved_and_reflected(client, seeded, tracker_notes):
    sec, _ = seeded
    c, admin = _login(client, role="ADMIN", stores=())
    past = (date.today() - timedelta(days=3)).isoformat()

    def put(key, **body):
        return c.put(f"{BASE}/action-tracker/{key}", json={"store_code": STORE, **body})

    def line(key):
        r = c.get(f"{BASE}/management?store_code={STORE}&section_id={sec.id}")
        return _items(r.get_json()["data"])[key], r.get_json()["data"]["tracker"]["summary"]

    r = put("critical", owner="  Purchase — Mr. Sharma ", target_date=past, remarks="PO raised for top 40")
    assert r.status_code == 200
    saved = r.get_json()["data"]
    assert {k: saved[k] for k in saved if k != "updated_at"} == {
        "key": "critical", "owner": "Purchase — Mr. Sharma", "owner_is_default": False,
        "target_date": past, "remarks": "PO raised for top 40", "updated_by": admin.username}
    assert datetime.fromisoformat(saved["updated_at"]).tzinfo is not None      # aware UTC

    # One settings row, {store: {line: note}}.
    assert AppSetting.get_value(SETTING_KEY)[STORE]["critical"]["owner"] == "Purchase — Mr. Sharma"
    crit, summary = line("critical")
    assert (crit["owner"], crit["owner_is_default"]) == ("Purchase — Mr. Sharma", False)
    assert (crit["target_date"], crit["remarks"], crit["updated_by"]) == (past, "PO raised for top 40", admin.username)
    assert crit["updated_at"] == saved["updated_at"]
    # An open point past its date is overdue ...
    assert (crit["status"], crit["overdue"], crit["days_to_target"]) == ("OPEN", True, -3)
    assert summary["overdue"] == 1
    # ... a cleared one with the same date met it.
    assert put("rgp_overdue", target_date=past).status_code == 200
    rgp, summary = line("rgp_overdue")
    assert (rgp["status"], rgp["overdue"], rgp["days_to_target"]) == ("CLEAR", False, -3)
    assert summary["overdue"] == 1

    # Only the fields sent change.
    assert put("critical", remarks="Follow-up on Friday").status_code == 200
    crit, _ = line("critical")
    assert (crit["owner"], crit["target_date"], crit["remarks"]) == ("Purchase — Mr. Sharma", past, "Follow-up on Friday")
    # An empty owner goes back to the default; null clears the date.
    cleared = put("critical", owner="", target_date=None).get_json()["data"]
    assert (cleared["owner"], cleared["owner_is_default"], cleared["target_date"]) == ("Purchase", True, None)
    crit, summary = line("critical")
    assert (crit["owner"], crit["owner_is_default"], crit["overdue"], crit["days_to_target"]) == ("Purchase", True, False, None)
    assert (crit["remarks"], summary["overdue"]) == ("Follow-up on Friday", 0)
    ahead = (date.today() + timedelta(days=5)).isoformat()
    assert put("critical", target_date=ahead).status_code == 200
    crit, _ = line("critical")
    assert (crit["overdue"], crit["days_to_target"]) == (False, 5)


def test_tracker_note_validation(client, tracker_notes):
    c, _ = _login(client, role="ADMIN", stores=())

    def put(key, **body):
        return c.put(f"{BASE}/action-tracker/{key}", json={"store_code": STORE, **body})

    assert put("critical", owner="x" * 60, remarks="y" * 200).status_code == 200    # at the limits
    assert put("no_such_line", owner="Purchase").status_code == 400
    assert put("critical", target_date="31-10-2026").status_code == 400
    assert put("critical", target_date="2026-02-30").status_code == 400
    assert put("critical", owner="x" * 61).status_code == 400
    assert put("critical", remarks="y" * 201).status_code == 400
    assert put("critical", owner=["Purchase"]).status_code == 400
    # A body that is not a JSON object carries no store_code.
    assert c.put(f"{BASE}/action-tracker/critical", json=["owner", "Purchase"]).status_code == 400
    # A note is kept per store: a code that is not a store has nowhere to show.
    for code in ("NO_SUCH_STORE", f" {STORE} ", "Z" * 5000):
        r = c.put(f"{BASE}/action-tracker/critical", json={"store_code": code, "owner": "Purchase"})
        assert r.status_code == 400, code
    # A refused save changes nothing.
    saved = AppSetting.get_value(SETTING_KEY)
    assert set(saved) <= {s.code for s in Store.query.all()}
    note = saved[STORE]["critical"]
    assert (note["owner"], note["remarks"], note["target_date"]) == ("x" * 60, "y" * 200, None)


# ---- excess aging ----

def test_excess_aging_buckets_by_last_inward():
    sec = _section("Aging")
    today = date.today()
    edge30 = _part(sec, "E30", 30, mx=10, rate=50)        # 20 over x 50  = 1000
    edge90 = _part(sec, "E90", 20, mx=10, rate=20)        # 10 over x 20  = 200
    old = _part(sec, "OLD", 15, mx=10, rate=10)           # 5 over x 10   = 50
    never = _part(sec, "NEVER", 40, mx=10, rate=100)      # 30 over x 100 = 3000
    unrated = _part(sec, "NORATE", 12, mx=10)             # counted, never valued
    posted = _part(sec, "POSTED", 13, mx=10, rate=1)      # 3 over x 1    = 3
    _part(sec, "FINE", 5, mx=10, rate=999)                # not above max: never in the block

    _grn(edge30.part_no, today - timedelta(days=200))
    _grn(edge30.part_no, today - timedelta(days=30))      # the latest inward counts
    _grn(edge90.part_no, today - timedelta(days=100))
    _gate(edge90.part_no, today - timedelta(days=90))     # the gate entry is the later of the two
    _grn(old.part_no, today - timedelta(days=91))
    _grn(unrated.part_no, today - timedelta(days=5))
    # No ERP inward at all: only then does the app's own stock-in date it.
    _ledger(posted, 3, "RECEIPT", status="ERP_GRN")

    a = SpareManagementService().management(STORE, section_id=sec.id)["excess_aging"]
    assert (a["basis"], a["as_of"]) == ("last_inward_erp", today.isoformat())
    assert set(a["erp"]) == {"synced_at", "newest_grn_date"}
    # The horizon is the mirror's earliest date (other tests' rows included).
    assert a["horizon"] <= (today - timedelta(days=200)).isoformat()
    assert a["horizon_days"] == (today - date.fromisoformat(a["horizon"])).days

    assert a["total"] == {"parts": 6, "value": 4253.0, "unrated": 1}
    assert [b["key"] for b in a["buckets"]] == BUCKETS
    by = {b["key"]: (b["parts"], b["value"], b["unrated"]) for b in a["buckets"]}
    assert by == {"0-30": (3, 1003.0, 1), "31-90": (1, 200.0, 0), "91+": (1, 50.0, 0), "none": (1, 3000.0, 0)}
    assert a["buckets"][0]["label"] == "0–30 days" and a["buckets"][3]["label"] == "No inward on record"
    assert a["idle"] == {"parts": 2, "value": 3050.0}                    # "91+" and "none"

    # Rated parts only, dearest first.
    assert [p["part_id"] for p in a["top"]] == [never.id, edge30.id, edge90.id, old.id, posted.id]
    assert [p["excess_value"] for p in a["top"]] == [3000.0, 1000.0, 200.0, 50.0, 3.0]
    top = {p["part_id"]: p for p in a["top"]}
    assert top[never.id] == {
        "part_id": never.id, "part_no": never.part_no, "part_name": "Management NEVER",
        "section_id": sec.id, "section": sec.name, "qty_on_hand": 40.0, "max_stock_level": 10.0,
        "excess_qty": 30.0, "excess_value": 3000.0,
        "last_inward": None, "last_inward_source": None, "days_since_inward": None, "bucket": "none"}

    def dated(part):
        p = top[part.id]
        return p["last_inward"], p["last_inward_source"], p["days_since_inward"], p["bucket"]

    assert dated(edge30) == ((today - timedelta(days=30)).isoformat(), "GRN", 30, "0-30")
    assert dated(edge90) == ((today - timedelta(days=90)).isoformat(), "GATE", 90, "31-90")
    assert dated(old) == ((today - timedelta(days=91)).isoformat(), "GRN", 91, "91+")
    assert dated(posted) == (today.isoformat(), "LEDGER", 0, "0-30")

    # No excess at all: still the four buckets, in order, at zero.
    none = SpareManagementService().management(STORE, section_id=_section("No excess").id)["excess_aging"]
    assert [(b["key"], b["parts"], b["value"], b["unrated"]) for b in none["buckets"]] == [(k, 0, 0.0, 0) for k in BUCKETS]
    assert (none["total"], none["idle"], none["top"]) == ({"parts": 0, "value": 0.0, "unrated": 0},
                                                           {"parts": 0, "value": 0.0}, [])


# ---- movement ----

def test_movement_months_in_and_out():
    sec = _section("Movement")
    rated = _part(sec, "RATED", 50, rate=25)
    bare = _part(sec, "BARE", 50)                                        # no rate: moves, carries no value
    today = date.today()
    months = _months(today)

    # The register holds every month of the window from its first day ...
    _grn(f"MG-NO-PART-{_n()}", months[0] - timedelta(days=1))
    _grn(rated.part_no, months[2] + timedelta(days=9), receipt=4, accept=4)
    _grn(bare.part_no, months[2] + timedelta(days=11), receipt=7)        # quality pending, unrated
    _grn(rated.part_no, today, receipt=2)                                # ... to today; quality pending
    # The section's ledger starts in the fourth month; issues follow it.
    _ledger(rated, 50, "OPENING", at=_plant(months[3] + timedelta(days=14)))
    # 00:30 plant time on the 1st is still the previous day in UTC when the
    # plant is ahead of it: the month is cut on the plant clock.
    _ledger(rated, -4, "ISSUE", at=_plant(months[4], time(0, 30)), department="Maintenance", status="INSTALLED")
    _ledger(bare, -2, "ISSUE", at=_plant(months[4] + timedelta(days=9)), department="Maintenance", status="INSTALLED")
    _ledger(rated, 3, "RECEIPT", status="ERP_GRN")                       # stocked in the app, now

    mv = SpareManagementService().management(STORE, section_id=sec.id)["movement"]
    rows = mv["months"]

    def col(key):
        return [r[key] for r in rows]

    assert col("period") == [f"{m:%Y-%m}" for m in months]               # oldest to newest
    assert col("label") == [f"{m:%b}" for m in months]
    assert col("current") == [False] * 5 + [True]
    # IN: the ERP GRN register x today's rate; a covered month with nothing is a real 0.
    assert col("in_value") == [0.0, 0.0, 100.0, 0.0, 0.0, 50.0]
    assert col("in_qty") == [0.0, 0.0, 11.0, 0.0, 0.0, 2.0]
    assert col("in_lines") == [0, 0, 2, 0, 0, 1]
    assert col("accepted_value") == [0.0, 0.0, 100.0, 0.0, 0.0, 0.0]
    assert col("pending_lines") == [0, 0, 1, 0, 0, 1]
    # OUT: unknown before the section's first ledger row, measured from its month on.
    assert col("out_value") == [None, None, None, 0.0, 100.0, 0.0]
    assert col("out_qty") == [None, None, None, 0.0, 6.0, 0.0]
    assert col("out_lines") == [0, 0, 0, 0, 2, 0]
    assert col("app_in_value") == [0.0] * 5 + [75.0]
    assert col("app_in_qty") == [0.0] * 5 + [3.0]

    assert mv["issues_recorded"] is True
    assert mv["issue_tracking_since"] == (months[3] + timedelta(days=14)).isoformat()
    assert mv["this_month"] == {"period": f"{today:%Y-%m}", "in_value": 50.0, "out_value": 0.0, "net_value": 50.0}
    assert mv["unrated_parts"] == 1
    assert set(mv["erp"]) == {"synced_at", "newest_grn_date", "coverage_from"}
    assert mv["erp"]["coverage_from"] <= (months[0] - timedelta(days=1)).isoformat()
    assert mv["erp"]["newest_grn_date"] >= today.isoformat()
    assert "ERP GRN register" in mv["in_source"] and "issue ledger" in mv["out_source"]

    # A section with no ledger row at all: nothing is known about its issues.
    quiet = SpareManagementService().management(STORE, section_id=_section("Quiet").id)["movement"]
    assert (quiet["issues_recorded"], quiet["issue_tracking_since"]) == (False, None)
    assert all(r["out_value"] is None and r["out_qty"] is None for r in quiet["months"])
    assert quiet["this_month"]["net_value"] is None


def test_movement_is_null_outside_the_register_window(monkeypatch):
    """The ERP register is a rolling window: a month it holds only in part, or
    not at all, is None — never a zero bar."""
    sec = _section("Coverage")
    part = _part(sec, "COV", 5, rate=10)
    today = date.today()
    months = _months(today)
    _grn(part.part_no, months[1] + timedelta(days=20), receipt=9)        # in the half-held month
    _grn(part.part_no, months[3] + timedelta(days=2), receipt=6, accept=6)
    _grn(part.part_no, today, receipt=1)                                 # after the register's newest GRN

    # The register holds the 2nd of the second month to the 6th of the fifth.
    held_from = months[1] + timedelta(days=1)
    monkeypatch.setattr(SpareManagementService, "_last_inward", staticmethod(
        lambda: {"grn": {}, "gate": {}, "grn_from": held_from, "gate_from": None}))
    monkeypatch.setattr(ErpGrnPostingService, "mirror_freshness", lambda self: {
        "synced_at": None, "newest_grn_date": (months[4] + timedelta(days=5)).isoformat()})

    mv = SpareManagementService().management(STORE, section_id=sec.id)["movement"]
    assert [r["in_value"] for r in mv["months"]] == [None, None, 0.0, 60.0, 0.0, None]
    assert [r["in_qty"] for r in mv["months"]] == [None, None, 0.0, 6.0, 0.0, None]
    assert [r["accepted_value"] for r in mv["months"]] == [None, None, 0.0, 60.0, 0.0, None]
    assert [r["in_lines"] for r in mv["months"]] == [0, 0, 0, 1, 0, 0]
    assert mv["erp"]["coverage_from"] == held_from.isoformat()
    assert mv["this_month"]["in_value"] is None and mv["this_month"]["net_value"] is None


# ---- scan ----

def _scan(part, source, result="SUCCESS", user="mg-op-1", at=None):
    row = ScanAudit(scanned_code=part.part_no if part else "MG-NOT-A-PART", part_id=part.id if part else None,
                    scan_source=source, scan_mode="LOOKUP", result=result, user=user, store_code=STORE)
    if at is not None:
        row.created_at = at
    db.session.add(row)
    db.session.commit()


def test_scan_counts_for_a_section():
    sec = _section("Scan")
    part = _part(sec, "SCAN", 5)
    before = SpareManagementService().management(STORE)["scan"]["scans"]

    for source in ("USB_SCANNER", "USB_SCANNER", "BLUETOOTH_SCANNER", "TABLET_CAMERA"):
        _scan(part, source)
    _scan(part, "MANUAL_ENTRY")
    _scan(part, "MANUAL_ENTRY", user="mg-op-2")
    _scan(None, "USB_SCANNER", result="UNKNOWN_BARCODE")                 # a code that is no part
    _scan(None, "MANUAL_ENTRY", result="UNKNOWN_BARCODE")
    forty_days_ago = utcnow().replace(tzinfo=None) - timedelta(days=40)
    _scan(part, "MANUAL_ENTRY", at=forty_days_ago)                       # the 30 days before
    _scan(part, "MANUAL_ENTRY", at=forty_days_ago)
    _scan(part, "USB_SCANNER", at=utcnow().replace(tzinfo=None) - timedelta(days=70))   # older than both

    scan = SpareManagementService().management(STORE, section_id=sec.id)["scan"]
    assert scan["window_days"] == 30
    s = scan["scans"]
    assert (s["total"], s["scanned"], s["typed"], s["not_found"]) == (6, 4, 2, 0)
    assert (s["scanned_ok"], s["typed_ok"], s["users"], s["scan_first_pct"]) == (4, 2, 2, 66.7)
    last_at = datetime.fromisoformat(s["last_at"])
    assert last_at.tzinfo is None and abs(utcnow().replace(tzinfo=None) - last_at) < timedelta(minutes=5)
    assert scan["prev"] == {"total": 2, "scanned": 0, "scan_first_pct": 0.0}
    # A code that was not found has no part, so no section to count it in.
    assert scan["not_found_scope"] == "section"

    # The whole store counts them.
    after = SpareManagementService().management(STORE)["scan"]["scans"]
    grew = {k: after[k] - before[k] for k in ("total", "scanned", "typed", "not_found", "scanned_ok", "typed_ok")}
    assert grew == {"total": 8, "scanned": 5, "typed": 3, "not_found": 2, "scanned_ok": 4, "typed_ok": 2}
    assert after["total"] == after["scanned_ok"] + after["typed_ok"] + after["not_found"]


def test_scan_with_no_rows_has_no_percentage():
    scan = SpareManagementService().management(STORE, section_id=_section("Silent").id)["scan"]
    assert scan["scans"] == {"total": 0, "scanned": 0, "typed": 0, "not_found": 0, "scanned_ok": 0,
                             "typed_ok": 0, "users": 0, "last_at": None, "scan_first_pct": None}
    assert scan["prev"] == {"total": 0, "scanned": 0, "scan_first_pct": None}
    assert scan["issues"] == {"total": 0, "by_scan": 0, "by_search": 0, "unrecorded": 0, "by_scan_pct": None}
    assert scan["put_away"] == {"count": 0, "with_lot_tag": 0, "users": 0, "last_at": None, "ever": False}
    assert scan["kiosk"] == {"open": 0, "issued": 0, "oldest_open_at": None}


def test_issues_put_aways_and_kiosk_requests_of_a_section():
    sec = _section("Flows")
    part = _part(sec, "FLOW", None)
    other = _part(sec, "OTHER", 5)
    stock = SpareStockService()
    stock.set_quantity(part.id, 20, txn_type="OPENING")
    for source in ("QR_SCAN", "kiosk_request", "ERP_SEARCH", None):
        stock.issue(part.id, 1, "Maintenance", user="tester", scan_source=source)
    now = utcnow().replace(tzinfo=None)
    # An issue with no journal row is unrecorded. A journal row of ANOTHER part
    # carrying its ledger id (SQLite hands a freed id out again) is not its own.
    bare = _ledger(part, -1, "ISSUE", department="Maintenance", status="INSTALLED")
    db.session.add(SpareTransaction(part_id=other.id, store_code=STORE, txn_type="ISSUE", qty=1,
                                    issue_id=bare.id, scan_source="QR_SCAN"))
    _ledger(part, -1, "ISSUE", department="Maintenance", status="CANCELLED")          # never counted
    _ledger(part, -1, "ISSUE", at=now - timedelta(days=40), department="Maintenance", status="INSTALLED")

    for gate_entry_no, put_by, age in (("GE-1", "sup-a", 0), (None, "sup-b", 0), ("GE-0", "sup-a", 40)):
        row = PutAwayLog(part_id=part.id, part_no=part.part_no, assigned_location="R1-S1-B1",
                         scanned_location="R1-S1-B1", gate_entry_no=gate_entry_no, section_id=sec.id,
                         store_code=STORE, put_by=put_by, confirmed_at=now - timedelta(days=age))
        row.created_at = now - timedelta(days=age)
        db.session.add(row)
    for status, raised, issued_at in (("PENDING", now - timedelta(hours=5), None),
                                      ("PENDING", now - timedelta(hours=1), None),
                                      ("ISSUED", now - timedelta(hours=9), now),
                                      ("ISSUED", now - timedelta(days=41), now - timedelta(days=40)),
                                      ("CANCELLED", now - timedelta(days=2), None)):
        row = PartRequest(reference_no=f"REQ-MG-{_n()}", store_code=STORE, part_id=part.id, part_no=part.part_no,
                          requested_qty=1, issued_qty=0, status=status, issued_at=issued_at)
        row.created_at = raised
        db.session.add(row)
    db.session.commit()

    m = SpareManagementService().management(STORE, section_id=sec.id)
    scan = m["scan"]
    assert scan["issues"] == {"total": 5, "by_scan": 2, "by_search": 1, "unrecorded": 2, "by_scan_pct": 40.0}
    put_away = scan["put_away"]
    assert (put_away["count"], put_away["with_lot_tag"], put_away["users"], put_away["ever"]) == (2, 1, 2, True)
    assert abs(now - datetime.fromisoformat(put_away["last_at"])) < timedelta(seconds=1)
    kiosk = scan["kiosk"]
    assert (kiosk["open"], kiosk["issued"]) == (2, 1)
    assert abs(now - timedelta(hours=5) - datetime.fromisoformat(kiosk["oldest_open_at"])) < timedelta(seconds=1)

    it = _items(m)
    assert (it["kiosk_open"]["count"], it["kiosk_open"]["detail"], it["kiosk_open"]["severity"]) == (
        2, "Oldest waiting 5 h", "warning")
    # The four issues made at the counter wait for the fitter's confirmation.
    assert (it["confirm_pending"]["count"], it["confirm_pending"]["status"]) == (4, "OPEN")


# ---- resilience ----

def test_one_unreadable_figure_does_not_fail_the_payload(seeded, monkeypatch):
    sec, _ = seeded
    sec_id = sec.id

    def boom(*args, **kwargs):
        raise RuntimeError("table is locked")

    monkeypatch.setattr(SpareDashboardService, "_rgp", staticmethod(boom))
    monkeypatch.setattr(SpareManagementService, "_last_inward", staticmethod(boom))
    monkeypatch.setattr(SpareManagementService, "_put_aways", staticmethod(boom))

    m = SpareManagementService().management(STORE, section_id=sec_id)
    it = _items(m)
    rgp = it["rgp_overdue"]
    assert (rgp["count"], rgp["status"], rgp["overdue"], rgp["detail"]) == (None, "UNKNOWN", False, "")
    # The rest of the tracker still arrives; an unknown line is neither open nor clear.
    assert (it["critical"]["count"], it["returns_pending"]["status"]) == (2, "CLEAR")
    assert (m["tracker"]["summary"]["open"], m["tracker"]["summary"]["clear"]) == (4, 3)

    aging = m["excess_aging"]
    assert [b["key"] for b in aging["buckets"]] == BUCKETS
    assert all(b["parts"] is None and b["value"] is None for b in aging["buckets"])
    assert (aging["total"]["parts"], aging["horizon"], aging["top"]) == (None, None, [])
    assert it["excess"]["count"] == 1 and it["excess"]["detail"] == ""

    assert all(r["in_value"] is None for r in m["movement"]["months"])
    assert m["movement"]["erp"]["coverage_from"] is None
    assert m["movement"]["issues_recorded"] is False                    # the ledger side was read
    assert m["scan"]["put_away"] == dict.fromkeys(("count", "with_lot_tag", "users", "last_at", "ever"))
    assert m["scan"]["scans"]["total"] == 0


def test_monthly_inward_is_valued_at_a_rate_entered_a_moment_ago(app):
    """Entering a part's rate is itself a tracker action. With the mirror
    aggregates kept as the running app keeps them, the month's inward must be
    valued at the new rate at once, like every other figure of the payload."""
    sec = _section("Rate")
    part = _part(sec, "LATE-RATE", 1)
    today = date.today()
    _grn(f"MG-NO-PART-{_n()}", _months(today)[0] - timedelta(days=1))   # the register holds the whole window
    _grn(part.part_no, today, receipt=4, accept=4)
    management_module._MIRROR_CACHE.clear()
    app.config["SPARE_MGMT_CACHE_TTL"] = 300          # mirror_cache_off puts it back
    try:
        svc = SpareManagementService()
        before = svc.management(STORE, section_id=sec.id)["movement"]
        assert (before["unrated_parts"], before["this_month"]["in_value"]) == (1, 0.0)
        part.unit_price = 250
        db.session.commit()
        after = svc.management(STORE, section_id=sec.id)["movement"]
        assert (after["unrated_parts"], after["this_month"]["in_value"]) == (0, 1000.0)
    finally:
        management_module._MIRROR_CACHE.clear()


def test_mirror_aggregates_are_cached_for_the_ttl(app):
    code = f"MG-CACHED-{_n()}"
    management_module._MIRROR_CACHE.clear()
    app.config["SPARE_MGMT_CACHE_TTL"] = 300          # mirror_cache_off puts it back
    try:
        assert code not in SpareManagementService._last_inward()["grn"]
        _grn(code, date.today())
        assert code not in SpareManagementService._last_inward()["grn"]     # the kept copy
        app.config["SPARE_MGMT_CACHE_TTL"] = 0
        assert SpareManagementService._last_inward()["grn"][code] == date.today()
    finally:
        management_module._MIRROR_CACHE.clear()
