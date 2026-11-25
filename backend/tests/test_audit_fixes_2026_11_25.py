"""25 Nov 2026 audit fixes."""
import io
from datetime import date, datetime

import pytest
from openpyxl import Workbook

from app.extensions import db
from app.models.spare_stock import SpareStock
from app.services.spare_stock_service import SpareStockService
from tests.test_spare_packets import STORE, _part, _seq

_seq["n"] = max(_seq["n"], 90000)


def _sheet(rows):
    wb = Workbook()
    ws = wb.active
    ws.append(["Part No", "In Stock"])
    for r in rows:
        ws.append(list(r))
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_a_part_on_two_rows_of_a_stock_upload_is_refused_not_overwritten():
    a, b = _part(qty=7, pkt=1), _part(qty=2, pkt=1)
    data = _sheet([(a.part_no, 5), (b.part_no, 9), (a.part_no, 3)])
    out = SpareStockService().bulk_import(io.BytesIO(data), store_code=STORE, user="keeper")
    assert out["error_count"] == 2
    assert all(a.part_no in e["reason"] and "2 rows" in e["reason"] for e in out["errors"])
    stock = {s.part_id: float(s.qty_on_hand) for s in SpareStock.query.filter(SpareStock.part_id.in_([a.id, b.id]))}
    assert stock == {a.id: 7.0, b.id: 9.0}          # a untouched, b loaded


def test_department_reads_are_kept_a_minute_and_a_down_database_is_skipped(monkeypatch):
    """25 Nov 2026: Scan Part no longer reads the department DBs on every scan."""
    from app.services import roster_service, usage_service
    usage_service._cache.clear()
    usage_service._down.clear()
    calls = {"n": 0}

    class Conn:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def exec_driver_sql(self, sql):
            return None

        def execute(self, sql, params):
            calls["n"] += 1
            if calls.get("fail"):
                raise OSError("unreachable")

            class R:
                def mappings(self):
                    return [{"column_name": "x"}]
            return R()

    class Eng:
        def connect(self):
            return Conn()

    monkeypatch.setattr(roster_service, "_url", lambda roster: "postgresql://fake/db")
    monkeypatch.setattr(roster_service, "_engine", lambda url: Eng())
    usage_service._read("MAINTENANCE", usage_service.COLUMNS_SQL)
    usage_service._read("MAINTENANCE", usage_service.COLUMNS_SQL)
    assert calls["n"] == 1                                  # second came from the cache
    calls["fail"] = True
    usage_service._cache.clear()
    assert usage_service._read("TOOL_ROOM", usage_service.COLUMNS_SQL) == []
    assert usage_service._read("TOOL_ROOM", usage_service.COLUMNS_SQL) == []
    assert calls["n"] == 2                                  # the down database was not tried again
    usage_service._cache.clear()
    usage_service._down.clear()


def test_issue_number_unit_follows_the_erp_unit(app, monkeypatch):
    """25 Nov 2026: with no doc_unit_code set, the unit comes from ERP_UNIT_CD."""
    from app.services.spare_journal_service import SpareJournalService
    monkeypatch.setitem(app.config, "ERP_UNIT_CD", "10002")
    assert SpareJournalService.unit_code() == "002"
    monkeypatch.setitem(app.config, "ERP_UNIT_CD", "10001")
    assert SpareJournalService.unit_code() == "001"


def test_a_half_filled_erp_read_does_not_drop_the_missing_parts(monkeypatch):
    from app.models.erp_stock import ERPStock
    from app.models.part import Part
    from app.services.erp_sync_service import ERPSyncService
    from app.models.base import utcnow
    parts = []
    for i in range(60):
        p = Part(part_no=f"HALF-{_seq['n']}-{i}", part_name="H", uom="NOS", part_type="OTHER", store_code=STORE)
        db.session.add(p)
        parts.append(p)
    db.session.commit()
    for p in parts:
        db.session.add(ERPStock(part_id=p.id, qty_on_hand=1, under_insp=0, synced_at=utcnow()))
    db.session.commit()
    svc = ERPSyncService()
    rows = [{"item_cd": parts[0].part_no, "clos_stock": "5", "under_insp": "0", "unit_cd": "10001"}]
    monkeypatch.setattr(svc.erp, "fetch_rows", lambda table, cols, **kw: rows)
    svc.sync_current_stock()
    left = ERPStock.query.filter(ERPStock.part_id.in_([p.id for p in parts])).count()
    assert left == 60          # 1 read, 59 missing: kept, not dropped
