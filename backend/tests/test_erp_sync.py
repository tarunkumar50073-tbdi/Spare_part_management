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

    def fake_fetch(table, columns, since_col=None, since_date=None):
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
    assert result == {"gate_entry": 1, "receiving_register": 1}

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
    assert svc.sync_all() == {"gate_entry": 1, "receiving_register": 1}
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
