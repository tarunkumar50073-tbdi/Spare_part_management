"""Employee master — the people spare parts are issued to.

Since 27 Oct 2026 the people come from the Maintenance and Tool Room rosters
(roster_service: source + external_id) and are picked at the counter by code or
name — "mobile number ki jarurat nhi ... meri app me hta de mobile number wala"
(the store). Mobile is kept only if the roster has one; it is optional. The
older text below is how the master began.

At the store counter the operator types only the taker's mobile number; name,
employee code and department come from this master. A number not on it opens a
quick "add person" entry, so the master grows from real issues — and admins /
users with the right keep it correct on the Employee Master screen.

The mobile number is stored normalised (10 digits, no +91 / 0 / spaces) and is
unique, because it is the lookup key. Employee code is optional (contract
workers often have none) but unique when given. People are deactivated, never
deleted: past issues keep pointing at them.
"""
import re

from app.extensions import db
from app.models.base import BaseModel

# An Indian mobile number: 10 digits starting 6-9 once +91 / 0 / separators go.
MOBILE_RE = re.compile(r"^[6-9]\d{9}$")


def normalise_mobile(raw):
    """'+91 98765-43210' / '098765 43210' / '9876543210' -> '9876543210';
    anything that isn't a valid 10-digit mobile -> None."""
    digits = re.sub(r"\D", "", str(raw or ""))
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    return digits if MOBILE_RE.match(digits) else None


class Employee(BaseModel):
    __tablename__ = "employees"

    mobile = db.Column(db.String(10), nullable=True, unique=True, index=True)
    name = db.Column(db.String(80), nullable=False)
    employee_code = db.Column(db.String(30), nullable=True, unique=True, index=True)
    # A name from the Department master (kept as text like the ledger's
    # department, so renaming a department never rewrites old issues).
    department = db.Column(db.String(40), nullable=True, index=True)
    designation = db.Column(db.String(60), nullable=True)
    # Contract / vendor staff: whose company the person works for.
    company = db.Column(db.String(80), nullable=True)
    is_active = db.Column(db.Boolean, nullable=False, default=True)
    # Where the person comes from: MAINTENANCE / TOOL_ROOM (the roster, read
    # only — edited there) with his id in that roster; None = added here.
    source = db.Column(db.String(12), nullable=True, index=True)
    external_id = db.Column(db.String(40), nullable=True)
    created_by = db.Column(db.String(60), nullable=True)
    updated_by = db.Column(db.String(60), nullable=True)

    def to_dict(self):
        return {
            "id": self.id, "mobile": self.mobile, "name": self.name,
            "employee_code": self.employee_code, "department": self.department,
            "designation": self.designation, "company": self.company,
            "is_active": self.is_active, "source": self.source, "created_by": self.created_by,
            "updated_by": self.updated_by,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }

    def __repr__(self):
        return f"<Employee {self.mobile} {self.name}>"
