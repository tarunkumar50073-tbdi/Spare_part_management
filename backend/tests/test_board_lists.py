"""The lists behind the Live Board's figures (/api/v1/dashboard/spare/management/list)
and the excess-aging band of every excess part (excess_aging.part_buckets).

Each list must be read by its figure's own rule, so tapping a figure on the
board opens exactly the rows it counts: every assertion below sets a list
against the figure the management block / overview reports for the same scope.
The test database is shared by the session, so each case works on a section
made for it (or, store-wide, compares list and figure read at the same moment).
"""
from collections import Counter
from datetime import date, datetime, time, timedelta

import pytest

from app.extensions import db
from app.models.base import utcnow
from app.models.part import Part
from app.models.put_away_log import PutAwayLog
from app.models.receiving_register import ReceivingRegister
from app.models.scan_audit import ScanAudit
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.models.store import Section, Store
from app.models.user import User, UserStoreAccess
from app.services.consumption_analytics_service import _local_offset
from app.services.spare_dashboard_service import SpareDashboardService
from app.services.spare_management_service import SpareManagementService
from app.services.spare_stock_service import SpareStockService
from app.utils.exceptions import BadRequestError

STORE = "MAINTENANCE"
URL = "/api/v1/dashboard/spare/management/list"
_seq = {"n": 0}


@pytest.fixture(autouse=True)
def mirror_cache_off(app):
    before = app.config.get("SPARE_MGMT_CACHE_TTL")
    app.config["SPARE_MGMT_CACHE_TTL"] = 0
    try:
        yield
    finally:
        if before is None:
            app.config.pop("SPARE_MGMT_CACHE_TTL", None)
        else:
            app.config["SPARE_MGMT_CACHE_TTL"] = before


def _n():
    _seq["n"] += 1
    return _seq["n"]


def _section(tag):
    store = Store.query.filter_by(code=STORE).first()
    s = Section(store_id=store.id, name=f"BL {tag} {_n()}")
    db.session.add(s)
    db.session.commit()
    return s


def _part(sec, tag, qty, mx=None, rate=None):
    p = Part(part_no=f"BL-{_n()}-{tag}", part_name=f"Board list {tag}", uom="NO", part_type="OTHER",
             store_code=STORE, section_id=sec.id, location="R1-S1-B1", min_stock_level=0,
             max_stock_level=mx, unit_price=rate)
    db.session.add(p)
    db.session.commit()
    if qty is not None:
        db.session.add(SpareStock(part_id=p.id, qty_on_hand=qty))
        db.session.commit()
    return p


def _grn(item_cd, day, receipt=1, accept=None):
    db.session.add(ReceivingRegister(store_code="CHILD_PART", grn_no=f"GRN-BL-{_n()}", item_cd=item_cd,
                                     grn_date=day, receipt_qty=receipt, accept_qty=accept))
    db.session.commit()


def _ledger(part, delta, txn_type, at=None, **cols):
    row = SpareStockLedger(part_id=part.id, qty_delta=delta, balance_after=0, txn_type=txn_type, **cols)
    if at is not None:
        row.created_at = at
    db.session.add(row)
    db.session.commit()
    return row


def _plant(day, clock=time(12)):
    """A plant-clock moment as the naive UTC instant the ledger stores."""
    return datetime.combine(day, clock) - _local_offset()


def _months(today):
    out = [today.replace(day=1)]
    while len(out) < 6:
        out.append((out[-1] - timedelta(days=1)).replace(day=1))
    return out[::-1]


def _login(client, perms=None, role="STORE_USER"):
    u = User(username=f"bluser{_n()}", role=role, is_active=True)
    u.set_password("pw")
    if perms:
        u.set_permissions(perms)
    db.session.add(u)
    db.session.flush()
    db.session.add(UserStoreAccess(user_id=u.id, store_code=STORE))
    db.session.commit()
    with client.session_transaction() as s:
        s["user_id"] = u.id
    return client


def _list(kind, key=None, section_id=None):
    return SpareManagementService().board_list(STORE, kind, key, section_id=section_id)


# ---- the endpoint ----

def test_board_list_endpoint_is_the_wallboards_and_read_only(app):
    client = app.test_client()
    c = _login(client)                                                   # store access, no right
    assert c.get(f"{URL}?store_code={STORE}&kind=scans").status_code == 403

    c = _login(client, perms={"live_dashboard": {"view": True}})        # the wallboard account
    assert c.get(f"{URL}?kind=scans").status_code == 400                 # store_code is required
    r = c.get(f"{URL}?store_code={STORE}&kind=scans&key=not_found")
    assert r.status_code == 200
    body = r.get_json()["data"]
    assert {"kind", "key", "rows", "count", "qty", "value"} <= set(body)
    assert (body["kind"], body["key"], body["count"], body["value"]) == ("scans", "not_found", len(body["rows"]), None)
    for bad in ("kind=nope", "kind=scans&key=nope", "kind=in", "kind=in&key=2026-13",
                "kind=out&key=October", "kind=dept"):
        assert c.get(f"{URL}?store_code={STORE}&{bad}").status_code == 400, bad
    # No write verb on the list.
    assert c.post(f"{URL}?store_code={STORE}&kind=scans").status_code == 405


def test_board_list_rejects_what_it_does_not_know():
    with pytest.raises(BadRequestError):
        _list("everything")
    with pytest.raises(BadRequestError):
        _list("issues", "typed")
    assert _list("in", "2026-7")["key"] == "2026-07"                     # a month, normalised


# ---- excess aging: every excess part's band ----

def test_part_buckets_hold_exactly_the_parts_each_band_counts():
    sec = _section("Aging")
    today = date.today()
    fresh = _part(sec, "FRESH", 30, mx=10, rate=50)          # 20 over x 50 = 1000, GRN 5 d ago
    mid = _part(sec, "MID", 20, mx=10, rate=20)              # 10 over x 20 = 200, GRN 60 d ago
    old = _part(sec, "OLD", 15, mx=10, rate=10)              # 5 over x 10 = 50, GRN 120 d ago
    never = _part(sec, "NEVER", 40, mx=10, rate=100)         # 30 over x 100 = 3000, no inward
    unrated = _part(sec, "NORATE", 12, mx=10)                # counted in its band, never valued
    _part(sec, "FINE", 5, mx=10, rate=999)                   # not above max: in no band
    _grn(fresh.part_no, today - timedelta(days=5))
    _grn(mid.part_no, today - timedelta(days=60))
    _grn(old.part_no, today - timedelta(days=120))
    _grn(unrated.part_no, today - timedelta(days=60))

    aging = SpareManagementService().management(STORE, section_id=sec.id)["excess_aging"]
    pb = aging["part_buckets"]
    assert pb == {fresh.id: "0-30", mid.id: "31-90", unrated.id: "31-90", old.id: "91+", never.id: "none"}
    # The board lists a band as these parts: the count and the rupees tie out.
    by = Counter(pb.values())
    rows = {r["part_id"]: r for r in SpareStockService().list_stock(STORE, sec.id)}
    for b in aging["buckets"]:
        parts = [pid for pid, key in pb.items() if key == b["key"]]
        assert len(parts) == by[b["key"]] == b["parts"], b["key"]
        value = sum((rows[p]["qty_on_hand"] - rows[p]["max_stock_level"]) * (rows[p]["unit_price"] or 0) for p in parts)
        assert round(value, 2) == b["value"], b["key"]
    idle = [pid for pid, key in pb.items() if key in ("91+", "none")]
    assert len(idle) == aging["idle"]["parts"]


# ---- material in vs out: a month's bars ----

def test_in_and_out_lists_tie_out_to_each_months_bars():
    sec = _section("Movement")
    rated = _part(sec, "RATED", 50, rate=25)
    bare = _part(sec, "BARE", 50)                                        # no rate: listed, never valued
    today = date.today()
    months = _months(today)
    _grn(f"BL-NO-PART-{_n()}", months[0] - timedelta(days=1))            # the register covers the window
    _grn(rated.part_no, months[2] + timedelta(days=9), receipt=4, accept=4)
    _grn(bare.part_no, months[2] + timedelta(days=11), receipt=7)
    _grn(rated.part_no, today, receipt=2)
    _ledger(rated, 50, "OPENING", at=_plant(months[3] + timedelta(days=14)))
    # 00:30 plant time on the 1st: the month is cut on the plant clock.
    _ledger(rated, -4, "ISSUE", at=_plant(months[4], time(0, 30)), department="Maintenance", status="INSTALLED")
    _ledger(bare, -2, "ISSUE", at=_plant(months[4] + timedelta(days=9)), department="Maintenance", status="INSTALLED")
    _ledger(rated, -1, "ISSUE", at=_plant(months[4] + timedelta(days=10)), department="Maintenance", status="CANCELLED")
    _ledger(rated, -3, "ISSUE", department="Maintenance", status="ISSUED")
    _ledger(rated, 3, "RECEIPT", status="ERP_GRN")                       # an app stock-in: not an In line

    mv = SpareManagementService().management(STORE, section_id=sec.id)["movement"]
    checked_in = checked_out = 0
    for m in mv["months"]:
        if m["in_value"] is not None:
            got = _list("in", m["period"], sec.id)
            assert (got["count"], got["value"], got["qty"]) == (m["in_lines"], m["in_value"], m["in_qty"]), m["period"]
            assert all(r["txn_type"] == "GRN" and r["grn_no"] for r in got["rows"])
            checked_in += 1
        if m["out_value"] is not None:
            got = _list("out", m["period"], sec.id)
            assert (got["count"], got["value"], got["qty"]) == (m["out_lines"], m["out_value"], m["out_qty"]), m["period"]
            assert all(r["txn_type"] == "ISSUE" for r in got["rows"])
            checked_out += 1
    assert checked_in == 6 and checked_out == 3
    # The months with something in them really were listed.
    assert _list("in", f"{months[2]:%Y-%m}", sec.id)["count"] == 2
    busy = _list("out", f"{months[4]:%Y-%m}", sec.id)
    assert busy["count"] == 3 and {r["part_id"] for r in busy["rows"]} == {rated.id, bare.id}
    assert [r["value"] for r in busy["rows"] if r["part_id"] == bare.id] == [None]

    # Store-wide, read at the same moment, list and bar still agree.
    store = SpareManagementService().management(STORE)["movement"]["months"][-1]
    if store["in_value"] is not None:
        assert _list("in", store["period"])["count"] == store["in_lines"]
    if store["out_value"] is not None:
        got = _list("out", store["period"])
        assert (got["count"], got["value"]) == (store["out_lines"], store["out_value"])


# ---- department-wise issue this month ----

def test_dept_list_ties_out_to_this_months_department_split():
    sec = _section("Dept")
    part = _part(sec, "DEPT", 40, rate=10)
    today = date.today()
    first = today.replace(day=1)
    _ledger(part, -2, "ISSUE", at=_plant(first, time(0, 30)), department="Store", status="INSTALLED")
    _ledger(part, -5, "ISSUE", department="Store", status="ISSUED")
    _ledger(part, -1, "ISSUE", department="Store", status="CANCELLED")              # not consumed
    _ledger(part, -9, "ISSUE", at=_plant(first - timedelta(days=1)), department="Store", status="INSTALLED")
    _ledger(part, 4, "RECEIPT", status="ERP_GRN")

    split = SpareDashboardService()._consumption(STORE, sec.id)["this_month_by_department"]
    assert len(split) == 1
    dept = split[0]
    got = _list("dept", dept["name"], sec.id)
    assert (got["count"], got["qty"]) == (2, dept["value"]) == (2, 7.0)
    assert all(r["txn_type"] == "ISSUE" and r["part_id"] == part.id for r in got["rows"])
    # Store-wide: the same department's issues, whatever section of it.
    whole = {d["name"]: d["value"] for d in SpareDashboardService()._consumption(STORE, None)["this_month_by_department"]}
    if dept["name"] in whole:
        assert _list("dept", dept["name"])["qty"] == whole[dept["name"]]
    assert _list("dept", "No such department", sec.id)["count"] == 0


# ---- scan discipline ----

def _scan(part, source, result="SUCCESS", at=None):
    row = ScanAudit(scanned_code=part.part_no if part else f"BL-NOT-A-PART-{_n()}", part_id=part.id if part else None,
                    scan_source=source, scan_mode="LOOKUP", result=result, user="bl-op", store_code=STORE)
    if at is not None:
        row.created_at = at
    db.session.add(row)
    db.session.commit()


def test_scan_issue_and_put_away_lists_tie_out_to_the_scan_tiles():
    sec = _section("Scan")
    part = _part(sec, "SCAN", None)
    for source in ("USB_SCANNER", "TABLET_CAMERA", "USB_SCANNER"):
        _scan(part, source)
    _scan(part, "USB_SCANNER", result="INACTIVE_BARCODE")
    _scan(part, "MANUAL_ENTRY")
    _scan(None, "USB_SCANNER", result="UNKNOWN_BARCODE")                 # no part: store-wide only
    _scan(part, "MANUAL_ENTRY", at=utcnow().replace(tzinfo=None) - timedelta(days=40))

    stock = SpareStockService()
    stock.set_quantity(part.id, 20, txn_type="OPENING")
    for source in ("QR_SCAN", "kiosk_request", "ERP_SEARCH", None):
        stock.issue(part.id, 1, "Maintenance", user="tester", scan_source=source)
    _ledger(part, -1, "ISSUE", department="Maintenance", status="INSTALLED")         # no journal row
    _ledger(part, -1, "ISSUE", department="Maintenance", status="CANCELLED")         # never counted
    now = utcnow().replace(tzinfo=None)
    for gate_entry_no, age in (("GE-BL-1", 0), (None, 0), ("GE-BL-0", 40)):
        row = PutAwayLog(part_id=part.id, part_no=part.part_no, assigned_location="R1-S1-B1",
                         scanned_location="R1-S1-B1", gate_entry_no=gate_entry_no, section_id=sec.id, qty=3,
                         store_code=STORE, put_by="bl-sup", confirmed_at=now - timedelta(days=age))
        row.created_at = now - timedelta(days=age)
        db.session.add(row)
    db.session.commit()

    for section_id in (sec.id, None):
        scan = SpareManagementService().management(STORE, section_id=section_id)["scan"]
        s, iss, pa = scan["scans"], scan["issues"], scan["put_away"]
        assert _list("scans", "all", section_id)["count"] == s["total"]
        assert _list("scans", "scanned", section_id)["count"] == s["scanned"]
        assert _list("scans", "scanned_ok", section_id)["count"] == s["scanned_ok"]
        assert _list("scans", "typed_ok", section_id)["count"] == s["typed_ok"]
        assert _list("scans", "not_found", section_id)["count"] == s["not_found"]
        assert _list("issues", "all", section_id)["count"] == iss["total"]
        assert _list("issues", "scan", section_id)["count"] == iss["by_scan"]
        assert _list("issues", "search", section_id)["count"] == iss["by_search"]
        assert _list("issues", "unrecorded", section_id)["count"] == iss["unrecorded"]
        assert _list("put_away", "all", section_id)["count"] == pa["count"]
        assert _list("put_away", "lot_tag", section_id)["count"] == pa["with_lot_tag"]

    # This section's own figures, to be sure the rows are the seeded ones.
    rows = _list("scans", "all", sec.id)["rows"]
    # How the code got in, then whether it was found: the SCANNED rows are the
    # rate tile's "scanned", the NOT FOUND rows the not-found tile's.
    assert Counter(r["how"] for r in rows) == {"SCANNED": 3, "SCANNED · NOT FOUND": 1, "TYPED": 1}
    assert sum(r["how"].startswith("SCANNED") for r in rows) == 4
    assert all(r["part_id"] == part.id for r in rows)
    issues = _list("issues", "all", sec.id)["rows"]
    assert Counter(r["how"] for r in issues) == {"BY SCAN": 2, "BY SEARCH": 1, "NOT RECORDED": 2}
    put = _list("put_away", "all", sec.id)
    assert (put["count"], put["qty"]) == (2, 6.0)
    # A code that is no part has no section: only the store-wide list holds it.
    assert any(r["part_id"] is None for r in _list("scans", "not_found")["rows"])
