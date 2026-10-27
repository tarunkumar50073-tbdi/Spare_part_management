"""Receiving is read from ERP (user decision 2026-09-26): the app records no
receipt / GRN / quality clearance by hand any more.

Under test: every manual receiving write answers 410; the scan result, the
part's timeline, the work queues, the dashboard overview, the alerts, the
receiving monitor and the Part Ledger all read receiving from ERP's GRN lines
(ErpGrnPostingService.lines), each ERP figure carrying the mirror's freshness.

Each test seeds its own throwaway store, so every count is known exactly (the
session DB is shared). The store is switched off again afterwards. Part stock
baselines are moved 30 days back so a GRN dated after them is eligible to be
added to stock, as in test_erp_grn_posting.
"""
from datetime import date, datetime, timedelta, timezone

import pytest

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.gate_entry import GateEntry
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.spare_flow import SpareReceipt
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.models.store import Section, Store
from app.models.user import User, UserStoreAccess
from app.services.erp_grn_posting_service import DEFAULTS, SETTING_KEY, ErpGrnPostingService
from app.services.erp_sync_service import ERPSyncService
from app.services.receiving_monitor_service import ReceivingMonitorService
from app.services.scan_result_service import ScanResultService
from app.services.spare_alerts_service import SpareAlertsService
from app.services.spare_dashboard_service import SpareDashboardService
from app.services.spare_flow_service import SpareFlowService
from app.services.spare_receipt_service import RECEIVING_IN_ERP, ReceivingInErpError
from app.services.spare_stock_service import SpareStockService

_seq = {"n": 0}
TODAY = datetime.now().date()
COUNTED_ON = datetime.now(timezone.utc) - timedelta(days=30)

ACTION_ORDER = [
    "ISSUE", "RGP_GRN", "RGP_RETURN", "INSPECT", "RETURN", "RGP_OUT",
    "PRINT_LABEL", "UPDATE_LOCATION", "HISTORY",
]


def _next():
    _seq["n"] += 1
    return _seq["n"]


def _ago(days):
    return TODAY - timedelta(days=days)


@pytest.fixture(autouse=True)
def _post_from(monkeypatch):
    """Posting eligible from 60 days back (the live default is the go-live day)."""
    monkeypatch.setattr(ERPSyncService, "_last_error", None)
    before = AppSetting.get_value(SETTING_KEY)
    AppSetting.set_value(SETTING_KEY, {"enabled": True, "from_date": _ago(60).isoformat()})
    yield
    AppSetting.set_value(SETTING_KEY, before if isinstance(before, dict) else dict(DEFAULTS))


@pytest.fixture()
def store():
    n = _next()
    s = Store(code=f"ERPR{n}", name=f"ERP Receiving Test Store {n}", sort_order=910)
    db.session.add(s)
    db.session.commit()
    sec = Section(store_id=s.id, name=f"ERP Receiving Section {n}")
    db.session.add(sec)
    db.session.commit()
    yield s, sec
    db.session.rollback()
    s.is_active = False
    db.session.commit()


def _part(s, sec, tag, counted=10):
    """A part of the throwaway store; `counted` = its physical count, taken 30
    days ago (None = never counted)."""
    p = Part(part_no=f"ERR-{_next()}-{tag}", part_name=f"ERP receiving {tag}", uom="NO",
             part_type="OTHER", store_code=s.code, section_id=sec.id, location="R2-S1-B4")
    db.session.add(p)
    db.session.commit()
    if counted is not None:
        SpareStockService().set_quantity(p.id, counted, txn_type="OPENING")
        row = SpareStock.query.filter_by(part_id=p.id).first()
        row.last_counted_at = row.created_at = COUNTED_ON
        for led in SpareStockLedger.query.filter_by(part_id=p.id).all():
            led.created_at = COUNTED_ON
        db.session.commit()
    return p


def _grn(part, days_ago, receipt, accept=None, reject=None, tag="G"):
    grn_no = f"{tag}-{_next()}"
    db.session.add(ReceivingRegister(
        store_code="CHILD_PART", grn_no=grn_no, grn_date=_ago(days_ago), ven_cd="VR-01",
        ven_name="Rexroth Traders", challan_no=f"INV-{grn_no}", item_cd=part.part_no,
        receipt_qty=receipt, accept_qty=accept, reject_qty=reject))
    db.session.commit()
    return grn_no


def _set_accept(grn_no, accept):
    ReceivingRegister.query.filter_by(grn_no=grn_no).update({"accept_qty": accept})
    db.session.commit()


def _gate(part, days_ago, qty):
    db.session.add(GateEntry(store_code="CHILD_PART", gate_entry_no=f"GE-ERR-{_next()}",
                             gate_entry_dt=_ago(days_ago), gate_entry_time="10:05", item_code=part.part_no,
                             qty=qty, ven_cd="VR-01", ven_name="Rexroth Traders"))
    db.session.commit()


def _on_hand(part):
    row = SpareStock.query.filter_by(part_id=part.id).first()
    return float(row.qty_on_hand) if row else None


def _acts(scan):
    return {a["key"]: a for a in scan["actions"]}


# ------------------------------------------------------------ manual writes

@pytest.fixture()
def client(app):
    return app.test_client()


def _login(client, perms=None, stores=("MAINTENANCE",), role="STORE_USER"):
    u = User(username=f"erpruser{_next()}", role=role, is_active=True)
    u.set_password("pw")
    u.set_permissions(perms or {})
    db.session.add(u)
    db.session.flush()
    for code in stores:
        db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
    db.session.commit()
    with client.session_transaction() as sess:
        sess["user_id"] = u.id
    return client


def test_every_manual_receiving_write_answers_410(client):
    c = _login(client, {"scan_part": {"view": True, "edit": True}})
    p = Part(part_no=f"ERR-{_next()}-M", part_name="Manual receive", uom="NO", part_type="OTHER",
             store_code="MAINTENANCE")
    db.session.add(p)
    db.session.commit()
    SpareStockService().set_quantity(p.id, 2, txn_type="OPENING")
    before = SpareReceipt.query.count()

    calls = [
        ("/api/v1/spare-flow/receipts", {"part_id": p.id, "qty": 3}),
        ("/api/v1/spare-flow/receipts/1/grn", {"grn_no": "G-1", "quality_by": "Maintenance"}),
        ("/api/v1/spare-flow/receipts/1/quality", {"accepted_qty": 1}),
        ("/api/v1/spare-flow/receipts/1/cancel", {"reason": "x"}),
        (f"/api/v1/spare-stock/parts/{p.id}/receive", {"qty": 3, "reference": "GRN-9"}),
    ]
    for url, body in calls:
        r = c.post(url, json=body)
        assert r.status_code == 410, url
        assert r.get_json()["message"] == RECEIVING_IN_ERP
        assert r.get_json()["success"] is False

    # Nothing was recorded and no stock moved.
    assert SpareReceipt.query.count() == before
    assert _on_hand(p) == 2.0
    # The in-app receipts recorded before the change stay readable.
    assert c.get("/api/v1/spare-flow/receipts?store_code=MAINTENANCE").status_code == 200


def test_the_service_receive_is_gone_too():
    with pytest.raises(ReceivingInErpError) as err:
        SpareStockService().receive(1, 5, reference="GRN-1", user="storeman")
    assert err.value.status_code == 410 and err.value.message == RECEIVING_IN_ERP


# ------------------------------------------------------------- scan result

def test_scan_result_reads_receiving_from_erp(store):
    s, sec = store
    p = _part(s, sec, "S")
    qp = _grn(p, 12, receipt=4, tag="QP")                            # quality pending in ERP
    wp = _grn(p, 10, receipt=3, accept=3, tag="WP")                  # accepted, to be added
    rj = _grn(p, 8, receipt=2, reject=2, tag="RJ")                   # rejected by quality
    old = _grn(p, 40, receipt=5, accept=5, tag="OLD")                # inside the count already
    _gate(p, 13, 4)
    scan = ScanResultService()

    r = scan.build(p.id)
    assert "open_receipts" not in r
    assert r["buckets"]["available"] == 10.0 and r["buckets"]["quality_pending"] == 4.0
    assert r["primary_status"]["key"] == "STOCK_AVAILABLE"
    # Issuance first: every receiving action is gone and ISSUE leads.
    assert [a["key"] for a in r["actions"]] == ACTION_ORDER
    assert r["primary_action"] == "ISSUE" and _acts(r)["ISSUE"]["enabled"]
    assert {"RECEIVE", "RECORD_GRN", "QUALITY_CLEARANCE"}.isdisjoint(_acts(r))

    quality = [loc for loc in r["locations"] if loc["kind"] == "QUALITY"]
    assert quality == [{"kind": "QUALITY", "label": f"GRN {qp} — quality pending in ERP", "qty": 4.0,
                        "supplier": "Rexroth Traders", "ref_type": "erp_grn", "ref_id": qp}]
    assert round(sum(loc["qty"] for loc in r["locations"]), 2) == round(sum(r["buckets"].values()), 2)

    er = r["erp_receiving"]
    assert {ln["grn_no"]: ln["state"] for ln in er["lines"]} == {qp: "QUALITY_PENDING", wp: "WILL_POST"}
    assert set(er["erp"]) == {"synced_at", "newest_grn_date"} and er["erp"]["synced_at"]
    line = next(ln for ln in er["lines"] if ln["grn_no"] == wp)
    assert (line["part_no"], line["receipt_qty"], line["accept_qty"], line["to_post"]) == (p.part_no, 3.0, 3.0, 3.0)

    # The timeline's receiving history is ERP's.
    rows = r["timeline"]["rows"]
    grn_rows = {row["grn_no"]: row for row in rows if row["kind"] == "ERP_GRN"}
    assert set(grn_rows) == {qp, wp, rj, old}
    assert grn_rows[qp]["title"] == f"GRN created in ERP – {qp}"
    assert grn_rows[qp]["detail"].startswith("received 4 · quality pending")
    assert grn_rows[wp]["detail"].startswith("accepted 3")
    assert grn_rows[rj]["detail"].startswith("rejected 2")
    assert "baseline" in grn_rows[old]["detail"]                      # why it was not added
    assert all(row["source"] == "erp_grn" for row in grn_rows.values())
    gate = next(row for row in rows if row["kind"] == "ERP_GATE")
    assert gate["title"] == "Received at gate – Rexroth Traders" and gate["source"] == "erp_gate"


def test_timeline_shows_the_erp_acceptance_and_the_stock_it_added(store):
    s, sec = store
    p = _part(s, sec, "T")
    wp = _grn(p, 10, receipt=3, accept=3, tag="WP")
    ErpGrnPostingService().post(s.code)
    assert _on_hand(p) == 13.0

    scan = ScanResultService()
    r = scan.build(p.id)
    assert [ln["state"] for ln in r["erp_receiving"]["lines"]] == ["POSTED"]
    assert r["buckets"]["available"] == 13.0 and r["buckets"]["quality_pending"] == 0.0

    rows = scan.timeline(p.id)["rows"]
    accepted = [i for i, row in enumerate(rows) if row["kind"] == "QUALITY_CLEARANCE"]
    assert len(accepted) == 1
    row = rows[accepted[0]]
    assert row["title"] == f"Quality accepted in ERP – GRN {wp}" and row["grn_no"] == wp
    assert row["source"] == "journal" and row["qty"] == 3.0 and row["qty_delta"] is None
    # Its stock change is shown once, right above it.
    added = rows[accepted[0] - 1]
    assert (added["kind"], added["title"], added["qty_delta"]) == ("STOCK_AVAILABLE", "Added to store stock", 3.0)
    assert [x["title"] for x in rows].count("Added to store stock") == 1
    assert next(x for x in rows if x["kind"] == "ERP_GRN")["new_status"] == "POSTED"
    assert not any("ERP updated" in (x["title"] or "") + (x["detail"] or "") for x in rows)


def test_scan_shows_only_the_newest_five_added_grns(store):
    s, sec = store
    p = _part(s, sec, "F")
    grns = [_grn(p, 20 - i, receipt=1, accept=1, tag=f"P{i}") for i in range(7)]
    ErpGrnPostingService().post(s.code)
    lines = ScanResultService().build(p.id)["erp_receiving"]["lines"]
    assert [ln["grn_no"] for ln in lines] == list(reversed(grns))[:5]        # newest GRN first


def test_a_grn_cleared_in_the_app_before_the_change_is_not_added_again(store):
    s, sec = store
    p = _part(s, sec, "IA")
    grn = _grn(p, 5, receipt=3, accept=3, tag="IA")
    # The earlier in-app flow: quality cleared 3 against that GRN, its number
    # typed by hand by the supervisor.
    SpareStockService()._write(p.id, 13, "RECEIPT", reference=f" {grn.lower()} ",
                               remarks="Quality cleared in the app", user="supervisor",
                               extra={"status": "STOCK_AVAILABLE"})
    db.session.commit()

    r = ScanResultService().build(p.id)
    line = next(ln for ln in r["erp_receiving"]["lines"] if ln["grn_no"] == grn)
    assert (line["state"], line["posted_qty"], line["to_post"]) == ("POSTED", 3.0, 0.0)
    assert r["buckets"]["available"] == 13.0 and r["buckets"]["quality_pending"] == 0.0
    rp = SpareDashboardService().overview(s.code)["receiving_pending"]
    assert (rp["to_add"], rp["qty"]["to_add"]) == (0, 0.0)
    steps = {x["key"]: x for x in ReceivingMonitorService().monitor(s.code, days=90)["flow"]["steps"]}
    assert (steps["STOCK_ADDED"]["count"], steps["STOCK_ADDED"]["qty"]) == (1, 3.0)

    assert ErpGrnPostingService().post(s.code)["posted"] == []
    assert _on_hand(p) == 13.0


def test_nothing_to_issue_guides_to_the_open_documents(store):
    s, sec = store
    p = _part(s, sec, "N", counted=None)
    _grn(p, 5, receipt=2, tag="QP")
    r = ScanResultService().build(p.id)
    assert r["primary_status"]["key"] == "QUALITY_PENDING"
    acts = _acts(r)
    assert not acts["ISSUE"]["enabled"] and acts["ISSUE"]["reason"] == "No stock available to issue"
    assert r["primary_action"] is None


# ------------------------------------------------------------------ queues

def test_quality_queue_lists_the_stores_erp_lines(store):
    s, sec = store
    a, b = _part(s, sec, "A"), _part(s, sec, "B")
    older = _grn(a, 15, receipt=4, tag="QP")
    check = _grn(b, 12, receipt=4, accept=4, tag="CK")
    _grn(b, 9, receipt=2, accept=2, tag="PO")                        # added below: not queued
    ErpGrnPostingService().post(s.code)
    _set_accept(check, 3)                                            # ERP now accepts less
    _grn(a, 3, receipt=1, accept=1, tag="WP2")                       # to be added: not queued

    q = ScanResultService().queues(s.code)
    assert q["counts"]["quality"] == 2
    assert [(x["grn_no"], x["state"]) for x in q["quality"]] == [(older, "QUALITY_PENDING"), (check, "CHECK")]
    first = q["quality"][0]
    assert (first["part_id"], first["part_no"], first["location"]) == (a.id, a.part_no, "R2-S1-B4")
    assert first["age_days"] == 15 and first["receipt_qty"] == 4.0
    assert set(q["erp"]) == {"synced_at", "newest_grn_date"}
    # Another store's ERP lines never show here.
    assert all(x["part_id"] in (a.id, b.id) for x in q["quality"])


# ---------------------------------------------------------------- overview

def _mixed(s, sec):
    """One line in each state the store is told about."""
    p = _part(s, sec, "O")
    qp = _grn(p, 14, receipt=4, tag="QP")
    check = _grn(p, 18, receipt=5, accept=5, tag="CK")
    ErpGrnPostingService().post(s.code)
    _set_accept(check, 4)
    _grn(p, 6, receipt=2, accept=2, tag="WP")
    return p, qp, check


def test_overview_receiving_pending_is_read_from_erp(store):
    s, sec = store
    _mixed(s, sec)
    # An in-app receipt from before the change no longer counts anywhere.
    old = _part(s, sec, "L")
    db.session.add(SpareReceipt(receipt_no=f"RCV-ERR-{_next()}", part_id=old.id, store_code=s.code,
                                status="RECEIVED", qty_received=9))
    db.session.commit()

    ov = SpareDashboardService().overview(s.code)
    rp = ov["receiving_pending"]
    assert (rp["quality_pending"], rp["check"], rp["to_add"], rp["total"]) == (1, 1, 1, 1)
    assert rp["awaiting_grn"] is None
    assert rp["qty"] == {"quality_pending": 4.0, "to_add": 2.0, "total": 4.0}
    assert (rp["oldest_grn_date"], rp["oldest_check_grn_date"]) == (_ago(14).isoformat(), _ago(18).isoformat())
    assert set(rp["erp"]) == {"synced_at", "newest_grn_date"}

    att = {a["key"]: a for a in ov["attention"]}["srv_pending"]
    assert (att["label"], att["count"], att["severity"]) == ("GRN / Quality pending", 1, "warning")
    assert att["action"] == {"label": "Open Receiving & GRN", "to": "/receiving"}
    assert "ERP GRN data as read" in att["hint"]

    # A section sees its own parts' lines only.
    other = Section(store_id=s.id, name=f"ERP Receiving Other {_next()}")
    db.session.add(other)
    db.session.commit()
    assert SpareDashboardService().overview(s.code, section_id=other.id)["receiving_pending"]["total"] == 0
    assert SpareDashboardService().overview(s.code, section_id=sec.id)["receiving_pending"]["total"] == 1


# ------------------------------------------------------------------ alerts

def test_alerts_come_from_erp_lines_with_their_freshness(store):
    s, sec = store
    _mixed(s, sec)
    a = {x["id"]: x for x in SpareAlertsService().alerts(s.code)["alerts"]}
    receiving = {"label": "Open Receiving & GRN", "to": "/receiving", "module": "receiving"}
    assert "receipts_pending" not in a

    qp = a["erp_grn_quality_pending"]
    assert (qp["severity"], qp["count"], qp["oldest_grn_date"]) == ("warning", 1, _ago(14).isoformat())
    assert qp["title"] == "1 ERP GRN line awaiting quality clearance" and qp["action"] == receiving
    assert f"Oldest GRN dated {_ago(14).isoformat()} (14 days ago)" in qp["message"]
    assert "ERP GRN data last read" in qp["message"] and "newest GRN dated" in qp["message"]
    assert "ERP updated" not in qp["message"]

    ck = a["erp_grn_check"]
    assert (ck["severity"], ck["count"], ck["oldest_grn_date"]) == ("warning", 1, _ago(18).isoformat())
    assert "check with ERP" in ck["message"] and "ERP GRN data last read" in ck["message"]
    assert ck["action"] == receiving


# ------------------------------------------------------------------ monitor

def test_receiving_monitor_flow_is_read_from_erp(store):
    s, sec = store
    p, other = _part(s, sec, "R"), _part(s, sec, "X")
    _gate(p, 21, 4)
    _gate(other, 5, 2)                                               # no GRN after it
    qp = _grn(p, 20, receipt=4, tag="QP")
    posted = _grn(p, 15, receipt=3, accept=3, tag="PO")
    ErpGrnPostingService().post(s.code)
    rj = _grn(p, 12, receipt=2, reject=2, tag="RJ")
    wp = _grn(p, 10, receipt=5, accept=5, tag="WP")
    skipped = _grn(p, 40, receipt=1, accept=1, tag="SK")             # inside the count already
    _grn(p, 200, receipt=7, tag="OUT")                               # before the window

    out = ReceivingMonitorService().monitor(s.code, days=90)
    flow = out["flow"]
    steps = {x["key"]: (x["count"], x["qty"], x["waiting"]) for x in flow["steps"]}
    assert [x["key"] for x in flow["steps"]] == [
        "GATE", "GRN_CREATED", "QUALITY_PENDING", "QUALITY_CLEARED", "STOCK_ADDED"]
    assert {x["key"]: x["label"] for x in flow["steps"]}["QUALITY_CLEARED"] == "Accepted by quality (ERP)"
    assert steps == {
        "GATE": (2, 6.0, None),
        "GRN_CREATED": (5, 15.0, None),
        "QUALITY_PENDING": (5, 15.0, 1),
        "QUALITY_CLEARED": (3, 9.0, 1),
        "STOCK_ADDED": (1, 3.0, None),
    }
    assert {r["grn_no"]: r["state"] for r in flow["receipts"]} == {
        qp: "QUALITY_PENDING", posted: "POSTED", rj: "REJECTED", wp: "WILL_POST", skipped: "SKIPPED"}
    assert all(r["section"] == sec.name and r["age_days"] is not None for r in flow["receipts"])
    assert (flow["open"], flow["check"], flow["skipped"], flow["rejected"], flow["rejected_qty"]) == (1, 0, 1, 1, 2.0)
    assert set(flow["erp"]) == {"synced_at", "newest_grn_date"}

    # The stock-in the ERP sync wrote reads as ERP-origin, never "not in ERP".
    stock_in = [r for r in out["store_receipts"] if r["part_id"] == p.id]
    assert [(r["status"], r["reference"], r["erp_origin"]) for r in stock_in] == [("ERP_GRN", posted, True)]
    assert stock_in[0]["status_label"] == "Accepted by quality in ERP — in stock"

    # A gate arrival with no GRN after it is a likely pending, never tied to a GRN.
    gate = [g for g in out["gate_not_received"] if g["part_id"] in (p.id, other.id)]
    assert [g["part_id"] for g in gate] == [other.id] and "likely" in gate[0]["note"]

    steps = {x["key"]: x for x in out["steps"]}
    assert steps["engineer_verification"]["count"] == 4             # POSTED, REJECTED, WILL_POST, SKIPPED
    assert steps["invoice_verification"]["count"] == 5              # the challan no. on each ERP line
    # ERP's GRN register has no physical check result, and this store never
    # recorded one in the app.
    assert (steps["physical_check"]["state"], steps["physical_check"]["count"]) == ("not_tracked", None)


# ------------------------------------------------------------ Part Ledger

def test_part_ledger_never_counts_quality_pending_as_stock(store):
    s, sec = store
    p = _part(s, sec, "L")
    qp = _grn(p, 9, receipt=4, tag="QP")
    posted = _grn(p, 8, receipt=3, accept=3, tag="PO")
    ErpGrnPostingService().post(s.code)

    led = SpareFlowService().traceability(p.id)["ledger"]
    by_ref = {(e["kind"], e["reference"]): e for e in led}
    pending = by_ref[("RECEIVED", qp)]
    assert (pending["direction"], pending["qty"]) == ("pending", 4.0)
    assert "quality pending in ERP" in pending["remarks"]
    assert by_ref[("RECEIVED", posted)]["direction"] == "matched"   # the stock-in row counts it
    assert by_ref[("RECEIPT", posted)]["direction"] == "in"
    assert sum(e["qty"] for e in led if e["direction"] == "in") == 3.0
