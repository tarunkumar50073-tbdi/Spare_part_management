"""ERP -> app-mirror sync mapping. The live ERP Postgres isn't reachable from
the test env, so the read-only ERPDBClient is stubbed and only the mapping +
qty casting + replace path is exercised."""
from datetime import date

from app.services.erp_sync_service import ERPSyncService, _num
from app.models.gate_entry import GateEntry
from app.models.receiving_register import ReceivingRegister


def test_num_caster():
    assert _num("7200") == 7200.0
    assert _num("1,234.5") == 1234.5
    assert _num(" 12 ") == 12.0
    assert _num(None) is None
    assert _num("") is None
    assert _num("None") is None      # ERP hands blanks back as the string 'None'
    assert _num("abc") is None       # a bad cell must not raise mid-sync


def test_not_configured_raises(monkeypatch):
    from app.services.erp_db_client import ERPDBNotConfigured
    svc = ERPSyncService()
    monkeypatch.setattr(svc.erp, "configured", lambda: False)
    try:
        svc.sync_all()
        assert False, "expected ERPDBNotConfigured"
    except ERPDBNotConfigured:
        pass


def test_sync_maps_and_casts(monkeypatch):
    svc = ERPSyncService()
    monkeypatch.setattr(svc.erp, "configured", lambda: True)

    def fake_fetch(table, columns, since_col=None, since_date=None, until_date=None):
        if until_date is not None:          # the one-time history load: nothing older in this ERP
            return []
        if table == "gate_entry":
            return [{"gate_entry_no": "2526/001/1", "gate_entry_dt": date(2026, 8, 17),
                     "gate_entry_time": "11:34", "ven_cd": "VN-0019", "ven_name": "NEEMRANA",
                     "challan_dt": date(2026, 8, 16), "po_no": "RM00124", "item_cd": "7S111-X0000",
                     "reference_code": "REF-1", "item_desc": "BLANK RAIL", "qty": "7,200"}]
        if table == "srv_report":
            return [{"grn_no": "CA2526/001/1", "grn_date": date(2026, 8, 17), "vendor_cd": "VN-0023",
                     "vendor_name": "NILKAMAL", "invoice_no": "6148870586", "item_cd": "CGPK0021",
                     "item_desc": "CRATE", "challan_qty": "114", "receipt_qty": "114",
                     "accept_qty": "114", "reject_qty": None}]
        return []

    monkeypatch.setattr(svc.erp, "fetch_rows", fake_fetch)
    result = svc.sync_all()
    assert {k: result[k] for k in ("gate_entry", "receiving_register")} == {"gate_entry": 1, "receiving_register": 1}
    # Every sync also adds the ERP-accepted spare GRN lines to store stock
    # (ErpGrnPostingService); CGPK0021 is no spare part, so nothing of this one.
    assert isinstance(result["spare_grn_posted"], int)

    g = GateEntry.query.filter_by(gate_entry_no="2526/001/1").one()
    assert g.item_code == "7S111-X0000"        # ERP item_cd -> mirror item_code
    assert float(g.qty) == 7200.0              # varchar '7,200' -> Numeric
    assert g.bill_date == date(2026, 8, 16)    # ERP challan_dt -> bill_date
    assert g.gate_entry_time == "11:34"
    assert g.ven_name == "NEEMRANA"

    r = ReceivingRegister.query.filter_by(grn_no="CA2526/001/1").one()
    assert r.ven_cd == "VN-0023"               # ERP vendor_cd -> ven_cd
    assert r.challan_no == "6148870586"        # ERP invoice_no -> challan_no
    assert float(r.receipt_qty) == 114.0
    assert r.reject_qty is None                # None stays None, not 0

    # re-running replaces (idempotent) — still exactly one row, no double-count
    again = svc.sync_all()
    assert (again["gate_entry"], again["receiving_register"]) == (1, 1)
    assert GateEntry.query.filter_by(store_code="CHILD_PART").count() == 1


def test_window_status_uses_gate_arrivals():
    """Once the Gate Entry mirror has rows, window-vs-arrival status is judged
    against the real ERP gate arrivals (not the app's empty SRV table): a truck
    inside its window reads On-Time, one after it reads Late."""
    from datetime import date, time
    from app.extensions import db
    from app.models.supplier import Supplier
    from app.models.supplier_window_schedule import SupplierWindowSchedule
    from app.services.supplier_window_schedule_service import SupplierWindowScheduleService

    vc = "VZ-9001"
    day = date(2024, 3, 5)  # safely in the past so the status fully resolves
    db.session.add(Supplier(vendor_code=vc, supplier_name="Wire Test Supplier", status="Active"))
    db.session.add(SupplierWindowSchedule(vendor_code=vc, window_start=time(9, 0), window_end=time(10, 0),
                                          frequency="Daily", effective_from=date(2024, 1, 1), status="Active"))
    db.session.add(SupplierWindowSchedule(vendor_code=vc, window_start=time(11, 0), window_end=time(12, 0),
                                          frequency="Daily", effective_from=date(2024, 1, 1), status="Active"))
    db.session.add(GateEntry(store_code="CHILD_PART", gate_entry_no="GT-A", gate_entry_dt=day,
                             gate_entry_time="09:20", ven_cd=vc, item_code="X1"))   # inside window A
    db.session.add(GateEntry(store_code="CHILD_PART", gate_entry_no="GT-B", gate_entry_dt=day,
                             gate_entry_time="12:30", ven_cd=vc, item_code="X2"))   # after window B
    db.session.commit()

    rows = [r for r in SupplierWindowScheduleService().get_status_for_date(day) if r["vendor_code"] == vc]
    by_start = {r["window_start"]: r for r in rows}
    assert by_start["09:00:00"]["status"] == "On-Time"
    assert by_start["09:00:00"]["actual_arrival"].endswith("09:20:00")
    assert by_start["11:00:00"]["status"] == "Late"


def test_month_late_report_only_late_with_delay():
    """The monthly late report lists only Late arrivals, date-wise, with the
    minutes-late computed off the window close."""
    from datetime import date, time
    from app.extensions import db
    from app.models.supplier import Supplier
    from app.models.supplier_window_schedule import SupplierWindowSchedule
    from app.services.supplier_window_schedule_service import SupplierWindowScheduleService

    vc = "VZ-9002"
    day = date(2024, 6, 10)  # a past month with no other seeded data
    db.session.add(Supplier(vendor_code=vc, supplier_name="Late Test Supplier", status="Active"))
    db.session.add(SupplierWindowSchedule(vendor_code=vc, window_start=time(9, 0), window_end=time(10, 0),
                                          frequency="Daily", effective_from=date(2024, 1, 1), status="Active"))
    db.session.add(GateEntry(store_code="CHILD_PART", gate_entry_no="GTL-1", gate_entry_dt=day,
                             gate_entry_time="10:45", ven_cd=vc, item_code="Z"))   # 45 min after close
    db.session.commit()

    rep = SupplierWindowScheduleService().month_late_report(2024, 6)
    mine = [r for r in rep["rows"] if r["supplier"] == "Late Test Supplier"]
    assert len(mine) == 1                        # only the one late day, not every daily window
    assert mine[0]["date"] == "2024-06-10"
    assert mine[0]["window"] == "09:00-10:00"
    assert mine[0]["delay_min"] == 45
    assert mine[0]["actual_arrival"].endswith("10:45")
    assert any(s["supplier"] == "Late Test Supplier" and s["late_count"] == 1 for s in rep["summary"])


def test_window_time_board():
    """The control-tower payload: KPI counts + severity-tagged alerts derived
    from the day's window-vs-arrival status."""
    from datetime import date, time
    from app.extensions import db
    from app.models.supplier import Supplier
    from app.models.supplier_window_schedule import SupplierWindowSchedule
    from app.services.supplier_window_schedule_service import SupplierWindowScheduleService

    vc = "VZ-9003"
    day = date(2024, 7, 15)
    db.session.add(Supplier(vendor_code=vc, supplier_name="Board Test Supplier", status="Active"))
    db.session.add(SupplierWindowSchedule(vendor_code=vc, window_start=time(9, 0), window_end=time(10, 0),
                                          frequency="Daily", effective_from=date(2024, 1, 1), status="Active"))
    db.session.add(SupplierWindowSchedule(vendor_code=vc, window_start=time(13, 0), window_end=time(14, 0),
                                          frequency="Daily", effective_from=date(2024, 1, 1), status="Active"))
    db.session.add(GateEntry(store_code="CHILD_PART", gate_entry_no="GB-1", gate_entry_dt=day,
                             gate_entry_time="09:30", ven_cd=vc, item_code="A"))   # On-Time
    db.session.add(GateEntry(store_code="CHILD_PART", gate_entry_no="GB-2", gate_entry_dt=day,
                             gate_entry_time="14:40", ven_cd=vc, item_code="B"))   # Late
    db.session.commit()

    board = SupplierWindowScheduleService().window_time_board(day)
    assert board["date"] == "2024-07-15"
    assert board["kpis"]["on_time"] >= 1
    assert board["kpis"]["overstay"] is None                 # no Gate Exit source yet
    assert board["summary"]["warning"] >= 1                  # our late arrival
    late = [a for a in board["alerts"] if a["supplier"] == "Board Test Supplier" and a["severity"] == "warning"]
    assert late and "late by 40 min" in late[0]["title"]


def test_erp_pollers_start_under_waitress_even_in_development_mode(app, monkeypatch):
    """24 Oct 2026: the live site got no ERP data. The ERP pollers took the one
    real process of a server without a reloader (serve.py / waitress, a .env
    still saying development) for the reloader parent and never started; mail
    and backup already knew DX_NO_RELOADER."""
    from app import _start_erp_ledger_poller, _start_erp_sync_poller
    from app.services.erp_ledger_inbox_service import ERPLedgerInboxService
    started = []
    monkeypatch.setattr(ERPSyncService, "start_poller", lambda self, a: started.append("sync"))
    monkeypatch.setattr(ERPLedgerInboxService, "start_poller", lambda self, a: started.append("ledger"))
    monkeypatch.delenv("WERKZEUG_RUN_MAIN", raising=False)
    monkeypatch.delenv("DX_NO_RELOADER", raising=False)
    assert app.debug
    _start_erp_sync_poller(app)
    _start_erp_ledger_poller(app)
    assert started == []                                  # the reloader parent: its child starts them
    monkeypatch.setenv("DX_NO_RELOADER", "1")             # what serve.py sets
    _start_erp_sync_poller(app)
    _start_erp_ledger_poller(app)
    assert started == ["sync", "ledger"]
    monkeypatch.delenv("DX_NO_RELOADER")
    monkeypatch.setenv("WERKZEUG_RUN_MAIN", "true")       # the reloader's serving child
    _start_erp_sync_poller(app)
    assert started == ["sync", "ledger", "sync"]


# ---- 27 Oct 2026: ERP stock, per-table status, one read at a time ----------------
# (ERP's line rejections were read too until 17 Nov 2026, when the store removed every rejection view.)

def _fake(tables):
    def fetch(table, columns, since_col=None, since_date=None, until_date=None):
        if until_date is not None:          # the one-time history load: nothing older in this ERP
            return []
        got = tables.get(table, [])
        if isinstance(got, Exception):
            raise got
        return got
    return fetch


def test_erp_stock_comes_in_and_each_table_reports_itself(monkeypatch):
    from app.extensions import db
    from app.models.app_setting import AppSetting
    from app.models.erp_stock import ERPStock
    from app.models.part import Part
    from app.services.erp_sync_service import SYNC_STATUS_KEY
    from app.services.spare_stock_service import SpareStockService
    p = Part(part_no="ERPSTK-1", part_name="ERP STOCK BEARING", uom="NOS", part_type="OTHER", store_code="MAINTENANCE")
    db.session.add(p)
    db.session.commit()
    SpareStockService().set_quantity(p.id, 7, txn_type="OPENING")
    svc = ERPSyncService()
    monkeypatch.setattr(svc.erp, "configured", lambda: True)
    monkeypatch.setattr(svc, "_erp_latest", lambda: {"erp_stock": "02:00:49"})
    erp = {"current_stock": [{"item_cd": " erpstk-1 ", "clos_stock": "5"}, {"item_cd": "ERPSTK-1", "clos_stock": "3"},
                             {"item_cd": "NOT-IN-APP", "clos_stock": "9"}],
           "challan_register": []}
    read = []
    fetch = _fake(erp)

    def counting(table, columns, since_col=None, since_date=None, until_date=None):
        read.append(table)
        return fetch(table, columns, since_col, since_date, until_date)
    monkeypatch.setattr(svc.erp, "fetch_rows", counting)
    from app.services.job_work_service import JobWorkService
    monkeypatch.setattr(JobWorkService, "_read_erp", staticmethod(lambda: []))
    result = svc.sync_all()
    assert result["erp_stock"] >= 1 and "line_rejection" not in result
    assert "line_rejection_report" not in read                                      # no longer read at all
    assert float(ERPStock.query.filter_by(part_id=p.id).one().qty_on_hand) == 8      # 5 + 3, two ERP locations
    from app.models.spare_stock import SpareStock
    assert float(SpareStock.query.filter_by(part_id=p.id).one().qty_on_hand) == 7    # physical untouched
    saved = AppSetting.get_value(SYNC_STATUS_KEY)
    assert saved["ok"] is True and saved["tables"]["erp_stock"]["erp_latest"] == "02:00:49"

    # ERP no longer lists the part (other parts still listed): no guessed 0 —
    # the figure goes ("Awaiting ERP"). An empty read keeps the last figures
    # (21 Nov 2026), so another part stays listed here.
    # And one table failing never stops the others; the failure is saved.
    erp["current_stock"] = [{"item_cd": "NOT-IN-APP", "clos_stock": "9"}]
    erp["gate_entry"] = ConnectionError("gate entry table locked")
    result = svc.sync_all()
    assert ERPStock.query.filter_by(part_id=p.id).first() is None
    assert result["gate_entry"] is None
    saved = AppSetting.get_value(SYNC_STATUS_KEY)
    assert saved["ok"] is False and "gate entry table locked" in saved["tables"]["gate_entry"]["error"]
    assert saved["tables"]["erp_stock"]["ok"] is True                               # the next table still ran
    st = svc.status()
    assert st["tables"]["gate_entry"]["ok"] is False and "gate entry" in (st["last_error"] or "")


def test_a_second_read_while_one_runs_is_skipped(monkeypatch):
    svc = ERPSyncService()
    monkeypatch.setattr(svc.erp, "configured", lambda: True)
    ERPSyncService._lock.acquire()
    try:
        assert "skipped" in svc.sync_all()
    finally:
        ERPSyncService._lock.release()


def test_history_is_kept_and_loaded_one_year_per_run(monkeypatch):
    """27 Nov 2026 ("last 5 saal ka data"): a read swaps only the last
    ERP_SYNC_SINCE_DAYS; older gate entries / GRN lines stay. Five years are
    loaded once, ONE year per run after the refresh, and not again; an empty
    read keeps the rows."""
    from datetime import timedelta
    from flask import current_app
    from app.extensions import db
    from app.models.app_setting import AppSetting
    svc = ERPSyncService()
    since = svc._since_date()
    old_day = since - timedelta(days=400)        # inside the 5 years, outside the refresh window
    new_day = since + timedelta(days=5)
    erp = {"gate_entry": [
        {"gate_entry_no": "HIST/OLD", "gate_entry_dt": old_day, "item_cd": "HISTPART", "ven_name": "V" * 300}],
        "srv_report": [
        {"grn_no": "HISTGRN-OLD", "grn_date": old_day, "item_cd": "HISTPART", "receipt_qty": "2"},
        {"grn_no": "HISTGRN-NEW", "grn_date": new_day, "item_cd": "HISTPART", "receipt_qty": "3"}]}
    erp["gate_entry"].append({"gate_entry_no": "HIST/NEW", "gate_entry_dt": new_day, "item_cd": "HISTPART"})
    windows = []

    def fetch(table, columns, since_col=None, since_date=None, until_date=None):
        windows.append((table, since_date, until_date))
        col = "gate_entry_dt" if table == "gate_entry" else "grn_date"
        return [dict(r) for r in erp.get(table, [])
                if (since_date is None or r[col] >= since_date) and (until_date is None or r[col] < until_date)]

    monkeypatch.setattr(svc.erp, "fetch_rows", fetch)
    for key in ("erp_history:gate_entry", "erp_history:receiving_register"):
        AppSetting.query.filter_by(key=key).delete()
    db.session.commit()

    years = current_app.config["ERP_HISTORY_YEARS"]
    # First run: the refresh first, then only the oldest history year.
    assert svc.sync_gate_entry() == 1
    assert windows[0] == ("gate_entry", since, None)
    assert windows[1:] == [("gate_entry", since - timedelta(days=365 * years),
                            since - timedelta(days=365 * (years - 1)))]
    for _ in range(years + 2):
        svc.sync_gate_entry()
        svc.sync_receiving_register()
    loads = [w for w in windows if w[0] == "gate_entry" and w[2] is not None]
    assert len(loads) == years and loads[-1][2] == since
    assert all(b - a <= timedelta(days=365) for _, a, b in loads)
    assert {g.gate_entry_no for g in GateEntry.query.filter_by(item_code="HISTPART")} == {"HIST/OLD", "HIST/NEW"}
    old = GateEntry.query.filter_by(gate_entry_no="HIST/OLD").first()
    assert len(old.ven_name) == 150                  # too-long ERP text is cut, not a failed read
    assert {r.grn_no for r in ReceivingRegister.query.filter_by(item_cd="HISTPART")} == {"HISTGRN-OLD", "HISTGRN-NEW"}
    assert AppSetting.get_value("erp_history:gate_entry")["done"] is True

    # Later reads: only the refresh window, the old row stays, no duplicates.
    windows.clear()
    erp["gate_entry"] = [r for r in erp["gate_entry"] if r["gate_entry_no"] != "HIST/OLD"]
    erp["gate_entry"].append({"gate_entry_no": "HIST/NEW2", "gate_entry_dt": new_day, "item_cd": "HISTPART"})
    assert svc.sync_gate_entry() == 2
    assert windows == [("gate_entry", since, None)]
    assert sorted(g.gate_entry_no for g in GateEntry.query.filter_by(item_code="HISTPART")) ==         ["HIST/NEW", "HIST/NEW2", "HIST/OLD"]

    # An empty read (ERP rebuilding) empties nothing.
    erp["gate_entry"] = []
    assert svc.sync_gate_entry() == 0
    assert GateEntry.query.filter_by(item_code="HISTPART").count() == 3


def test_failing_history_year_never_stops_new_entries(monkeypatch):
    """A history year that fails does not stop the refresh (new GRNs / gate
    entries keep coming); it is tried again next run, and skipped after 5 tries
    so the years after it still load."""
    from datetime import timedelta
    from app.extensions import db
    from app.models.app_setting import AppSetting
    svc = ERPSyncService()
    since = svc._since_date()
    AppSetting.query.filter_by(key="erp_history:gate_entry").delete()
    db.session.commit()
    seen, bad = [], {"year": None}
    new_day = since + timedelta(days=3)

    def fetch(table, columns, since_col=None, since_date=None, until_date=None):
        if until_date is None:
            return [{"gate_entry_no": "LIVE/1", "gate_entry_dt": new_day, "item_cd": "HISTFAIL"}]
        seen.append(since_date)
        if bad["year"] is None:
            bad["year"] = since_date
        if since_date == bad["year"]:
            raise ConnectionError("ERP read of an old year fails")
        return []

    monkeypatch.setattr(svc.erp, "fetch_rows", fetch)
    for n in range(1, ERPSyncService.HISTORY_MAX_TRIES):
        assert svc.sync_gate_entry() == 1                 # the refresh still ran
        assert GateEntry.query.filter_by(gate_entry_no="LIVE/1").count() == 1
        st = AppSetting.get_value("erp_history:gate_entry")
        assert st["tries"] == n and not st.get("done") and st["until"] == bad["year"].isoformat()
    svc.sync_gate_entry()                                  # 5th failure: skipped
    st = AppSetting.get_value("erp_history:gate_entry")
    assert st["skipped"] == [f"{bad['year'].isoformat()}..{(bad['year'] + timedelta(days=365)).isoformat()}"]
    assert st["until"] == (bad["year"] + timedelta(days=365)).isoformat()
    for _ in range(6):
        svc.sync_gate_entry()
    st = AppSetting.get_value("erp_history:gate_entry")
    assert st["done"] is True and seen[-1] < since and len(st["skipped"]) == 1
