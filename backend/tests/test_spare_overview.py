"""The one-call dashboard overview (/api/v1/dashboard/spare/overview).

One part per stock status in an isolated section, so every figure is known:

    A  0 on hand, min 2, max 10, rate 100   -> Out of Stock   (restock 10 x 100)
    B  1,          min 5, max 20, rate 10   -> Below Minimum  (restock 19 x 10)
    C  6, min 2, reorder 6, max 12, rate 5  -> Reorder        (restock 6 x 5)
    D  30,         min 2, max 10, rate 50   -> Above Maximum  (excess 20 x 50)
    E  5,          min 2, max 10, no rate   -> Healthy
    F  never counted, nothing planned, no location -> Not Counted
"""
import pytest

from app.extensions import db
from app.models.part import Part
from app.models.spare_stock import SpareStock
from app.models.store import Section, Store
from app.models.user import User, UserStoreAccess
from app.services.spare_dashboard_service import SpareDashboardService

STORE = "MAINTENANCE"
_seq = {"n": 0}


def _section(name):
    store = Store.query.filter_by(code=STORE).first()
    s = Section(store_id=store.id, name=name)
    db.session.add(s)
    db.session.commit()
    return s


def _part(sec, tag, qty, mn=0, mx=None, ro=None, rate=None, loc="R1-S1-B1"):
    _seq["n"] += 1
    p = Part(part_no=f"OV-{_seq['n']}-{tag}", part_name=f"Overview {tag}", uom="NO",
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
    sec = _section(f"OV Section {_seq['n']}")
    parts = {
        "A": _part(sec, "A", 0, mn=2, mx=10, rate=100),
        "B": _part(sec, "B", 1, mn=5, mx=20, rate=10),
        "C": _part(sec, "C", 6, mn=2, mx=12, ro=6, rate=5),
        "D": _part(sec, "D", 30, mn=2, mx=10, rate=50),
        "E": _part(sec, "E", 5, mn=2, mx=10),
        "F": _part(sec, "F", None, loc=""),
    }
    return sec, parts


def test_overview_figures_for_a_section(seeded):
    sec, p = seeded
    ov = SpareDashboardService().overview(STORE, section_id=sec.id)

    k = ov["kpis"]
    assert (k["total_parts"], k["counted_parts"], k["uncounted_parts"]) == (6, 5, 1)
    assert k["stock_value"] == 0 + 10 + 30 + 1500      # E has no rate, F no count
    assert k["valued_parts"] == 4

    health = {h["status"]: h for h in ov["health"]}
    assert [h["status"] for h in ov["health"]][:2] == ["Out of Stock", "Below Minimum"]
    # One part in each status — none marked Discontinued (22 Oct 2026) here.
    assert all(health[s]["count"] == (0 if s == "Discontinued" else 1) for s in health)
    assert health["Above Maximum"]["value"] == 1500.0

    att = {a["key"]: a for a in ov["attention"]}
    assert att["zero_stock"]["severity"] == "critical" and att["zero_stock"]["count"] == 1
    assert att["zero_stock"]["value"] == 1000 + 190 + 30          # restock to max
    assert att["zero_stock"]["sections"] == [{"section_id": sec.id, "name": sec.name, "count": 1}]
    assert att["zero_stock"]["action"] == {"label": "Open list", "to": "/store-stock-spare", "status": "Out of Stock"}
    assert att["below_min"]["severity"] == "critical"
    assert att["reorder"]["severity"] == "warning"
    assert att["excess"]["value"] == 1000.0                       # 20 over max x 50
    assert "confirm_pending" not in att                           # Confirm Installation taken out
    # Store-level only: a section screen never quotes the store's SRVs / ERP queue.
    assert "srv_pending" not in att and "erp_pending" not in att

    assert ov["value"]["to_restock"] == 1220.0
    assert ov["value"]["excess"] == 1000.0
    assert ov["value"]["by_section"][0]["section_id"] == sec.id
    # No sub_category on the seeded parts -> one "Uncategorised" group holding it all.
    assert ov["value"]["by_type"] == [{"name": "Uncategorised", "value": 1540.0, "parts": 6}]
    assert {"by_department", "by_machine", "by_type", "comparison"} <= set(ov["consumption"])

    assert [c["part_id"] for c in ov["critical_parts"]] == [p["A"].id, p["B"].id]
    assert ov["excess_parts"][0]["part_id"] == p["D"].id
    assert ov["excess_parts"][0]["excess_qty"] == 20.0

    dq = ov["data_quality"]
    assert dq["missing_max"] == 1 and dq["missing_min"] == 1       # F
    assert dq["missing_reorder"] == 5                              # all but C
    assert dq["missing_rate"] == 2 and dq["missing_location"] == 1  # E, F / F
    assert dq["never_counted"] == 1
    assert dq["completeness_pct"] == round(20 / 30 * 100, 1)

    assert ov["erp"]["stock_snapshot"]["state"] in ("NONE", "STALE", "SYNCED")
    assert "reason" in ov["erp"]["write"]


def test_store_level_overview_adds_srv_and_erp_lines():
    ov = SpareDashboardService().overview(STORE)
    att = {a["key"]: a for a in ov["attention"]}
    assert "srv_pending" in att and "erp_pending" in att
    # Spec 1: the spare store's "SRV pending" line now carries the ERP GRN
    # lines waiting for quality in ERP (key kept for the screens that read it).
    srv = att["srv_pending"]
    assert srv["label"] == "GRN / Quality pending"
    assert srv["count"] == ov["receiving_pending"]["total"]
    assert srv["action"] == {"label": "Open Receiving & GRN", "to": "/receiving"}
    assert "ERP GRN data" in srv["hint"]                      # with the mirror's freshness


def test_document_blocks_for_a_section(seeded):
    """ERP GRN lines / returns / RGPs of the section's parts, counted per line /
    document."""
    from datetime import date, timedelta

    from app.models.receiving_register import ReceivingRegister
    from app.models.spare_flow import SpareReceipt, SpareReturn, SpareRgp
    from app.models.spare_stock import SpareStockLedger

    sec, p = seeded
    empty = SpareDashboardService().overview(STORE, section_id=sec.id)
    rp = empty["receiving_pending"]
    assert {k: rp[k] for k in rp if k != "erp"} == {
        "quality_pending": 0, "check": 0, "to_add": 0, "total": 0, "awaiting_grn": None,
        "qty": {"quality_pending": 0.0, "to_add": 0.0, "total": 0.0},
        "oldest_grn_date": None, "oldest_check_grn_date": None}
    assert set(rp["erp"]) == {"synced_at", "newest_grn_date"}
    assert (empty["returns_pending"]["inspection"], empty["rgp"]["with_supplier"]) == (0, 0)

    part = p["E"]
    n = _seq["n"]

    def doc(prefix, i):
        return f"{prefix}-OV-{n}-{i}"

    # Receiving is read from ERP: two GRN lines quality has not accepted in ERP,
    # one it rejected. In-app receipts from before the change count nowhere.
    today = date.today()
    for i, (receipt, reject) in enumerate(((2, None), (1, None), (9, 9))):
        db.session.add(ReceivingRegister(store_code="CHILD_PART", grn_no=doc("GRN", i), item_cd=part.part_no,
                                         grn_date=today - timedelta(days=3 + i), ven_cd="V-OV",
                                         receipt_qty=receipt, reject_qty=reject))
    for i, status in enumerate(("RECEIVED", "QUALITY_PENDING")):
        db.session.add(SpareReceipt(receipt_no=doc("RCV", i), part_id=part.id, store_code=STORE,
                                    status=status, qty_received=4))
    issue = SpareStockLedger(part_id=part.id, qty_delta=-5, balance_after=0, txn_type="ISSUE",
                             department="Maintenance", status="RETURNED")
    db.session.add(issue)
    db.session.flush()
    both = SpareReturn(return_no=doc("RET", 1), part_id=part.id, store_code=STORE, issue_id=issue.id,
                       status="INSPECTION_PENDING", qty=3, qty_pending=1, qty_hold=2)
    dmg = SpareReturn(return_no=doc("RET", 2), part_id=part.id, store_code=STORE, issue_id=issue.id,
                      status="DAMAGED", qty=1, qty_damaged=1)
    db.session.add_all([both, dmg])
    db.session.flush()
    for i, (out, back, grn, status, due) in enumerate((
            (2, 0, 0, "WITH_SUPPLIER", today - timedelta(days=4)),
            (3, 2, 0, "RGP_GRN_PENDING", today + timedelta(days=4)),
            (1, 0, 0, "CANCELLED", today - timedelta(days=9)))):
        db.session.add(SpareRgp(rgp_no=doc("RGP", i), part_id=part.id, store_code=STORE,
                                source_return_id=dmg.id, status=status, ven_name="ABC Engineering",
                                qty_out=out, qty_returned=back, qty_grn=grn, rework_reason="Rework",
                                rgp_date=today - timedelta(days=10), expected_return_date=due))
    db.session.commit()

    ov = SpareDashboardService().overview(STORE, section_id=sec.id)
    rp = ov["receiving_pending"]
    assert (rp["awaiting_grn"], rp["quality_pending"], rp["check"], rp["total"]) == (None, 2, 0, 2)
    assert rp["qty"] == {"quality_pending": 3.0, "to_add": 0.0, "total": 3.0}
    assert rp["oldest_grn_date"] == (today - timedelta(days=4)).isoformat()
    assert ov["returns_pending"]["inspection"] == 1 and ov["returns_pending"]["hold"] == 1
    assert ov["returns_pending"]["damaged"] == 1
    assert ov["returns_pending"]["qty"] == {"inspection": 1.0, "hold": 2.0, "damaged": 1.0}
    g = ov["rgp"]
    # One partly back (1 still out, 2 waiting for the GRN); the cancelled one counts nowhere.
    assert (g["with_supplier"], g["grn_pending"], g["overdue"]) == (2, 1, 1)
    assert g["qty"] == {"with_supplier": 3.0, "grn_pending": 2.0}
    assert g["oldest_overdue_date"] == (today - timedelta(days=4)).isoformat()
    # Documents never touch the stock figures.
    assert ov["kpis"]["total_qty"] == empty["kpis"]["total_qty"]
    # Another section sees none of them.
    other = _section(f"OV Other {n}")
    assert SpareDashboardService().overview(STORE, section_id=other.id)["receiving_pending"]["total"] == 0


@pytest.fixture()
def client(app):
    return app.test_client()


def _login(client, role="STORE_USER", perms=None):
    _seq["n"] += 1
    u = User(username=f"ovuser{_seq['n']}", role=role, is_active=True)
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


def test_overview_endpoint_permissions(client):
    c = _login(client)                                    # no spare_store right
    assert c.get(f"/api/v1/dashboard/spare/overview?store_code={STORE}").status_code == 403


def test_overview_is_open_to_the_wallboard_right_alone(client):
    c = _login(client, perms={"live_dashboard": {"view": True}})
    assert c.get(f"/api/v1/dashboard/spare/overview?store_code={STORE}").status_code == 200


def test_overview_endpoint_ok_and_needs_store(client):
    c = _login(client, perms={"spare_store": {"view": True}})
    assert c.get("/api/v1/dashboard/spare/overview").status_code == 400
    r = c.get(f"/api/v1/dashboard/spare/overview?store_code={STORE}")
    assert r.status_code == 200
    body = r.get_json()["data"]
    assert {"kpis", "health", "attention", "value", "critical_parts", "excess_parts",
            "consumption", "recent_activity", "erp", "data_quality", "generated_at",
            "receiving_pending", "returns_pending", "rgp"} <= set(body)
