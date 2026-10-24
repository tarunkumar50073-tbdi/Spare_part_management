"""Employee master API (/api/v1/employees).

The issue counter looks a person up by mobile number and may add one that is
missing (scan_part edit); keeping the master itself — edits, deactivation,
Excel import — needs the Employee Master right.

The kiosk outside the store used to ask the same two reads with its own
`kiosk` right; the kiosk was taken out on 17 Oct 2026 ("management k according
manual detail fill karke issuance karna time waste h" — the store), so the
reads take Scan Part or Employee Master again, nothing else.
"""
from flask import Blueprint, request, send_file

from app.routes._spare_common import username
from app.schemas.employee_schema import EmployeeCreateSchema, EmployeeUpdateSchema
from app.services.employee_service import EmployeeService
from app.utils.authz import permission_required
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response
from app.utils.validators import validate_payload

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

bp = Blueprint("employees", __name__, url_prefix="/api/v1/employees")
service = EmployeeService()


@bp.route("/lookup", methods=["GET"])
@permission_required(("scan_part", "employees"), "view")
def lookup():
    """{mobile, found, active?, employee} for the typed number."""
    return success_response(service.lookup(request.args.get("mobile")))


@bp.route("", methods=["GET"])
@permission_required(("scan_part", "employees"), "view")
def list_employees():
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
