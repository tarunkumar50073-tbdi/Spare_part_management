"""Inventory Control (/api/v1/inventory-control): the Critical / Short /
Reorder / Excess lists and the excess aging read off the ledger.

One part per case in an isolated section, so every figure is known:

    Z  0,  min 2, max 10, rate 100 -> zero stock: critical, short 2, order 10 (1000)
    B  1,  min 5, max 20, rate 10  -> below min:  critical, short 4, order 19 (190)
    R  6,  min 2, reorder 6, max 12, rate 5 -> reorder only, order 6 (30)
    N  3,  min 5, no max, no rate  -> below min:  order 2 to min, unrated
    O  0,  nothing planned         -> zero stock: critical, reorder with no qty
    F  100 opening, 95 issued      -> 5 left, fast-moving: critical on low cover
    S  100 opening, 1 issued       -> 99 left, slow: nothing
    D  30, min 2, max 10, rate 50  -> excess 20 (200%), 1000
    E  12, min 2, max 10, no rate  -> excess 2, unrated
    H  5,  min 2, max 10           -> healthy: nothing
    U  never counted               -> nothing (not counted)
"""
from datetime import datetime, timedelta

import pytest

from app.extensions import db
from app.models.base import utcnow
from app.models.part import Part
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.models.store import Section, Store
from app.models.user import User, UserStoreAccess
from app.services.inventory_control_service import InventoryControlService
from app.services.spare_stock_service import SpareStockService

STORE = "MAINTENANCE"
_seq = {"n": 0}


def _section():
    _seq["n"] += 1
    store = Store.query.filter_by(code=STORE).first()
    s = Section(store_id=store.id, name=f"IC Section {_seq['n']}")
    db.session.add(s)
    db.session.commit()
    return s


def _part(sec, tag, qty, mn=0, mx=None, ro=None, rate=None):
    _seq["n"] += 1
    p = Part(part_no=f"IC-{_seq['n']}-{tag}", part_name=f"Inv control {tag}", uom="NO",
             part_type="OTHER", store_code=STORE, section_id=sec.id, location="R1-S1-B1",
             min_stock_level=mn, max_stock_level=mx, reorder_level=ro, unit_price=rate)
    db.session.add(p)
    db.session.commit()
    if qty is not None:
        db.session.add(SpareStock(part_id=p.id, qty_on_hand=qty))
        db.session.commit()
    return p


def _ledger(part, rows):
    """Back-dated ledger rows: [(balance_after, days_ago, txn_type), ...]."""
    prev = 0.0
    for bal, days_ago, txn in rows:
        db.session.add(SpareStockLedger(
            part_id=part.id, qty_delta=bal - prev, balance_after=bal, txn_type=txn,
            created_at=utcnow() - timedelta(days=days_ago)))
        prev = bal
    db.session.commit()


@pytest.fixture()
def seeded():
    svc = SpareStockService()
    sec = _section()
    p = {
        "Z": _part(sec, "Z", 0, mn=2, mx=10, rate=100),
        "B": _part(sec, "B", 1, mn=5, mx=20, rate=10),
        "R": _part(sec, "R", 6, mn=2, mx=12, ro=6, rate=5),
        "N": _part(sec, "N", 3, mn=5),
        "O": _part(sec, "O", 0),
        "F": _part(sec, "F", None, mn=2, mx=200),
        "S": _part(sec, "S", None, mn=2, mx=200),
        "D": _part(sec, "D", 30, mn=2, mx=10, rate=50),
        "E": _part(sec, "E", 12, mn=2, mx=10),
        "H": _part(sec, "H", 5, mn=2, mx=10),
        "U": _part(sec, "U", None, mn=2, mx=10),
    }
    for tag, issued in (("F", 95), ("S", 1)):
        svc.set_quantity(p[tag].id, 100, txn_type="OPENING")
        svc.issue(p[tag].id, issued, "Press Shop")
    return sec, p


def _ids(rows):
    return [r["part_id"] for r in rows]


def test_lists_membership_and_math(seeded):
    sec, p = seeded
    d = InventoryControlService().overview(STORE, section_id=sec.id)
    by = lambda rows: {r["part_id"]: r for r in rows}  # noqa: E731

    # Critical: empty shelves (dearest restock first), below min, then low cover.
    assert _ids(d["critical"]) == [p[t].id for t in ("Z", "O", "B", "N", "F")]
    crit = by(d["critical"])
    assert crit[p["Z"].id]["reasons"] == ["Zero stock"]
    assert crit[p["B"].id]["reason"] == "Below minimum"
    assert crit[p["F"].id]["reasons"] == ["Low cover (est.)"] and crit[p["F"].id]["low_cover"]
    w = d["cover"]["window_days"]
    assert 1 <= w <= 90 and d["cover"]["is_estimate"] is True
    assert crit[p["F"].id]["issued_90d"] == 95.0
    assert crit[p["F"].id]["days_cover"] == round(5 / (95 / w), 1)
    assert crit[p["F"].id]["last_issue_at"] is not None
    assert crit[p["O"].id]["short_qty"] is None                # no min planned
    assert p["S"].id not in crit                                # 99 left: weeks of cover

    # Short: below a planned minimum, with what to order.
    short = by(d["short"])
    assert set(short) == {p["Z"].id, p["B"].id, p["N"].id}
    assert short[p["B"].id]["short_qty"] == 4.0
    assert short[p["B"].id]["recommended_order_qty"] == 19.0
    assert short[p["B"].id]["recommended_action"] == "Order 19 to max"
    assert short[p["N"].id]["recommended_action"] == "Order 2 to min (no max set)"
    assert short[p["N"].id]["order_value"] is None

    # Reorder: status Reorder or worse; up to max, else up to min.
    ro = by(d["reorder"])
    assert set(ro) == {p[t].id for t in ("Z", "B", "R", "N", "O")}
    assert (ro[p["Z"].id]["recommended_order_qty"], ro[p["Z"].id]["order_value"]) == (10.0, 1000.0)
    assert (ro[p["R"].id]["recommended_order_qty"], ro[p["R"].id]["order_value"]) == (6.0, 30.0)
    assert ro[p["O"].id]["recommended_order_qty"] is None
    assert ro[p["O"].id]["order_basis"] == "no_levels"
    assert ro[p["O"].id]["recommended_action"].startswith("Set a min or max")
    assert "lead time and safety stock are not tracked" in d["rules"]["reorder"].lower()

    # Excess: over max, valued at the rate; the unrated one listed last.
    assert _ids(d["excess"]) == [p["D"].id, p["E"].id]
    ex = by(d["excess"])
    assert (ex[p["D"].id]["excess_qty"], ex[p["D"].id]["excess_pct"], ex[p["D"].id]["excess_value"]) == (20.0, 200.0, 1000.0)
    assert (ex[p["E"].id]["excess_qty"], ex[p["E"].id]["excess_pct"], ex[p["E"].id]["excess_value"]) == (2.0, 20.0, None)

    t = d["totals"]
    assert (t["parts"], t["counted"], t["not_counted"]) == (11, 10, 1)
    assert (t["critical"], t["critical_zero"], t["critical_below_min"], t["critical_low_cover"]) == (5, 2, 2, 1)
    assert (t["short"], t["reorder"], t["excess"]) == (3, 5, 2)
    assert t["restock_value"] == 1220.0 and t["restock_unrated"] == 1 and t["reorder_no_qty"] == 1
    assert (t["reorder_no_levels"], t["reorder_no_max"], t["reorder_at_max"]) == (1, 0, 0)
    assert t["excess_value"] == 1000.0 and t["excess_unrated"] == 1
    assert t["ledger_since"] == d["ledger_since"] is not None
    assert all(r["section"] == sec.name for r in d["critical"])


def test_no_order_qty_says_why_without_asking_for_levels_that_exist():
    svc = SpareStockService()
    sec = _section()
    a = _part(sec, "A", 4, mn=2, ro=6)               # Reorder, a min but no max
    k = _part(sec, "K", 10, mn=2, ro=12, mx=10)      # Reorder level above max: at max
    lc = _part(sec, "L", None, mx=5)                 # at max, but issued fast
    svc.set_quantity(lc.id, 100, txn_type="OPENING")
    svc.issue(lc.id, 95, "Press Shop")

    d = InventoryControlService().overview(STORE, section_id=sec.id)
    ro = {r["part_id"]: r for r in d["reorder"]}
    assert set(ro) == {a.id, k.id}
    assert (ro[a.id]["recommended_order_qty"], ro[a.id]["order_basis"]) == (None, "no_max")
    assert ro[a.id]["recommended_action"].startswith("No max set")
    assert (ro[k.id]["recommended_order_qty"], ro[k.id]["order_basis"]) == (None, "at_max")
    assert ro[k.id]["recommended_action"] == "At or above max: no order needed"
    assert not any("Set a min or max" in r["recommended_action"] for r in ro.values())

    crit = {r["part_id"]: r for r in d["critical"]}
    assert crit[lc.id]["reasons"] == ["Low cover (est.)"] and crit[lc.id]["order_basis"] == "at_max"
    assert crit[lc.id]["recommended_action"].startswith("At or above max")
    assert "estimate" in crit[lc.id]["recommended_action"]

    t = d["totals"]
    assert (t["reorder_no_qty"], t["reorder_no_levels"], t["reorder_no_max"], t["reorder_at_max"]) == (2, 0, 1, 1)
    # Nothing to order is a real zero, not an unknown.
    assert (t["restock_value"], t["restock_unrated"]) == (0.0, 0)


def test_all_unrated_money_is_null_not_zero():
    sec = _section()
    _part(sec, "X", 20, mn=1, mx=10)                 # excess, no rate
    _part(sec, "Y", 1, mn=5, mx=10)                  # to order 9, no rate
    d = InventoryControlService().overview(STORE, section_id=sec.id)
    t = d["totals"]
    assert (t["excess"], t["excess_value"], t["excess_unrated"]) == (1, None, 1)
    assert (t["reorder"], t["restock_value"], t["restock_unrated"]) == (1, None, 1)
    buckets = {b["key"]: b for b in d["aging"]["buckets"]}
    assert (buckets["no_ledger"]["count"], buckets["no_ledger"]["value"]) == (1, None)
    assert buckets["0-30"]["value"] == 0.0                   # empty bucket: a real zero

    empty = InventoryControlService().overview(STORE, section_id=_section().id)
    assert (empty["totals"]["excess_value"], empty["totals"]["restock_value"]) == (0.0, 0.0)


def test_excess_aging_from_the_ledger():
    sec = _section()
    x = _part(sec, "X", 25, mn=1, mx=10, rate=2)     # crossed 45 days ago
    y = _part(sec, "Y", 30, mn=1, mx=10, rate=1)     # already over at its first row
    w = _part(sec, "W", 15, mn=1, mx=10)             # no ledger row at all
    v = _part(sec, "V", 18, mn=1, mx=10, rate=10)    # over, back under, over again 10 days ago
    m = _part(sec, "M", 20, mn=1, mx=10, rate=1)     # ledger ends under max: unrecorded change
    p = _part(sec, "P", 40, mn=1, mx=10, rate=1)     # crossed 95 days ago
    _ledger(x, [(5, 100, "OPENING"), (25, 45, "RECEIPT")])
    _ledger(y, [(30, 20, "OPENING")])
    _ledger(v, [(20, 80, "OPENING"), (8, 50, "ADJUSTMENT"), (18, 10, "RECEIPT")])
    _ledger(m, [(5, 30, "OPENING")])
    _ledger(p, [(5, 120, "OPENING"), (40, 95, "RECEIPT")])

    d = InventoryControlService().overview(STORE, section_id=sec.id)
    ex = {r["part_id"]: r for r in d["excess"]}
    assert set(ex) == {x.id, y.id, w.id, v.id, m.id, p.id}

    assert (ex[x.id]["aging_bucket"], ex[x.id]["days_in_excess"], ex[x.id]["aging_basis"]) == ("31-60", 45, "crossing")
    assert ex[x.id]["excess_since"][:10] == (utcnow() - timedelta(days=45)).date().isoformat()
    assert (ex[v.id]["aging_bucket"], ex[v.id]["days_in_excess"]) == ("0-30", 10)
    assert (ex[p.id]["aging_bucket"], ex[p.id]["days_in_excess"]) == ("90+", 95)

    assert (ex[y.id]["aging_bucket"], ex[y.id]["aging_basis"]) == ("before_tracking", "above_at_first_row")
    assert ex[y.id]["days_in_excess"] is None
    assert ex[y.id]["excess_since_at_least"][:10] == (utcnow() - timedelta(days=20)).date().isoformat()
    # No ledger row: dated only by when the app recorded its quantity (here,
    # just now), never by the store's ledger start (P's row, 120 days back).
    assert (ex[w.id]["aging_bucket"], ex[w.id]["aging_basis"]) == ("no_ledger", "no_ledger")
    assert ex[w.id]["days_in_excess"] is None
    recorded = datetime.fromisoformat(ex[w.id]["excess_since_at_least"])
    assert abs(utcnow() - recorded) < timedelta(hours=1)
    assert ex[w.id]["excess_since_at_least"] != d["ledger_since"]
    assert (ex[m.id]["aging_bucket"], ex[m.id]["days_in_excess"]) == ("unknown", None)

    buckets = {b["key"]: b for b in d["aging"]["buckets"]}
    assert [b["key"] for b in d["aging"]["buckets"]] == [
        "0-30", "31-60", "61-90", "90+", "before_tracking", "no_ledger", "unknown"]
    assert (buckets["0-30"]["count"], buckets["0-30"]["value"]) == (1, 80.0)
    assert (buckets["31-60"]["count"], buckets["31-60"]["value"]) == (1, 30.0)
    assert buckets["61-90"]["count"] == 0
    assert (buckets["90+"]["count"], buckets["90+"]["value"]) == (1, 30.0)
    assert (buckets["before_tracking"]["count"], buckets["before_tracking"]["value"],
            buckets["before_tracking"]["unrated"]) == (1, 20.0, 0)
    assert buckets["before_tracking"]["since"] == d["ledger_since"]
    assert (buckets["no_ledger"]["count"], buckets["no_ledger"]["value"],
            buckets["no_ledger"]["unrated"]) == (1, None, 1)
    assert (buckets["unknown"]["count"], buckets["unknown"]["value"]) == (1, 10.0)
    assert any("not versioned" in n for n in d["aging"]["notes"])
    assert d["totals"]["excess_value"] == 30 + 20 + 80 + 10 + 30


# ---------------------------------------------------------------- endpoint

@pytest.fixture()
def client(app):
    return app.test_client()


def _login(client, perms=None, stores=(STORE,)):
    _seq["n"] += 1
    u = User(username=f"icuser{_seq['n']}", role="STORE_USER", is_active=True)
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
    return client


def test_endpoint_needs_inventory_control_right(client):
    c = _login(client)                                     # no inventory_control right
    assert c.get(f"/api/v1/inventory-control?store_code={STORE}").status_code == 403
    c = _login(client, perms={"store_stock": {"view": True}})   # Store Stock alone: it has its own right now
    assert c.get(f"/api/v1/inventory-control?store_code={STORE}").status_code == 403


def test_endpoint_refuses_a_foreign_store(client):
    c = _login(client, perms={"inventory_control": {"view": True}})
    assert c.get("/api/v1/inventory-control?store_code=CHILD_PART").status_code == 403


def test_endpoint_ok_and_needs_store(client, seeded):
    sec, p = seeded
    c = _login(client, perms={"inventory_control": {"view": True}})
    assert c.get("/api/v1/inventory-control").status_code == 400
    r = c.get(f"/api/v1/inventory-control?store_code={STORE}&section_id={sec.id}")
    assert r.status_code == 200
    body = r.get_json()["data"]
    assert {"critical", "short", "reorder", "excess", "totals", "aging", "rules", "cover",
            "ledger_since", "generated_at"} <= set(body)
    assert body["section_id"] == sec.id
    assert body["totals"]["excess"] == 2 and body["excess"][0]["part_id"] == p["D"].id
