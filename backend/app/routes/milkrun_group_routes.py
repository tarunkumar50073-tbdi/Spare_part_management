"""Milkrun Grouping REST API (/api/v1/milkrun-groups)."""
from flask import Blueprint, request
from app.services.milkrun_group_service import MilkrunGroupService
from app.schemas.milkrun_group_schema import (
    MilkrunGroupCreateSchema, MilkrunGroupUpdateSchema, SupplierMilkrunMappingSchema,
)
from app.utils.validators import validate_payload
from app.utils.response import success_response
from app.utils.authz import admin_required

bp = Blueprint("milkrun_groups", __name__, url_prefix="/api/v1/milkrun-groups")
service = MilkrunGroupService()


@bp.route("", methods=["GET"])
def list_groups():
    return success_response(service.list_all(status=request.args.get("status")))


@bp.route("", methods=["POST"])
@admin_required
def create_group():
    data = validate_payload(MilkrunGroupCreateSchema(), request.get_json(force=True) or {})
    row = service.create(data)
    return success_response(row, "Milkrun group created", 201)


@bp.route("/<int:group_id>", methods=["PUT"])
@admin_required
def update_group(group_id):
    data = validate_payload(MilkrunGroupUpdateSchema(), request.get_json(force=True) or {})
    row = service.update(group_id, data)
    return success_response(row, "Milkrun group updated")


@bp.route("/<int:group_id>", methods=["DELETE"])
@admin_required
def delete_group(group_id):
    service.delete(group_id)
    return success_response(None, "Milkrun group deleted")


@bp.route("/assign-supplier", methods=["POST"])
@admin_required
def assign_supplier():
    data = validate_payload(SupplierMilkrunMappingSchema(), request.get_json(force=True) or {})
    service.assign_supplier(data["vendor_code"], data["milkrun_group_id"])
    return success_response(None, "Supplier assigned to milkrun group")


@bp.route("/unassign-supplier/<string:vendor_code>", methods=["DELETE"])
@admin_required
def unassign_supplier(vendor_code):
    service.unassign_supplier(vendor_code)
    return success_response(None, "Supplier removed from milkrun group")
