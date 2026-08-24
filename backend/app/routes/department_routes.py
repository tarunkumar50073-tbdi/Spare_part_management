"""Department master API (/api/v1/departments).

The departments the spare store serves and the e-mail each one's reorder /
low-stock notifications go to. Reads are open to any signed-in caller (the
issue screen needs the list); writes are ADMIN-only, like every other master.
"""
from flask import Blueprint, request

from app.schemas.department_schema import (
    DepartmentCreateSchema, DepartmentUpdateSchema,
    DepartmentRecipientCreateSchema, DepartmentRecipientUpdateSchema,
)
from app.services.department_service import DepartmentService
from app.utils.authz import admin_required
from app.utils.response import success_response
from app.utils.validators import validate_payload

bp = Blueprint("departments", __name__, url_prefix="/api/v1/departments")
service = DepartmentService()


@bp.route("", methods=["GET"])
def list_departments():
    active_only = request.args.get("active") in ("1", "true")
    return success_response(service.list_departments(active_only=active_only))


@bp.route("", methods=["POST"])
@admin_required
def create_department():
    data = validate_payload(DepartmentCreateSchema(), request.get_json(force=True) or {})
    return success_response(service.create_department(data), "Department created", 201)


@bp.route("/<int:dept_id>", methods=["PUT"])
@admin_required
def update_department(dept_id):
    data = validate_payload(DepartmentUpdateSchema(), request.get_json(force=True) or {})
    return success_response(service.update_department(dept_id, data), "Department updated")


# ---- person-wise recipients (a department can have several) ----

@bp.route("/<int:dept_id>/recipients", methods=["POST"])
@admin_required
def add_recipient(dept_id):
    data = validate_payload(DepartmentRecipientCreateSchema(), request.get_json(force=True) or {})
    return success_response(service.add_recipient(dept_id, data["name"], data.get("email")),
                            "Recipient added", 201)


@bp.route("/recipients/<int:rec_id>", methods=["PUT"])
@admin_required
def update_recipient(rec_id):
    data = validate_payload(DepartmentRecipientUpdateSchema(), request.get_json(force=True) or {})
    return success_response(service.update_recipient(rec_id, data), "Recipient updated")


@bp.route("/recipients/<int:rec_id>", methods=["DELETE"])
@admin_required
def delete_recipient(rec_id):
    return success_response(service.delete_recipient(rec_id), "Recipient removed")
