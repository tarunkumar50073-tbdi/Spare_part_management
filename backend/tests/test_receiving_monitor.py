"""The Receiving & GRN monitor (/api/v1/receiving-monitor).

Every part lives in its own section / RCV-<n> prefix: the session DB is shared,
so assertions read only this file's rows out of the store-wide lists.
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.extensions import db
from app.models.gate_entry import GateEntry
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.srv import SRV, STATUSES
from app.models.store import Section, Store
from app.models.supplier import Supplier
from app.models.user import User, UserStoreAccess
from app.services.receiving_monitor_service import (
    PIPELINE_STATUSES, SRV_PASS_THROUGH, SRV_STATUS_MAP, ReceivingMonitorService, _aging,
)
from app.services.spare_stock_service import SpareStockService
from app.services.srv_service import SRVService
from app.utils.exceptions import BadRequestError

STORE = "MAINTENANCE"
_seq = {"n": 0}


def _next():
    _seq["n"] += 1
    return _seq["n"]


def _today():
    return datetime.now().date()


def _section():
    store = Store.query.filter_by(code=STORE).first()
    s = Section(store_id=store.id, name=f"RCV Section {_next()}")
    db.session.add(s)
    db.session.commit()
    return s


def _part(tag, store=STORE, section=None):
    p = Part(part_no=f"RCV-{_next()}-{tag}", part_name=f"Receiving {tag}", uom="NO",
             part_type="OTHER", store_code=store, section_id=section.id if section else None)
    db.session.add(p)
    db.session.commit()
    return p


def _grn(item_cd, days_ago, grn_no=None, reject=None):
    r = ReceivingRegister(store_code="CHILD_PART", grn_no=grn_no or f"GRN-{_next()}",
                          grn_date=_today() - timedelta(days=days_ago), item_cd=item_cd,
                          item_desc="ERP text", ven_cd="V001", ven_name="Acme Traders",
                          challan_no="INV-9", receipt_qty=4, accept_qty=3, reject_qty=reject)
    db.session.add(r)
    db.session.commit()
    return r


def _gate(item_code, days_ago):
    g = GateEntry(store_code="CHILD_PART", gate_entry_no=f"GE-{_next()}",
                  gate_entry_dt=_today() - timedelta(days=days_ago), gate_entry_time="10:15",
                  item_code=item_code, item_desc="Gate text", qty=4,
                  ven_cd="V001", ven_name="Acme Traders", po_no="PO-1")
    db.session.add(g)
    db.session.commit()
    return g


def _mine(rows, *parts):
    ids = {p.id for p in parts}
    return [r for r in rows if r["part_id"] in ids]


def test_grn_match_is_case_insensitive_and_store_scoped():
    sec = _section()
    spare = _part("A", section=sec)
    child = _part("C", store="CHILD_PART")
    _grn(f"  {spare.part_no.lower()} ", 2, grn_no="GRN-CASE")   # lower-case, padded
    _grn(child.part_no, 2)                                       # a Child Parts item
    _grn(spare.part_no, 100, grn_no="GRN-OLD")                   # outside a 90-day window
    _grn("NOT-A-PART-XYZ", 1)

    out = ReceivingMonitorService().monitor(STORE, days=90)
    rows = _mine(out["grn"], spare, child)
    assert [r["grn_no"] for r in rows] == ["GRN-CASE"]
    r = rows[0]
    assert (r["part_id"], r["part_no"], r["source"]) == (spare.id, spare.part_no, "ERP GRN")
    assert r["section"] == sec.name and r["age_days"] == 2
    assert r["qty"] == 3.0 and r["receipt_qty"] == 4.0 and r["supplier"] == "Acme Traders"
    assert r["description"] == "ERP text"
    assert all(g["part_no"] != "NOT-A-PART-XYZ" for g in out["grn"])

    wide = ReceivingMonitorService().monitor(STORE, days=180)
    assert {r["grn_no"] for r in _mine(wide["grn"], spare)} == {"GRN-CASE", "GRN-OLD"}
    # The Child Parts line never appears on a spare screen, nor spare lines on its.
    child_view = ReceivingMonitorService().monitor("CHILD_PART", days=90)
    assert [r["part_id"] for r in _mine(child_view["grn"], spare, child)] == [child.id]


def test_gate_arrival_then_grn_is_excluded_arrival_only_is_included():
    covered = _part("X")        # arrival, then a GRN two days later
    pending = _part("Y")        # arrival only
    received = _part("Z")       # arrival, then booked in the store today
    before = _part("W")         # a GRN BEFORE the arrival does not cover it
    child = _part("K", store="CHILD_PART")

    _gate(covered.part_no, 10)
    _grn(covered.part_no, 8)
    _gate(pending.part_no.lower(), 10)
    _gate(received.part_no, 5)
    SpareStockService().receive(received.id, 2, reference="GE-in", user="tester")
    _grn(before.part_no, 12, grn_no="GRN-EARLIER")
    _gate(before.part_no, 6)
    _gate(child.part_no, 3)

    out = ReceivingMonitorService().monitor(STORE, days=90)
    rows = {r["part_id"]: r for r in _mine(out["gate_not_received"], covered, pending, received, before, child)}
    assert set(rows) == {pending.id, before.id}

    y = rows[pending.id]
    assert y["age_days"] == 10 and y["source"] == "ERP gate entry"
    assert y["note"] == "Arrived at gate, no receipt recorded yet"
    assert y["last_grn_date"] is None and y["last_receipt_day"] is None
    # The mirror holds GRNs dated after this arrival, so it is not "beyond" it.
    assert y["beyond_grn_data"] is False

    w = rows[before.id]
    assert w["age_days"] == 6
    assert w["last_grn_date"] == (_today() - timedelta(days=12)).isoformat()

    assert out["summary"]["gate_not_received"]["gate_lines_in_window"] >= 4
    assert out["summary"]["gate_not_received"]["lines"] >= 2


def test_store_receipts_carry_check_invoice_and_who():
    p = _part("R")
    SpareStockService().receive(p.id, 5, reference="GE-77", user="storeman",
                                invoice_no="INV-55", check_result="short")
    out = ReceivingMonitorService().monitor(STORE, days=30)
    rows = _mine(out["store_receipts"], p)
    assert len(rows) == 1
    r = rows[0]
    assert (r["qty"], r["invoice_no"], r["check_result"]) == (5.0, "INV-55", "SHORT")
    assert r["status"] == "PHYSICALLY_RECEIVED" and r["status_label"] == "Physically received"
    assert r["received_by"] == "storeman" and r["erp_pushed_at"] is None
    assert r["age_days"] == 0 and r["received_at"].endswith("+00:00")
    assert out["summary"]["store_receipts"]["check_issues"] >= 1
    # The ledger's make-up is counted, not assumed.
    ledger = out["sources"]["store_ledger"]
    assert ledger["receipts_ever"] == ledger["txn_counts"]["RECEIPT"] >= 1


def test_every_srv_status_is_mapped_or_documented():
    assert set(SRV_STATUS_MAP) == set(STATUSES)
    assert set(SRV_PASS_THROUGH) <= set(STATUSES)
    targets = {m for m, _ in SRV_STATUS_MAP.values() if m}
    assert targets <= set(PIPELINE_STATUSES)
    # No SRV field records an ERP stock posting, so nothing may claim it.
    assert "ERP Updated" not in targets
    assert all(note for _, note in SRV_STATUS_MAP.values())


def _run_srv(part, vendor, qc, result=None):
    """Drive one SRV line through the real SRVService flow, as ERP's calls would."""
    svc = SRVService()
    srv = svc.ingest_gate_entry({
        "vendor_code": vendor, "invoice_no": f"INV-{_next()}",
        "gate_entry_time": datetime.now(timezone.utc),
        "lines": [{"part_no": part.part_no, "qty_invoiced": 2, "qc_required": qc}],
    })[0]
    svc.unload(srv.id)
    svc.verify(srv.id, 2)
    srv = svc.create_srv(srv.id, f"SRV-RCV-{_next()}")
    if result:
        svc.inspect(srv.id, result)


def test_real_srv_flow_lands_on_countable_monitor_statuses():
    vendor = f"RCVV{_next()}"
    db.session.add(Supplier(vendor_code=vendor, supplier_name="Receiving Test Supplier", status="Active"))
    db.session.commit()
    direct, waiting, approved, rejected = _part("SD"), _part("SW"), _part("SA"), _part("SR")
    _run_srv(direct, vendor, qc=False)
    _run_srv(waiting, vendor, qc=True)
    _run_srv(approved, vendor, qc=True, result="Approved")
    _run_srv(rejected, vendor, qc=True, result="Rejected")

    out = ReceivingMonitorService().monitor(STORE, days=30)
    rows = {r["part_id"]: r for r in _mine(out["srv_pipeline"], direct, waiting, approved, rejected)}
    assert {pid: (r["status"], r["pipeline_status"]) for pid, r in rows.items()} == {
        direct.id: ("TRANSFERRED", "Approved"),
        waiting.id: ("INSPECTION_PENDING", "Verification Pending"),
        approved.id: ("TRANSFERRED", "Approved"),
        rejected.id: ("RETURNED_TO_SUPPLIER", "Rejected"),
    }
    assert rows[waiting.id]["open"] and not rows[direct.id]["open"]
    # The flow never leaves a line in a pass-through status, so the monitor
    # statuses fed only by those are reported as not countable, not as zero.
    assert not {r["status"] for r in rows.values()} & set(SRV_PASS_THROUGH)
    assert set(out["pipeline_not_countable"]) == {"Created", "Engineer Pending", "ERP Updated"}
    rests = {m["status"]: m["rests"] for m in out["srv_status_map"]}
    assert rests["TRANSFERRED"] and not rests["SRV_CREATED"] and not rests["STORED"]


def test_steps_mark_unwritten_steps_not_tracked():
    steps = {s["key"]: s for s in ReceivingMonitorService._steps([], [], [], 0)}
    for key in ("engineer_verification", "rack_placement"):
        assert (steps[key]["state"], steps[key]["count"]) == ("not_tracked", None)
    erp_on = SpareStockService.erp_write_status()["active"]
    assert steps["erp_update"]["state"] == ("partial" if erp_on else "not_tracked")
    assert steps["gate_entry"]["state"] == "tracked"
    # Rows that really are there still show, whatever the flow normally does.
    with_eng = ReceivingMonitorService._steps([], [], [{"pipeline_status": "Engineer Pending"}], 0)
    eng = next(s for s in with_eng if s["key"] == "engineer_verification")
    assert (eng["state"], eng["count"]) == ("partial", 1)


def _srv(part, status, created_at=None):
    s = SRV(vendor_code="V001", supplier_name="Acme Traders", part_id=part.id,
            part_no=part.part_no, part_name=part.part_name, qty_invoiced=3, status=status)
    if created_at:
        s.created_at = created_at
    db.session.add(s)
    db.session.commit()
    return s


def test_srv_pipeline_maps_statuses_and_keeps_old_open_lines():
    eng, ver, old_open, old_done = _part("E"), _part("V"), _part("O"), _part("D")
    child = _part("S", store="CHILD_PART")
    long_ago = datetime.now(timezone.utc) - timedelta(days=200)
    _srv(eng, "FORWARDED_TOOL_ROOM")
    _srv(ver, "VERIFIED")
    _srv(old_open, "SRV_CREATED", created_at=long_ago)
    _srv(old_done, "STORED", created_at=long_ago)
    _srv(child, "FORWARDED_TOOL_ROOM")

    out = ReceivingMonitorService().monitor(STORE, days=30)
    rows = {r["part_id"]: r for r in _mine(out["srv_pipeline"], eng, ver, old_open, old_done, child)}
    assert set(rows) == {eng.id, ver.id, old_open.id}
    assert rows[eng.id]["pipeline_status"] == "Engineer Pending" and rows[eng.id]["open"]
    assert rows[ver.id]["pipeline_status"] is None and rows[ver.id]["mapped"] is False
    assert rows[old_open.id]["pipeline_status"] == "Created" and rows[old_open.id]["age_days"] >= 199
    assert out["summary"]["srv_pipeline"]["unmapped"].get("VERIFIED", 0) >= 1
    assert {m["status"] for m in out["srv_status_map"]} == set(STATUSES)


def test_aging_buckets():
    assert _aging([0, 3, 4, 7, 8, 15, 16, 40, None]) == {"0-3": 2, "4-7": 2, "8-15": 2, ">15": 2}


def test_window_is_validated():
    with pytest.raises(BadRequestError):
        ReceivingMonitorService().monitor(STORE, days=0)
    out = ReceivingMonitorService().monitor(STORE, days=30)
    assert out["window"] == {"days": 30, "from": (_today() - timedelta(days=30)).isoformat(),
                             "to": _today().isoformat()}
    assert [s["key"] for s in out["steps"]] == [
        "gate_entry", "physical_check", "invoice_verification", "srv_grn",
        "engineer_verification", "erp_update", "store_stock", "rack_placement"]
    assert out["sources"]["erp_sync"]["in_memory_only"] is True


# ---------------------------------------------------------------- endpoint

@pytest.fixture()
def client(app):
    return app.test_client()


def _login(client, perms=None, stores=(STORE,)):
    u = User(username=f"rcvuser{_next()}", role="STORE_USER", is_active=True)
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


URL = "/api/v1/receiving-monitor"


def test_endpoint_needs_spare_store_view(client):
    c = _login(client)
    assert c.get(f"{URL}?store_code={STORE}").status_code == 403


def test_endpoint_refuses_a_foreign_store(client):
    c = _login(client, perms={"spare_store": {"view": True}})
    assert c.get(f"{URL}?store_code=CHILD_PART").status_code == 403


def test_endpoint_ok_and_validates_input(client):
    c = _login(client, perms={"spare_store": {"view": True}})
    assert c.get(URL).status_code == 400
    assert c.get(f"{URL}?store_code={STORE}&days=0").status_code == 400
    assert c.get(f"{URL}?store_code={STORE}&days=abc").status_code == 400
    r = c.get(f"{URL}?store_code={STORE}&days=180")
    assert r.status_code == 200
    body = r.get_json()["data"]
    assert body["window"]["days"] == 180
    assert {"summary", "grn", "store_receipts", "srv_pipeline", "gate_not_received",
            "srv_status_map", "steps", "sources", "pipeline_statuses"} <= set(body)
    assert c.get(f"{URL}?store_code={STORE}").get_json()["data"]["window"]["days"] == 90
