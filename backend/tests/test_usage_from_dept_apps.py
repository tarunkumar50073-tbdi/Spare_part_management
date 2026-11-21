"""21 Nov 2026: where an issued part was used, read from the Maintenance / Tool
Room apps (usage_service). The department databases are faked here."""
from datetime import date, datetime

import pytest

from app.extensions import db
from app.models.spare_stock import SpareStockLedger
from app.services import usage_service
from app.services.scan_result_service import ScanResultService
from app.services.spare_report_service import SpareReportService
from app.services.spare_stock_service import SpareStockService
from tests.test_spare_packets import STORE, _part, _seq

_seq["n"] = max(_seq["n"], 70000)


@pytest.fixture()
def dept(monkeypatch):
    data = {"MAINTENANCE": [], "TOOL_ROOM": []}
    monkeypatch.setattr(usage_service, "_read", lambda key, sql, **kw: list(data[key]))
    return data


def _issue(p, qty, dept_name, when):
    out = SpareStockService().issue(p.id, qty, dept_name, issued_to="Ravi", user="sup", remarks="r")
    row = db.session.get(SpareStockLedger, out["issue"]["id"])
    row.created_at = when
    db.session.commit()
    return row


def test_maintenance_uses_go_on_the_oldest_issue_with_room(dept):
    p = _part(qty=10, pkt=1)
    a = _issue(p, 2, "Maintenance", datetime(2026, 11, 18, 9))
    b = _issue(p, 2, "Maintenance", datetime(2026, 11, 20, 9))
    dept["MAINTENANCE"] = [
        {"id": 1, "part_no": p.part_no, "spare_qty": "1", "used_date": date(2026, 11, 19), "created_at": None,
         "zone": "PRESS_SHOP", "line": "PRESS_3", "machine_no": "PP_23", "machine_name": "PRESS", "slip_id": 517, "source": "Log Book"},
        {"id": 2, "part_no": p.part_no, "spare_qty": "2", "used_date": date(2026, 11, 21), "created_at": None,
         "zone": "SS", "line": "YRA_SS", "machine_no": "YRA_SS_06", "machine_name": None, "slip_id": 518, "source": "Log Book"},
        {"id": 3, "part_no": p.part_no, "spare_qty": "5", "used_date": date(2026, 11, 21), "created_at": None,
         "zone": None, "line": "L9", "machine_no": "M9", "machine_name": None, "slip_id": 519, "source": "Log Book"},
    ]
    used, unmatched = usage_service.usage_for_issues([a, b])
    assert used[a.id]["used"] == 2 and used[b.id]["used"] == 2          # 1 + 1 on a, then 1 + ... on b
    assert used[a.id]["exact"] is False
    assert "PRESS_3 / PP_23 (PRESS)" in used[a.id]["where"]
    assert round(sum(u["qty"] for u in unmatched), 2) == 4              # 8 used, 4 had an issue to go on


def test_a_use_before_the_issue_or_by_another_dept_is_not_put_on_it(dept):
    p = _part(qty=10, pkt=1)
    a = _issue(p, 2, "Tool Room", datetime(2026, 11, 18, 9))
    m = _issue(p, 1, "Maintenance", datetime(2026, 11, 20, 9))
    dept["MAINTENANCE"] = [{"id": 1, "part_no": p.part_no, "spare_qty": "1", "used_date": date(2026, 11, 19),
                            "created_at": None, "zone": None, "line": "L1", "machine_no": "M1", "machine_name": None,
                            "slip_id": None, "source": "x"}]
    used, unmatched = usage_service.usage_for_issues([a, m])
    assert not used and len(unmatched) == 1


def test_tool_room_uses_name_their_issue(dept):
    p = _part(qty=10, pkt=1)
    a = _issue(p, 3, "Tool Room", datetime(2026, 11, 18, 9))
    dept["TOOL_ROOM"] = [
        {"id": 1, "issue_no": str(a.id), "qty": "1", "zone": "TR", "line": "L2", "machine_no": "DIE-7",
         "used_by_name": "Aman", "used_by": "aman", "used_at": datetime(2026, 11, 19, 10)},
        {"id": 2, "issue_no": a.issue_no, "qty": "1", "zone": "TR", "line": "L2", "machine_no": "DIE-8",
         "used_by_name": None, "used_by": "aman", "used_at": datetime(2026, 11, 20, 10)},
    ]
    used, unmatched = usage_service.usage_for_issues([a])
    assert used[a.id]["used"] == 2 and used[a.id]["exact"] is True and not unmatched


def test_history_and_issue_register_show_the_use(dept):
    p = _part(qty=10, pkt=1)
    a = _issue(p, 2, "Maintenance", datetime(2026, 11, 18, 9))
    dept["MAINTENANCE"] = [{"id": 1, "part_no": p.part_no, "spare_qty": "1", "used_date": date(2026, 11, 19),
                            "created_at": None, "zone": None, "line": "PRESS_3", "machine_no": "PP_23",
                            "machine_name": None, "slip_id": 517, "source": "Log Book"}]
    rows = [r for r in ScanResultService().timeline(p.id)["rows"] if r["kind"] == "USED"]
    assert len(rows) == 1 and rows[0]["title"] == "Used at PRESS_3 / PP_23 (Maintenance)"
    assert a.issue_no in rows[0]["detail"] and "matched by part + date" in rows[0]["detail"]
    reg = [r for r in SpareReportService().build(STORE, "issue_register", "2026-11-18", "2026-11-18")[2]
           if r["Part No"] == p.part_no]
    assert reg[0]["Used Qty"] == 1 and reg[0]["Used At"] == "~ PRESS_3 / PP_23"


def test_a_department_database_that_cannot_be_read_gives_nothing(monkeypatch):
    p = _part(qty=5, pkt=1)
    a = _issue(p, 1, "Maintenance", datetime(2026, 11, 18, 9))
    used, unmatched = usage_service.usage_for_issues([a])      # scratch SQLite: no department DB at all
    assert used == {} and unmatched == []


def test_issue_and_its_return_carry_the_issue_number_on_the_timeline(dept):
    """21 Nov 2026: the timeline's issue row shows its slip number (and the
    return row the number of the issue it came back against)."""
    from app.services.spare_return_service import SpareReturnService
    p = _part(qty=5, pkt=1)
    a = _issue(p, 2, "Tool Room", datetime(2026, 11, 21, 9))
    SpareReturnService().return_to_store(a.id, qty=1, reason="Wrong Part", user="sup")
    rows = ScanResultService().timeline(p.id)["rows"]
    issue_rows = [r for r in rows if r["kind"] == "ISSUE"]
    back_rows = [r for r in rows if r["kind"] == "RETURN_TO_STORE"]
    assert issue_rows and all(r["issue_no"] == a.issue_no for r in issue_rows)
    assert a.issue_no.startswith("DX/")
    assert back_rows and all(r["issue_no"] == a.issue_no for r in back_rows)
