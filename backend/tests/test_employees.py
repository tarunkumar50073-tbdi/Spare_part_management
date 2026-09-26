"""Employee master: the issue counter finds a person by mobile number (name /
code / department fill in), adds a missing one on the spot, and the master is
editable by users with the right."""
import io

import pytest
from openpyxl import Workbook

from app.extensions import db
from app.models.employee import Employee, normalise_mobile
from app.models.user import User, UserStoreAccess
from app.services.employee_service import EmployeeService
from app.utils.exceptions import BadRequestError, ConflictError

_seq = {"n": 0}


def _mobile():
    _seq["n"] += 1
    return f"98{_seq['n']:08d}"


def _client(app, perms):
    _seq["n"] += 1
    u = User(username=f"empuser{_seq['n']}", role="STORE_USER", is_active=True)
    u.set_password("pw")
    u.set_permissions(perms)
    db.session.add(u)
    db.session.flush()
    db.session.add(UserStoreAccess(user_id=u.id, store_code="MAINTENANCE"))
    db.session.commit()
    c = app.test_client()
    with c.session_transaction() as s:
        s["user_id"] = u.id
    return c


@pytest.mark.parametrize("raw, want", [
    ("9876543210", "9876543210"), ("+91 98765-43210", "9876543210"), ("09876543210", "9876543210"),
    ("919876543210", "9876543210"), ("12345", None), ("5876543210", None), (None, None),
])
def test_mobile_is_normalised(raw, want):
    assert normalise_mobile(raw) == want


def test_lookup_hit_and_miss():
    svc = EmployeeService()
    m = _mobile()
    miss = svc.lookup(m)
    assert miss == {"mobile": m, "found": False, "employee": None}
    svc.create({"mobile": f"+91 {m}", "name": "  Ravi   Kumar ", "employee_code": "e1001",
                "department": "Maintenance"}, user="tester")
    hit = svc.lookup(m)
    assert hit["found"] and hit["active"]
    assert hit["employee"]["name"] == "Ravi Kumar"
    assert hit["employee"]["employee_code"] == "E1001"
    assert hit["employee"]["department"] == "Maintenance"
    with pytest.raises(BadRequestError):
        svc.lookup("123")


def test_duplicates_and_unknown_department_are_refused():
    svc = EmployeeService()
    m = _mobile()
    svc.create({"mobile": m, "name": "A", "employee_code": "DUP-1", "department": "Tool Room"})
    with pytest.raises(ConflictError):
        svc.create({"mobile": m, "name": "B", "department": "Tool Room"})
    with pytest.raises(ConflictError):
        svc.create({"mobile": _mobile(), "name": "C", "employee_code": "dup-1", "department": "Tool Room"})
    with pytest.raises(BadRequestError):
        svc.create({"mobile": _mobile(), "name": "D", "department": "No Such Dept"})
    with pytest.raises(BadRequestError):
        svc.create({"mobile": _mobile(), "name": "E"})          # department required


def test_update_and_deactivate_keep_the_person():
    svc = EmployeeService()
    m = _mobile()
    emp = svc.create({"mobile": m, "name": "Harkesh", "department": "Maintenance"})
    upd = svc.update(emp["id"], {"department": "Press Shop", "designation": "Technician",
                                 "is_active": False}, user="admin")
    assert upd["department"] == "Press Shop" and upd["designation"] == "Technician"
    assert upd["is_active"] is False and upd["updated_by"] == "admin"
    assert svc.lookup(m)["active"] is False
    assert Employee.query.filter_by(mobile=m).count() == 1


def test_excel_import_upserts_by_mobile():
    svc = EmployeeService()
    m_old, m_new = _mobile(), _mobile()
    svc.create({"mobile": m_old, "name": "Old Name", "department": "Store"})
    wb = Workbook()
    ws = wb.active
    ws.append(["Mobile No", "Name", "Employee Code", "Department", "Designation", "Company"])
    ws.append([m_old, "New Name", "IMP-1", "Store", "Helper", None])
    ws.append([f"0{m_new}", "Fresh Person", None, "Maintenance", None, "ABC Contractors"])
    ws.append(["12345", "Bad Mobile", None, "Store", None, None])
    ws.append([_mobile(), "Bad Dept", None, "Nowhere", None, None])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    report = svc.import_file(buf, user="admin")
    assert report["total_rows"] == 4 and report["error_count"] == 2
    assert svc.lookup(m_old)["employee"]["name"] == "New Name"
    assert svc.lookup(m_old)["employee"]["employee_code"] == "IMP-1"
    fresh = svc.lookup(m_new)["employee"]
    assert fresh["name"] == "Fresh Person" and fresh["company"] == "ABC Contractors"


def test_counter_can_add_but_only_the_master_right_edits(app):
    counter = _client(app, {"scan_part": {"view": True, "edit": True}})
    m = _mobile()
    r = counter.get(f"/api/v1/employees/lookup?mobile={m}")
    assert r.status_code == 200 and r.get_json()["data"]["found"] is False
    r = counter.post("/api/v1/employees", json={"mobile": m, "name": "Quick Add", "department": "Maintenance"})
    assert r.status_code == 201
    emp_id = r.get_json()["data"]["id"]
    assert counter.put(f"/api/v1/employees/{emp_id}", json={"name": "X"}).status_code == 403
    assert counter.post("/api/v1/employees/import").status_code == 403

    master = _client(app, {"employees": {"view": True, "edit": True}})
    assert master.put(f"/api/v1/employees/{emp_id}", json={"name": "Quick Add Fixed"}).status_code == 200
    r = master.get("/api/v1/employees?q=Quick")
    assert any(e["name"] == "Quick Add Fixed" for e in r.get_json()["data"])

    nobody = _client(app, {"reports": {"view": True, "edit": False}})
    assert nobody.get(f"/api/v1/employees/lookup?mobile={m}").status_code == 403
