"""Quarterly physical inventory (15 Nov 2026 spec): plan -> ERP snapshot ->
count -> reconcile -> approve + lock -> revision, three rights."""
import io
from datetime import datetime, timezone

import pytest
from openpyxl import Workbook

from app.extensions import db
from app.models.erp_stock import ERPStock
from app.models.inventory_count import InventoryResult, InventorySnapshotLine
from app.models.part import Part
from app.models.spare_stock import SpareStock
from app.models.store import Section, Store
from app.models.user import User, UserStoreAccess
from app.services.inventory_count_service import InventoryCountService, fiscal_year_of, quarter_of
from app.utils.exceptions import BadRequestError

STORE = "MAINTENANCE"
svc = InventoryCountService()
_seq = {"n": 0}
SYNC = datetime(2026, 11, 15, 4, 30, tzinfo=timezone.utc)


def _section():
    _seq["n"] += 1
    store = Store.query.filter_by(code=STORE).one()
    s = Section(store_id=store.id, name=f"Inv Section {_seq['n']}")
    db.session.add(s)
    db.session.commit()
    return s


def _part(section, erp=None, rate=10, cat="Bearing"):
    _seq["n"] += 1
    p = Part(part_no=f"INV-{_seq['n']}", part_name=f"PART {_seq['n']}", uom="NOS", part_type="OTHER",
             store_code=STORE, section_id=section.id, location=f"R1-S{_seq['n']}", unit_price=rate,
             sub_category=cat)
    db.session.add(p)
    db.session.flush()
    if erp is not None:
        db.session.add(ERPStock(part_id=p.id, qty_on_hand=erp, synced_at=SYNC))
    db.session.commit()
    return p


def _started(n_parts=(5, 3, 0)):
    sec = _section()
    parts = [_part(sec, e) for e in n_parts]
    s = svc.plan(STORE, "2026-27", "Q3", sec.id, "2026-11-15", "2026-11-20", "sup")
    s = svc.start(s["id"], STORE, "sup")
    return sec, parts, s


def test_period_helpers():
    from datetime import date
    assert fiscal_year_of(date(2026, 11, 15)) == "2026-27" and quarter_of(date(2026, 11, 15)) == "Q3"
    assert fiscal_year_of(date(2027, 3, 31)) == "2026-27" and quarter_of(date(2027, 3, 31)) == "Q4"
    assert quarter_of(date(2026, 4, 1)) == "Q1" and quarter_of(date(2026, 9, 30)) == "Q2"


def test_plan_refuses_a_second_session_without_a_reason():
    sec = _section()
    _part(sec, 1)
    svc.plan(STORE, "2026-27", "Q3", sec.id, "2026-11-15", "2026-11-20", "sup")
    with pytest.raises(BadRequestError, match="needs a reason"):
        svc.plan(STORE, "2026-27", "Q3", sec.id, "2026-11-15", "2026-11-20", "sup")
    second = svc.plan(STORE, "2026-27", "Q3", sec.id, "2026-11-15", "2026-11-20", "sup",
                      duplicate_reason="first count spoiled by flood")
    assert second["attempt"] == 2
    with pytest.raises(BadRequestError, match="2026-27"):
        svc.plan(STORE, "2026", "Q3", sec.id, "2026-11-15", "2026-11-20", "sup")
    with pytest.raises(BadRequestError, match="before the start"):
        svc.plan(STORE, "2026-27", "Q4", sec.id, "2026-11-20", "2026-11-15", "sup")


def test_snapshot_is_erp_and_counting_never_copies_it():
    sec, (a, b, c), s = _started()
    lines = {l.part_id: l for l in InventorySnapshotLine.query.filter_by(session_id=s["id"]).all()}
    assert float(lines[a.id].erp_qty) == 5 and float(lines[b.id].erp_qty) == 3 and float(lines[c.id].erp_qty) == 0
    assert s["status"] == "IN_PROGRESS" and s["snapshot_source"] == "ERP_DB"
    line = svc.line(s["id"], STORE, code=a.part_no)
    assert line["erp_qty"] == 5 and line["count"] is None and line["can_count"]
    # ERP changes later: the snapshot does not
    ERPStock.query.filter_by(part_id=a.id).one().qty_on_hand = 50
    db.session.commit()
    assert float(InventorySnapshotLine.query.filter_by(session_id=s["id"], part_id=a.id).one().erp_qty) == 5
    # App stock untouched by counting
    svc.count(s["id"], STORE, a.id, 4, "ravi")
    assert SpareStock.query.filter_by(part_id=a.id).first() is None


def test_duplicate_count_needs_a_recount_and_the_counter_fixes_own_slip():
    sec, (a, b, c), s = _started()
    first = svc.count(s["id"], STORE, a.id, 4, "ravi", source="SCAN")
    with pytest.raises(BadRequestError, match="already counted"):
        svc.count(s["id"], STORE, a.id, 5, "amit")
    with pytest.raises(BadRequestError, match="Only ravi"):
        svc.edit_count(first["id"], STORE, 5, "amit", "typo")
    with pytest.raises(BadRequestError, match="reason"):
        svc.edit_count(first["id"], STORE, 5, "ravi", "")
    assert svc.edit_count(first["id"], STORE, 6, "ravi", "typed 4, shelf has 6")["counted_qty"] == 6
    svc.allow_recount(s["id"], STORE, a.id, "sup", "difference with ERP")
    again = svc.count(s["id"], STORE, a.id, 5, "amit")
    assert again["seq"] == 2 and again["kind"] == "RECOUNT"
    audit = svc.audit(s["id"])
    assert {"COUNT", "EDIT", "RECOUNT", "RECOUNT_OK", "START"} <= {r["action"] for r in audit}


def test_reconcile_summary_accuracy_and_variance_kept_apart():
    sec, (a, b, c, _d), s = _started((5, 3, 0, 2))
    d = svc.detail(s["id"], STORE)
    assert d["summary"]["completion_pct"] == 0 and d["summary"]["accuracy_pct"] is None
    svc.count(s["id"], STORE, a.id, 5, "ravi")        # match
    svc.count(s["id"], STORE, b.id, 1, "ravi")        # short 2
    svc.count(s["id"], STORE, c.id, 4, "ravi")        # excess 4
    sm = svc.detail(s["id"], STORE)["summary"]
    assert (sm["matched_parts"], sm["shortage_parts"], sm["excess_parts"], sm["not_counted_parts"]) == (1, 1, 1, 1)
    assert sm["accuracy_pct"] == round(1 / 3 * 100, 1) and sm["completion_pct"] == 75.0
    assert (sm["shortage_qty"], sm["excess_qty"], sm["net_difference_qty"]) == (2, 4, 2)
    assert sm["erp_qty"] == 10 and sm["physical_qty"] == 10 and sm["shortage_value"] == 20.0
    unc = svc.detail(s["id"], STORE, view="uncounted")["rows"]
    assert [r["status"] for r in unc] == ["NOT_COUNTED"]
    cat = svc.detail(s["id"], STORE, view="category")["rows"]
    assert cat[0]["name"] == "Bearing" and cat[0]["total_parts"] == 4


def test_a_part_of_another_section_found_on_the_shelf_counts_as_excess():
    sec, (a, b, c), s = _started()
    stray = _part(_section(), 0)
    line = svc.line(s["id"], STORE, part_id=stray.id)
    assert line["in_snapshot"] is False and line["other_section"] is True
    svc.count(s["id"], STORE, stray.id, 2, "ravi")
    rows = {r["part_no"]: r for r in svc.detail(s["id"], STORE)["rows"]}
    assert rows[stray.part_no]["status"] == "EXCESS" and rows[stray.part_no]["erp_qty"] is None


def test_approve_locks_and_a_revision_keeps_the_original():
    sec, (a, b, c), s = _started()
    with pytest.raises(BadRequestError, match="Nothing is counted"):
        svc.submit(s["id"], STORE, "sup")
    svc.count(s["id"], STORE, a.id, 5, "ravi")
    svc.count(s["id"], STORE, b.id, 2, "ravi")
    svc.submit(s["id"], STORE, "sup")
    with pytest.raises(BadRequestError, match="closed"):
        svc.count(s["id"], STORE, c.id, 1, "ravi")
    svc.reject(s["id"], STORE, "mgr", "count C as well")
    svc.count(s["id"], STORE, c.id, 0, "ravi")
    svc.submit(s["id"], STORE, "sup")
    done = svc.approve(s["id"], STORE, "mgr")
    assert done["status"] == "COMPLETED" and done["locked"] and done["summary"]["accuracy_pct"] == round(2 / 3 * 100, 1)
    with pytest.raises(BadRequestError):
        svc.allow_recount(s["id"], STORE, b.id, "sup", "x")
    rev = svc.revise(s["id"], STORE, b.id, 3, "mgr", "box found behind the rack")
    assert rev["revision"] == 1 and rev["summary"]["accuracy_pct"] == 100.0
    original = {r.part_id: r for r in InventoryResult.query.filter_by(session_id=s["id"], revision=0).all()}
    assert float(original[b.id].physical_qty) == 2 and original[b.id].status == "SHORT"


def test_start_from_erp_excel_and_count_sheet():
    sec = _section()
    a, b = _part(sec), _part(sec)
    s = svc.plan(STORE, "2026-27", "Q2", sec.id, "2026-09-20", "2026-09-25", "sup")
    wb = Workbook()
    ws = wb.active
    ws.append(["Stock Summary as on 25.09.2026"])
    ws.append(["Item Cd", "Description", "Closing Stock"])
    ws.append([a.part_no, "x", 7])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    s = svc.start_from_excel(s["id"], STORE, buf, "erp.xlsx", "sup")
    assert s["snapshot_source"] == "EXCEL"
    lines = {l.part_id: l for l in InventorySnapshotLine.query.filter_by(session_id=s["id"]).all()}
    assert float(lines[a.id].erp_qty) == 7 and lines[b.id].erp_qty is None
    wb = Workbook()
    ws = wb.active
    ws.append(["Part No", "Physical Qty", "Remarks"])
    ws.append([a.part_no, 7, "ok"])
    ws.append([a.part_no, 9, "again"])
    ws.append(["NOPE", 1, None])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    out = svc.import_counts(s["id"], STORE, buf, "ravi")
    assert out["counted"] == 1 and len(out["skipped"]) == 1 and len(out["errors"]) == 1


def test_quarter_history_and_board_show_only_approved_figures():
    sec, (a, b, c), s = _started()
    svc.count(s["id"], STORE, a.id, 5, "ravi")
    card = svc.board_card(STORE)
    assert card["has_data"] and card["status"] == "In Progress"
    mine = next(x for x in card["by_section"] if x["session_id"] == s["id"])
    assert mine["counted_parts"] == 0                   # not verified yet
    svc.submit(s["id"], STORE, "sup")
    svc.approve(s["id"], STORE, "mgr")
    q = svc.quarter(STORE, "2026-27", "Q3", verified_only=True)
    mine = next(x for x in q["by_section"] if x["session_id"] == s["id"])
    assert mine["counted_parts"] == 1 and mine["accuracy_pct"] == 100.0


def _user(perms):
    _seq["n"] += 1
    u = User(username=f"invuser{_seq['n']}", role="STORE_USER", is_active=True)
    u.set_password("pw-inventory-1")
    u.set_permissions(perms)
    db.session.add(u)
    db.session.flush()
    db.session.add(UserStoreAccess(user_id=u.id, store_code=STORE))
    db.session.commit()
    return u


def _client(app, perms):
    c = app.test_client()
    with c.session_transaction() as s:
        s["user_id"] = _user(perms).id
    return c


def test_api_three_rights(app):
    sec = _section()
    p = _part(sec, 2)
    counter = _client(app, {"inventory_count": {"view": True, "create": True, "update": True}})
    sup = _client(app, {"inventory_review": {"view": True, "create": True, "update": True, "delete": True}})
    mgr = _client(app, {"inventory_approve": {"view": True, "update": True}})
    body = {"store_code": STORE, "fiscal_year": "2026-27", "quarter": "Q3", "section_id": sec.id,
            "start_date": "2026-11-15", "close_date": "2026-11-20"}
    assert counter.post("/api/v1/inventory/sessions", json=body).status_code == 403
    r = sup.post("/api/v1/inventory/sessions", json=body)
    assert r.status_code == 201
    sid = r.get_json()["data"]["id"]
    assert sup.post(f"/api/v1/inventory/sessions/{sid}/start", json={"store_code": STORE}).status_code == 200
    assert sup.post(f"/api/v1/inventory/sessions/{sid}/counts",
                    json={"store_code": STORE, "part_id": p.id, "qty": 2}).status_code == 403
    assert counter.post(f"/api/v1/inventory/sessions/{sid}/counts",
                        json={"store_code": STORE, "part_id": p.id, "qty": 2}).status_code == 201
    assert counter.post(f"/api/v1/inventory/sessions/{sid}/submit", json={"store_code": STORE}).status_code == 403
    assert sup.post(f"/api/v1/inventory/sessions/{sid}/submit", json={"store_code": STORE}).status_code == 200
    assert sup.post(f"/api/v1/inventory/sessions/{sid}/approve", json={"store_code": STORE}).status_code == 403
    assert mgr.post(f"/api/v1/inventory/sessions/{sid}/approve", json={"store_code": STORE}).status_code == 200
    d = mgr.get(f"/api/v1/inventory/sessions/{sid}", query_string={"store_code": STORE}).get_json()["data"]
    assert d["session"]["locked"] and d["summary"]["accuracy_pct"] == 100.0
    x = mgr.get(f"/api/v1/inventory/sessions/{sid}/export/excel", query_string={"store_code": STORE})
    assert x.status_code == 200
    pdf = mgr.get(f"/api/v1/inventory/sessions/{sid}/export/pdf", query_string={"store_code": STORE, "view": "audit"})
    assert pdf.status_code == 200 and pdf.data.startswith(b"%PDF")
    assert mgr.get("/api/v1/inventory/board", query_string={"store_code": STORE}).get_json()["data"]["has_data"]
    assert mgr.get("/api/v1/inventory/history", query_string={"store_code": STORE}).status_code == 200
