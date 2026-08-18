"""Standard Supplier Window Schedule REST API (/api/v1/supplier-window-schedules)."""
from datetime import date

from flask import Blueprint, request, send_file
from app.services.supplier_window_schedule_service import SupplierWindowScheduleService
from app.schemas.supplier_window_schedule_schema import (
    SupplierWindowScheduleCreateSchema, SupplierWindowScheduleUpdateSchema,
)
from app.utils.validators import validate_payload
from app.utils.response import success_response
from app.utils.authz import admin_required

bp = Blueprint("supplier_window_schedules", __name__, url_prefix="/api/v1/supplier-window-schedules")
service = SupplierWindowScheduleService()


@bp.route("", methods=["GET"])
def list_schedules():
    return success_response(service.list_all(
        vendor_code=request.args.get("vendor_code"),
        status=request.args.get("status"),
    ))


@bp.route("/today-status", methods=["GET"])
def today_status():
    """Fully API-driven — the standard schedule (real, entered once)
    matched against today's actual ERP gate-entry arrivals, zero manual
    per-day/per-vehicle entry required."""
    return success_response(service.get_today_status())


@bp.route("/performance", methods=["GET"])
def performance():
    """Per-supplier window performance for a month (defaults to the current
    month) — how many times each supplier was On-Time / Late / Not-Arrived."""
    y = request.args.get("year", type=int) or date.today().year
    m = request.args.get("month", type=int) or date.today().month
    return success_response(service.supplier_month_performance(y, m))


@bp.route("/performance/export", methods=["GET"])
def performance_export():
    """The month performance report as a download — format 'xlsx' or 'pdf'."""
    y = request.args.get("year", type=int) or date.today().year
    m = request.args.get("month", type=int) or date.today().month
    fmt = (request.args.get("format") or "xlsx").lower()
    buf, mime, ext = service.month_performance_export(y, m, fmt)
    return send_file(buf, mimetype=mime, as_attachment=True,
                     download_name=f"supplier_performance_{y}_{m:02d}.{ext}")


@bp.route("", methods=["POST"])
@admin_required
def create_schedule():
    data = validate_payload(SupplierWindowScheduleCreateSchema(), request.get_json(force=True) or {})
    row = service.create(data)
    return success_response(row, "Window schedule created", 201)


@bp.route("/<int:schedule_id>", methods=["PUT"])
@admin_required
def update_schedule(schedule_id):
    data = validate_payload(SupplierWindowScheduleUpdateSchema(), request.get_json(force=True) or {})
    row = service.update(schedule_id, data)
    return success_response(row, "Window schedule updated")


@bp.route("/<int:schedule_id>", methods=["DELETE"])
@admin_required
def delete_schedule(schedule_id):
    service.delete(schedule_id)
    return success_response(None, "Window schedule deleted")
