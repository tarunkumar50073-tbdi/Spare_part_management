"""Supplier Vehicle Management REST API (/api/v1/supplier-vehicles)."""
from datetime import date
from flask import Blueprint, request
from app.services.supplier_vehicle_service import SupplierVehicleService
from app.schemas.supplier_vehicle_window_schema import SupplierVehicleWindowCreateSchema, SupplierVehicleWindowUpdateSchema
from app.utils.validators import validate_payload
from app.utils.response import success_response

bp = Blueprint("supplier_vehicles", __name__, url_prefix="/api/v1/supplier-vehicles")
service = SupplierVehicleService()


@bp.route("", methods=["GET"])
def list_windows():
    expected_date = request.args.get("expected_date")
    return success_response(service.list_all(
        vendor_code=request.args.get("vendor_code"),
        expected_date=date.fromisoformat(expected_date) if expected_date else None,
    ))


@bp.route("", methods=["POST"])
def create_window():
    data = validate_payload(SupplierVehicleWindowCreateSchema(), request.get_json(force=True) or {})
    row = service.create(data)
    return success_response(row, "Vehicle window created", 201)


@bp.route("/<int:window_id>", methods=["PUT"])
def update_window(window_id):
    data = validate_payload(SupplierVehicleWindowUpdateSchema(), request.get_json(force=True) or {})
    row = service.update(window_id, data)
    return success_response(row, "Vehicle window updated")


@bp.route("/<int:window_id>", methods=["DELETE"])
def delete_window(window_id):
    service.delete(window_id)
    return success_response(None, "Vehicle window deleted")
