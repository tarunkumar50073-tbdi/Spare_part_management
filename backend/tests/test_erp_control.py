"""ERP Control Center status (/api/v1/erp-control/status).

The snapshot state is store-wide, and other tests seed ERP figures for
MAINTENANCE parts, so the state tests each run against their own throwaway
(inactive) store: a store with no ERP rows must read NONE, one whose newest row
is 46 days old must read STALE — whatever the rest of the session has seeded.
"""
import os
from datetime import timedelta

import pytest

from app.extensions import db
from app.models.base import utcnow
from app.models.erp_stock import ERPStock
from app.models.gate_entry import GateEntry
from app.models.part import Part
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.models.store import Store
from app.models.user import User, UserStoreAccess
from app.services.erp_control_service import (
    ERPControlService, db_sync_state, inbox_state, snapshot_state,
)
from app.services.erp_ledger_inbox_service import ERPLedgerInboxService
from app.services.erp_sync_service import ERPSyncService

_seq = {"n": 0}


def _next():
    _seq["n"] += 1
    return _seq["n"]


def _store():
    n = _next()
    s = Store(code=f"ERPCTL-{n}", name=f"ERP Control Test {n}", is_active=False)
    db.session.add(s)
    db.session.commit()
    return s.code


def _part(store_code, rate=None):
    n = _next()
    p = Part(part_no=f"ECC-{n}", part_name=f"ERP Control Part {n}", uom="NO",
             part_type="OTHER", store_code=store_code, unit_price=rate)
    db.session.add(p)
    db.session.commit()
    return p


def _erp(part, qty, age=timedelta(0)):
    db.session.add(ERPStock(part_id=part.id, qty_on_hand=qty, synced_at=utcnow() - age))
    db.session.commit()


def _count(part, qty):
    db.session.add(SpareStock(part_id=part.id, qty_on_hand=qty, last_counted_at=utcnow()))
    db.session.commit()


def _user(role="STORE_USER", stores=(), perms=None):
    n = _next()
    u = User(username=f"erpctl{n}", role=role, is_active=True)
    u.set_password("pw")
    if perms is not None:
        u.set_permissions(perms)
    db.session.add(u)
    db.session.flush()
    for code in stores:
        db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
    db.session.commit()
    return u


def _login(client, user):
    with client.session_transaction() as s:
        s["user_id"] = user.id


@pytest.fixture()
def client(app):
    return app.test_client()


@pytest.fixture()
def quiet_erp(app, monkeypatch, tmp_path):
    """No ERP DB credentials, write-back off, an empty inbox of our own and a
    clean in-memory sync status — whatever .env or an earlier test left."""
    for key in ("ERP_DB_HOST", "ERP_DB_USER", "ERP_DB_PASSWORD", "ERP_API_BASE_URL"):
        monkeypatch.setitem(app.config, key, None)
    monkeypatch.setitem(app.config, "ERP_STOCK_WRITE_ENABLED", False)
    monkeypatch.setitem(app.config, "ERP_LEDGER_INBOX", str(tmp_path / "inbox"))
    monkeypatch.setattr(ERPSyncService, "_last_sync_at", None)
    monkeypatch.setattr(ERPSyncService, "_last_result", None)
    monkeypatch.setattr(ERPSyncService, "_last_error", None)
    monkeypatch.setattr(ERPLedgerInboxService, "_last_scan_at", None)
    monkeypatch.setattr(ERPLedgerInboxService, "_last_error", None)
    monkeypatch.setattr(ERPLedgerInboxService, "_recent", [])
    return app


# ------------------------------------------------------------------ route

def test_status_shape(client, quiet_erp):
    _login(client, _user(role="ADMIN"))
    resp = client.get("/api/v1/erp-control/status?store_code=MAINTENANCE")
    assert resp.status_code == 200
    d = resp.get_json()["data"]
    assert d["store_code"] == "MAINTENANCE"
    for key in ("stock_snapshot", "db_sync", "ledger_inbox", "write_back", "reconciliation", "data_sources"):
        assert key in d
    assert d["stock_snapshot"]["state"] in ("NONE", "STALE", "SYNCED")
    assert d["db_sync"]["state"] == "NOT_CONFIGURED"
    assert d["db_sync"]["status_in_memory"] is True
    assert set(d["db_sync"]["mirrors"]) == {"gate_entries", "receiving_register"}
    assert d["ledger_inbox"]["state"] == "NOT_SCANNED"
    assert d["write_back"]["state"] == "DISABLED" and d["write_back"]["active"] is False
    assert len(d["write_back"]["rows"]) <= 50
    assert {"matched", "short", "excess", "not_synced", "accuracy_pct", "value_impact"} <= set(d["reconciliation"])
    assert [s["key"] for s in d["data_sources"]] == ["erp", "dx", "physical"]


def test_status_requires_store_code(client):
    _login(client, _user(role="ADMIN"))
    assert client.get("/api/v1/erp-control/status").status_code == 400


def test_unknown_store_is_404(client):
    _login(client, _user(role="ADMIN"))
    assert client.get("/api/v1/erp-control/status?store_code=NO-SUCH-STORE").status_code == 404


def test_foreign_store_user_is_refused(client):
    user = _user(stores=["CHILD_PART"], perms={"erp_control": {"view": True, "edit": False}})
    _login(client, user)
    assert client.get("/api/v1/erp-control/status?store_code=MAINTENANCE").status_code == 403


def test_needs_erp_control_permission(client, quiet_erp):
    # ERP vs Physical's right alone no longer opens it: it has its own (23 Oct 2026).
    without = _user(stores=["MAINTENANCE"], perms={"erp_gap": {"view": True, "edit": True}})
    _login(client, without)
    assert client.get("/api/v1/erp-control/status?store_code=MAINTENANCE").status_code == 403

    with_view = _user(stores=["MAINTENANCE"], perms={"erp_control": {"view": True, "edit": False}})
    _login(client, with_view)
    assert client.get("/api/v1/erp-control/status?store_code=MAINTENANCE").status_code == 200


# ----------------------------------------------------------------- states

def test_snapshot_none_when_erp_never_pushed(quiet_erp):
    code = _store()
    _part(code)
    snap = ERPControlService().status(code)["stock_snapshot"]
    assert snap["state"] == "NONE"
    assert snap["rows"] == 0 and snap["parts_total"] == 1
    assert snap["last_synced_at"] is None and snap["age_hours"] is None


def test_snapshot_stale_when_older_than_a_day(quiet_erp):
    code = _store()
    a, b = _part(code), _part(code)
    _erp(a, 5, age=timedelta(days=46))
    _erp(b, 7, age=timedelta(days=50))
    snap = ERPControlService().status(code)["stock_snapshot"]
    assert snap["state"] == "STALE"
    assert snap["rows"] == 2 and snap["parts_total"] == 2 and snap["coverage_pct"] == 100.0
    assert snap["age_days"] == 46                       # newest row decides the age
    assert snap["last_synced_at"].endswith("+00:00")    # aware, so the browser shows local time


def test_snapshot_synced_when_fresh(quiet_erp):
    code = _store()
    _erp(_part(code), 3, age=timedelta(hours=2))
    _part(code)                                          # never pushed: lowers coverage only
    snap = ERPControlService().status(code)["stock_snapshot"]
    assert snap["state"] == "SYNCED" and snap["coverage_pct"] == 50.0


def test_db_sync_states(app, quiet_erp, monkeypatch):
    code = _store()
    assert ERPControlService().status(code)["db_sync"]["state"] == "NOT_CONFIGURED"

    for key, val in (("ERP_DB_HOST", "erp.local"), ("ERP_DB_USER", "u"), ("ERP_DB_PASSWORD", "p")):
        monkeypatch.setitem(app.config, key, val)
    sync = ERPControlService().status(code)["db_sync"]
    assert sync["state"] == "NEVER_RUN" and sync["last_sync_at"] is None

    monkeypatch.setattr(ERPSyncService, "_last_sync_at", (utcnow() - timedelta(hours=3)).isoformat())
    sync = ERPControlService().status(code)["db_sync"]
    assert sync["state"] == "OK" and 2.9 < sync["last_sync_age_hours"] < 3.1

    monkeypatch.setattr(ERPSyncService, "_last_error", "OperationalError: timeout")
    sync = ERPControlService().status(code)["db_sync"]
    assert sync["state"] == "ERROR" and sync["last_error"] == "OperationalError: timeout"


def test_pure_state_rules():
    assert snapshot_state(0, None) == "NONE"
    assert snapshot_state(4, 25) == "STALE"
    assert snapshot_state(4, 1) == "SYNCED"
    assert db_sync_state({"configured": False, "last_error": "x"}) == "NOT_CONFIGURED"
    assert inbox_state({"last_error": None, "pending_files": ["a.xlsx"], "last_scan_at": None}) == "FILES_WAITING"
    assert inbox_state({"last_error": "boom", "pending_files": [], "last_scan_at": "t"}) == "ERROR"
    assert inbox_state({"last_error": None, "pending_files": [], "last_scan_at": "t",
                        "recent": [{"file": "b.xlsx", "ok": False}, {"file": "a.xlsx", "ok": True}]}) == "LAST_FILE_FAILED"
    assert inbox_state({"last_error": None, "pending_files": [], "last_scan_at": "t",
                        "recent": [{"file": "a.xlsx", "ok": True}]}) == "OK"


def test_ledger_inbox_lists_waiting_files_without_importing(app, quiet_erp):
    inbox = app.config["ERP_LEDGER_INBOX"]
    os.makedirs(inbox, exist_ok=True)
    with open(os.path.join(inbox, "ledger.xlsx"), "wb") as f:
        f.write(b"not really excel")
    box = ERPControlService().status("MAINTENANCE")["ledger_inbox"]
    assert box["state"] == "FILES_WAITING" and box["pending_files"] == ["ledger.xlsx"]
    assert os.path.exists(os.path.join(inbox, "ledger.xlsx"))   # status never imports


# ---------------------------------------------------- write-back + gaps

def test_write_back_pending_queue(quiet_erp):
    code = _store()
    p = _part(code)
    db.session.add(SpareStockLedger(part_id=p.id, qty_delta=-2, balance_after=3, txn_type="ISSUE",
                                    department="Press Shop", created_at=utcnow() - timedelta(days=3)))
    db.session.add(SpareStockLedger(part_id=p.id, qty_delta=5, balance_after=5, txn_type="OPENING"))
    db.session.commit()
    wb = ERPControlService().status(code)["write_back"]
    assert wb["state"] == "DISABLED"
    assert wb["pending"] == 1                          # OPENING is never pushed
    assert wb["rows"][0]["part_no"] == p.part_no and wb["rows"][0]["txn_type"] == "ISSUE"
    assert 71 < wb["oldest_pending_age_hours"] < 73
    assert wb["pushed_total"] == 0 and wb["last_pushed_at"] is None


def test_reconciliation_values_gaps_at_master_rate(quiet_erp):
    code = _store()
    short = _part(code, rate=100); _erp(short, 10); _count(short, 8)      # 2 short x 100
    excess = _part(code, rate=5); _erp(excess, 3); _count(excess, 7)      # 4 over x 5
    unpriced = _part(code); _erp(unpriced, 5); _count(unpriced, 2)        # short, no rate
    match = _part(code, rate=9); _erp(match, 4); _count(match, 4)
    rec = ERPControlService().status(code)["reconciliation"]
    assert (rec["matched"], rec["short"], rec["excess"]) == (1, 2, 1)
    assert rec["accuracy_pct"] == 25.0
    v = rec["value_impact"]
    assert v["short_value"] == 200.0 and v["excess_value"] == 20.0 and v["gross_value"] == 220.0
    assert v["priced_gaps"] == 2 and v["unpriced_gaps"] == 1
    assert rec["top_gaps"][0]["part_no"] == short.part_no and rec["top_gaps"][0]["value"] == 200.0
    assert rec["erp_state"] == "SYNCED" and rec["counted_from"] is not None


def test_value_is_unknown_not_zero_when_no_gap_has_a_rate(quiet_erp):
    code = _store()
    a = _part(code); _erp(a, 10); _count(a, 4)                            # short, no rate
    b = _part(code, rate=0); _erp(b, 6); _count(b, 1)                     # short, zero rate
    v = ERPControlService().status(code)["reconciliation"]["value_impact"]
    assert v["short_value"] is None and v["gross_value"] is None          # unknown, not 0
    assert v["short_priced"] == 0 and v["short_unpriced"] == 2
    assert v["excess_value"] == 0.0 and v["excess_unpriced"] == 0         # no excess gap at all


def test_one_fresh_push_does_not_hide_stale_figures(quiet_erp):
    code = _store()
    old = _part(code); _erp(old, 5, age=timedelta(days=46)); _count(old, 5)
    fresh = _part(code); _erp(fresh, 2, age=timedelta(hours=1)); _count(fresh, 2)
    rec = ERPControlService().status(code)["reconciliation"]
    assert rec["erp_state"] == "SYNCED"                   # the newest figure is fresh...
    assert rec["erp_figures"] == 2 and rec["erp_stale_figures"] == 1   # ...but one is 46 d old
    assert rec["erp_oldest_age_hours"] > 46 * 24 - 1


def test_data_sources_split_ledger_by_what_reaches_erp(quiet_erp):
    code = _store()
    p = _part(code)
    for txn_type, delta in (("OPENING", 5), ("OPENING", 1), ("ADJUSTMENT", -1), ("ISSUE", -2)):
        db.session.add(SpareStockLedger(part_id=p.id, qty_delta=delta, balance_after=3, txn_type=txn_type))
    db.session.commit()
    dx = next(s for s in ERPControlService().status(code)["data_sources"] if s["key"] == "dx")
    assert dx["ledger_rows"] == 4
    assert (dx["movement_rows"], dx["opening_rows"], dx["adjustment_rows"]) == (1, 2, 1)
    assert dx["ledger_started_at"].endswith("+00:00")


def test_unavailable_inbox_keeps_its_scan_history(app, quiet_erp, monkeypatch):
    def boom(self):
        raise PermissionError("inbox not writable")
    monkeypatch.setattr(ERPLedgerInboxService, "status", boom)
    monkeypatch.setattr(ERPLedgerInboxService, "_last_scan_at", (utcnow() - timedelta(hours=2)).isoformat())
    monkeypatch.setattr(ERPLedgerInboxService, "_last_error", "OSError: share offline")
    monkeypatch.setattr(ERPLedgerInboxService, "_consecutive_failures", 7)
    box = ERPControlService().status("MAINTENANCE")["ledger_inbox"]
    assert box["state"] == "UNAVAILABLE" and "inbox not writable" in box["error"]
    assert box["pending_files"] is None                   # unknown, not "0 waiting"
    assert box["last_error"] == "OSError: share offline" and box["consecutive_failures"] == 7
    assert 1.9 < box["last_scan_age_hours"] < 2.1
    assert box["poll_seconds"] == app.config.get("ERP_LEDGER_POLL_SECONDS")


def test_mirror_matches_store_parts_case_insensitively(quiet_erp):
    code = _store()
    p = _part(code)
    row = GateEntry(store_code="CHILD_PART", gate_entry_no=f"G-{p.id}",
                    item_code=f" {p.part_no.lower()} ", qty=1)
    db.session.add(row)
    db.session.commit()
    try:
        gate = ERPControlService().status(code)["db_sync"]["mirrors"]["gate_entries"]
        assert gate["matched_rows"] == 1 and gate["matched_parts"] == 1
        assert gate["rows"] >= 1
    finally:
        # The gate mirror is shared plant-wide; leave it as the other tests expect.
        db.session.delete(row)
        db.session.commit()
