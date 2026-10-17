"""Employee master API (/api/v1/employees).

The issue counter looks a person up by mobile number and may add one that is
missing (scan_part edit); keeping the master itself — edits, deactivation,
Excel import — needs the Employee Master right.

The kiosk outside the store asks the same two reads (the person look-up and the
saved-number list while typing) with its own `kiosk` right, so the Kiosk device
role template (store, 17 Oct 2026) needs no Employee Master right — which would
also open the master screen and its Excel download. Like the install screen's
pick-lists (equipment_routes). For a login that holds only `kiosk`, the list
answers no more than the kiosk's type-ahead shows: active people whose mobile
number STARTS with the digits typed, at most KIOSK_SUGGEST_LIMIT of them — never
the whole master in one call. The type-ahead itself (the store asked for it on
the kiosk, 14 Oct 2026) still shows the names and numbers that match what is
typed; that is what it is for.
"""
from flask import Blueprint, request, send_file

from app.routes._spare_common import username
from app.schemas.employee_schema import EmployeeCreateSchema, EmployeeUpdateSchema
from app.services.employee_service import EmployeeService
from app.utils.authz import current_user, is_machine, permission_required
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response
from app.utils.validators import validate_payload

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

bp = Blueprint("employees", __name__, url_prefix="/api/v1/employees")
service = EmployeeService()

# The most saved numbers a kiosk-only login gets per call (its list shows 8).
KIOSK_SUGGEST_LIMIT = 20


def _kiosk_only():
    """True for a person whose right to the people reads is the kiosk's alone
    (no Scan Part, no Employee Master)."""
    user = current_user()
    return (not is_machine() and user is not None
            and not user.can("scan_part") and not user.can("employees"))


@bp.route("/lookup", methods=["GET"])
@permission_required(("scan_part", "employees", "kiosk"), "view")
def lookup():
    """{mobile, found, active?, employee} for the typed number."""
    return success_response(service.lookup(request.args.get("mobile")))


@bp.route("", methods=["GET"])
@permission_required(("scan_part", "employees", "kiosk"), "view")
def list_employees():
    if _kiosk_only():
        limit = request.args.get("limit", type=int) or KIOSK_SUGGEST_LIMIT
        return success_response(service.mobile_prefix(
            request.args.get("q"), limit=max(1, min(limit, KIOSK_SUGGEST_LIMIT))))
    active = request.args.get("active")
    return success_response(service.list(
        q=request.args.get("q"),
        active=None if active in (None, "", "all") else active in ("1", "true"),
        department=request.args.get("department") or None,
        limit=request.args.get("limit", type=int),
    ))


@bp.route("", methods=["POST"])
@permission_required(("employees", "scan_part"), "edit")
def create_employee():
    """Also the counter's quick-add for a mobile number not on the master."""
    data = validate_payload(EmployeeCreateSchema(), request.get_json(force=True) or {})
    return success_response(service.create(data, user=username()), "Person added", 201)


@bp.route("/<int:emp_id>", methods=["PUT"])
@permission_required("employees", "edit")
def update_employee(emp_id):
    data = validate_payload(EmployeeUpdateSchema(), request.get_json(force=True) or {})
    return success_response(service.update(emp_id, data, user=username()), "Person updated")


@bp.route("/template", methods=["GET"])
@permission_required("employees", "view")
def template():
    return send_file(service.template(), mimetype=XLSX_MIME, as_attachment=True,
                     download_name="employee_master_template.xlsx")


@bp.route("/export", methods=["GET"])
@permission_required("employees", "view")
def export():
    return send_file(service.export(), mimetype=XLSX_MIME, as_attachment=True,
                     download_name="employee_master.xlsx")


@bp.route("/import", methods=["POST"])
@permission_required("employees", "edit")
def import_employees():
    file = request.files.get("file")
    if not file:
        raise BadRequestError("Choose an Excel / CSV file to import")
    return success_response(service.import_file(file.stream, user=username()), "Employee import finished")
