"""Employee master: find a person by mobile number, keep the master editable.

The issue screen calls lookup() with the typed mobile number; a hit fills name,
code and department, a miss lets the operator add the person on the spot
(create()). Validation lives here so the quick-add at the counter and the
master screen follow the same rules.
"""
from sqlalchemy import func, or_

from app.extensions import db
from app.models.department import Department
from app.models.employee import Employee, normalise_mobile
from app.utils.excel_io import build_export, build_template, bulk_import, to_text
from app.utils.exceptions import BadRequestError, ConflictError, NotFoundError

EDITABLE = ("mobile", "name", "employee_code", "department", "designation", "company", "is_active")

IMPORT_ALIASES = {
    "mobile": ("mobile", "mobileno", "mobilenumber", "phone", "phoneno", "contact", "contactno"),
    "name": ("name", "employeename", "empname", "fullname"),
    "employee_code": ("employeecode", "empcode", "code", "employeeid", "empid", "tokenno"),
    "department": ("department", "dept"),
    "designation": ("designation",),
    "company": ("company", "contractor", "firm"),
}
TEMPLATE_COLUMNS = ["Mobile No", "Name", "Employee Code", "Department", "Designation", "Company"]
EXPORT_COLUMNS = [("Mobile No", "mobile"), ("Name", "name"), ("Employee Code", "employee_code"),
                  ("Department", "department"), ("Designation", "designation"), ("Company", "company"),
                  ("Active", "active")]


class EmployeeService:
    # ---- reading ----

    @staticmethod
    def lookup(mobile):
        """The ACTIVE person with this mobile number, or None. A number that
        isn't a valid mobile is a 400, so the counter says what is wrong."""
        norm = normalise_mobile(mobile)
        if not norm:
            raise BadRequestError("Enter a valid 10-digit mobile number")
        emp = Employee.query.filter_by(mobile=norm).first()
        if emp is None:
            return {"mobile": norm, "found": False, "employee": None}
        return {"mobile": norm, "found": True, "active": emp.is_active, "employee": emp.to_dict()}

    @staticmethod
    def list(q=None, active=None, department=None, limit=None):
        query = Employee.query
        if active is not None:
            query = query.filter(Employee.is_active.is_(bool(active)))
        if department:
            query = query.filter(Employee.department == department)
        if q:
            like = f"%{q.strip()}%"
            digits = normalise_mobile(q) or "".join(ch for ch in q if ch.isdigit())
            conds = [Employee.name.ilike(like), Employee.employee_code.ilike(like)]
            if digits:
                conds.append(Employee.mobile.like(f"%{digits}%"))
            query = query.filter(or_(*conds))
        query = query.order_by(Employee.is_active.desc(), func.lower(Employee.name).asc())
        if limit:
            query = query.limit(limit)
        return [e.to_dict() for e in query.all()]

    @staticmethod
    def mobile_prefix(prefix, limit):
        """Active people whose mobile number starts with the digits of `prefix`,
        by name, at most `limit` — the kiosk's saved-number list (see
        employee_routes). No digits, no one: the start of a number is needed."""
        digits = "".join(ch for ch in str(prefix or "") if ch.isdigit())[:10]
        if not digits:
            return []
        query = (Employee.query
                 .filter(Employee.is_active.is_(True), Employee.mobile.like(f"{digits}%"))
                 .order_by(func.lower(Employee.name).asc())
                 .limit(limit))
        return [e.to_dict() for e in query.all()]

    # ---- validation ----

    @staticmethod
    def _active_departments():
        return {d.name for d in Department.query.filter_by(is_active=True).all()}

    def _clean(self, data, current=None):
        out = {}
        if "mobile" in data or current is None:
            norm = normalise_mobile(data.get("mobile"))
            if not norm:
                raise BadRequestError("Enter a valid 10-digit mobile number")
            clash = Employee.query.filter(Employee.mobile == norm)
            if current is not None:
                clash = clash.filter(Employee.id != current.id)
            other = clash.first()
            if other:
                raise ConflictError(f"Mobile {norm} is already {other.name}'s")
            out["mobile"] = norm
        if "name" in data or current is None:
            name = " ".join(str(data.get("name") or "").split())
            if not name:
                raise BadRequestError("Name is required")
            out["name"] = name[:80]
        if "employee_code" in data:
            code = str(data.get("employee_code") or "").strip().upper() or None
            if code:
                clash = Employee.query.filter(func.upper(Employee.employee_code) == code)
                if current is not None:
                    clash = clash.filter(Employee.id != current.id)
                other = clash.first()
                if other:
                    raise ConflictError(f"Employee code {code} is already {other.name}'s")
            out["employee_code"] = code
        if "department" in data or current is None:
            dept = str(data.get("department") or "").strip() or None
            if current is None and not dept:
                raise BadRequestError("Department is required")
            if dept and dept not in self._active_departments():
                raise BadRequestError(f"Unknown department '{dept}' — pick one from the Department master")
            out["department"] = dept
        for key, size in (("designation", 60), ("company", 80)):
            if key in data:
                val = " ".join(str(data.get(key) or "").split())
                out[key] = val[:size] or None
        if "is_active" in data:
            out["is_active"] = bool(data["is_active"])
        return out

    # ---- writing ----

    def create(self, data, user=None):
        clean = self._clean({k: v for k, v in (data or {}).items() if k in EDITABLE})
        emp = Employee(created_by=user, updated_by=user, **clean)
        db.session.add(emp)
        db.session.commit()
        return emp.to_dict()

    def update(self, emp_id, data, user=None):
        emp = db.session.get(Employee, emp_id)
        if emp is None:
            raise NotFoundError(f"Employee {emp_id} not found")
        clean = self._clean({k: v for k, v in (data or {}).items() if k in EDITABLE}, current=emp)
        for k, v in clean.items():
            setattr(emp, k, v)
        emp.updated_by = user
        db.session.commit()
        return emp.to_dict()

    # ---- Excel ----

    def import_file(self, file_stream, user=None):
        """Upsert by mobile number: a known number updates that person, a new
        one is added. Each row is checked like a form entry; a bad row is
        reported with its reason and the rest still import."""
        depts = self._active_departments()

        def process(raw):
            norm = normalise_mobile(raw.get("mobile"))
            if not norm:
                raise ValueError(f"'{to_text(raw.get('mobile'))}' is not a valid 10-digit mobile number")
            name = " ".join(to_text(raw.get("name")).split())
            if not name:
                raise ValueError("Name is empty")
            dept = to_text(raw.get("department")) or None
            if dept and dept not in depts:
                raise ValueError(f"Unknown department '{dept}'")
            code = to_text(raw.get("employee_code")).upper() or None
            with db.session.no_autoflush:
                emp = Employee.query.filter_by(mobile=norm).first()
                if code:
                    other = Employee.query.filter(func.upper(Employee.employee_code) == code).first()
                    if other is not None and other is not emp:
                        raise ValueError(f"Employee code {code} is already {other.name}'s")
            if emp is None:
                if not dept:
                    raise ValueError("Department is empty")
                emp = Employee(mobile=norm, created_by=user)
                db.session.add(emp)
            emp.name = name[:80]
            if dept:
                emp.department = dept
            if code:
                emp.employee_code = code
            for key, size in (("designation", 60), ("company", 80)):
                val = to_text(raw.get(key))
                if val:
                    setattr(emp, key, val[:size])
            emp.updated_by = user
            db.session.flush()

        return bulk_import(file_stream, IMPORT_ALIASES, ["mobile", "name"], process)

    @staticmethod
    def template():
        return build_template(TEMPLATE_COLUMNS)

    def export(self):
        rows = [dict(e, active="Yes" if e["is_active"] else "No") for e in self.list()]
        return build_export(EXPORT_COLUMNS, rows)
