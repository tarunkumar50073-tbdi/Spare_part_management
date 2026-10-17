"""Department master API (/api/v1/departments).

The departments the spare store serves and the e-mail each one's reorder /
low-stock notifications go to. Reads are open to any signed-in caller (the
issue screen needs the list); writes are ADMIN-only, like every other master —
and a signed-in person's, never the machine key's alone: this master decides
who the reorder and excess mails go to and which parts each department is sent.
"""
from flask import Blueprint, request

from app.schemas.department_schema import (
    DepartmentCreateSchema, DepartmentUpdateSchema,
    DepartmentRecipientCreateSchema, DepartmentRecipientUpdateSchema,
)
from app.services.department_service import DepartmentService
from app.services.reorder_mail_service import ReorderMailService
from app.utils.authz import permission_required, signed_in_required
from app.utils.response import success_response
from app.utils.validators import validate_payload

bp = Blueprint("departments", __name__, url_prefix="/api/v1/departments")
service = DepartmentService()


@bp.route("", methods=["GET"])
def list_departments():
    active_only = request.args.get("active") in ("1", "true")
    return success_response(service.list_departments(active_only=active_only))


# A department's tick decides whether it is mailed, and its name which parts it
# is sent (the section or section group of that name, else the whole store) —
# so creating or changing one is a signed-in person's call, like its people.

@bp.route("", methods=["POST"])
@permission_required("departments", "edit")
@signed_in_required
def create_department():
    data = validate_payload(DepartmentCreateSchema(), request.get_json(force=True) or {})
    return success_response(service.create_department(data), "Department created", 201)


@bp.route("/<int:dept_id>", methods=["PUT"])
@permission_required("departments", "edit")
@signed_in_required
def update_department(dept_id):
    data = validate_payload(DepartmentUpdateSchema(), request.get_json(force=True) or {})
    return success_response(service.update_department(dept_id, data), "Department updated")


# ---- person-wise recipients (a department can have several) ----
# Who gets the mail is a signed-in person's call (the same "departments" edit
# right as above): the machine key alone cannot add, change or remove one.

@bp.route("/<int:dept_id>/recipients", methods=["POST"])
@permission_required("departments", "edit")
@signed_in_required
def add_recipient(dept_id):
    data = validate_payload(DepartmentRecipientCreateSchema(), request.get_json(force=True) or {})
    return success_response(service.add_recipient(dept_id, data["name"], data.get("email"), data.get("role")),
                            "Recipient added", 201)


@bp.route("/recipients/<int:rec_id>", methods=["PUT"])
@permission_required("departments", "edit")
@signed_in_required
def update_recipient(rec_id):
    data = validate_payload(DepartmentRecipientUpdateSchema(), request.get_json(force=True) or {})
    return success_response(service.update_recipient(rec_id, data), "Recipient updated")


@bp.route("/recipients/<int:rec_id>", methods=["DELETE"])
@permission_required("departments", "edit")
@signed_in_required
def delete_recipient(rec_id):
    return success_response(service.delete_recipient(rec_id), "Recipient removed")


# ---- reorder / low-stock mail ----
@bp.route("/reorder-mail/status", methods=["GET"])
@permission_required("departments")
def reorder_mail_status():
    """SMTP + schedule state and, per flagged department, how many recipients and
    parts currently need reordering — the screen previews what a send would do."""
    return success_response(ReorderMailService().status())


@bp.route("/reorder-mail/send", methods=["POST"])
@permission_required("departments", "edit")
@signed_in_required
def reorder_mail_send():
    """Send the reorder mail now (force): every flagged department with recipients
    and parts to reorder gets its mail, To / Cc / Bcc by recipient role. Forced
    means past the once-a-day guard, so this is a signed-in person's button —
    with the machine key alone every POST would mail every department again."""
    return success_response(ReorderMailService().send_now(force=True), "Reorder mail processed")
