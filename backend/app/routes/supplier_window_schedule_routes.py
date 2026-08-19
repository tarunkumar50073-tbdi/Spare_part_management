"""Standard Supplier Window Schedule REST API (/api/v1/supplier-window-schedules)."""
from datetime import date

from flask import Blueprint, request, send_file
from app.services.supplier_window_schedule_service import SupplierWindowScheduleService
from app.services.window_time_mail_service import WindowTimeMailService
from app.schemas.supplier_window_schedule_schema import (
    SupplierWindowScheduleCreateSchema, SupplierWindowScheduleUpdateSchema,
)
from app.utils.validators import validate_payload
from app.utils.response import success_response
from app.utils.authz import admin_required

bp = Blueprint("supplier_window_schedules", __name__, url_prefix="/api/v1/supplier-window-schedules")
service = SupplierWindowScheduleService()
mail_service = WindowTimeMailService()


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


@bp.route("/day-status", methods=["GET"])
def day_status():
    """Window-vs-arrival status for a specific date (defaults to today) — who
    came late / not-arrived that day."""
    ds = request.args.get("date")
    d = date.fromisoformat(ds) if ds else date.today()
    return success_response(service.get_status_for_date(d))


@bp.route("/window-time-board", methods=["GET"])
def window_time_board():
    """The Window-Time control tower payload (KPIs + live alerts + severity
    summary) for one day. Defaults to the latest day the ERP has data for; pass
    ?date=YYYY-MM-DD for any other."""
    ds = request.args.get("date")
    d = date.fromisoformat(ds) if ds else None
    return success_response(service.window_time_board(d))


@bp.route("/month-daily", methods=["GET"])
def month_daily():
    """Per-day window totals for a month — the by-date late view."""
    y = request.args.get("year", type=int) or date.today().year
    m = request.args.get("month", type=int) or date.today().month
    return success_response(service.month_daily_summary(y, m))


@bp.route("/late-report", methods=["GET"])
def late_report():
    """Every LATE arrival in a month (only late), date-wise + per-supplier
    summary. Defaults to the current month."""
    y = request.args.get("year", type=int) or date.today().year
    m = request.args.get("month", type=int) or date.today().month
    return success_response(service.month_late_report(y, m))


@bp.route("/late-report/export", methods=["GET"])
def late_report_export():
    """The monthly late report as a download — format 'xlsx' or 'pdf'."""
    y = request.args.get("year", type=int) or date.today().year
    m = request.args.get("month", type=int) or date.today().month
    fmt = (request.args.get("format") or "xlsx").lower()
    buf, mime, ext = service.month_late_export(y, m, fmt)
    return send_file(buf, mimetype=mime, as_attachment=True,
                     download_name=f"late_report_{y}_{m:02d}.{ext}")


@bp.route("/performance/export", methods=["GET"])
def performance_export():
    """The month performance report as a download — format 'xlsx' or 'pdf'."""
    y = request.args.get("year", type=int) or date.today().year
    m = request.args.get("month", type=int) or date.today().month
    fmt = (request.args.get("format") or "xlsx").lower()
    buf, mime, ext = service.month_performance_export(y, m, fmt)
    return send_file(buf, mimetype=mime, as_attachment=True,
                     download_name=f"supplier_performance_{y}_{m:02d}.{ext}")


@bp.route("/window-time-report", methods=["GET"])
def window_time_report():
    """The plant's 'VEHICLE WINDOW TIME' sheet (the format the store mails),
    auto-filled for a whole month and colour-coded (green On-Time / amber Late /
    red Not Come). Defaults to the current month; ?year=&month= for any other."""
    y = request.args.get("year", type=int) or date.today().year
    m = request.args.get("month", type=int) or date.today().month
    buf, mime, ext = service.window_time_workbook(y, m)
    return send_file(buf, mimetype=mime, as_attachment=True,
                     download_name=f"window_time_{y}_{m:02d}.{ext}")


@bp.route("/email-report", methods=["POST"])
@admin_required
def email_report():
    """E-mail this month's window-time sheet to the report recipients now.
    Returns {status:'sent'|'skipped', reason, to, cc, report_date}. admin_required
    also lets the machine (X-API-Key) caller through, so a Windows Task Scheduler
    job can POST here on a fixed schedule. The button sends {"force": true} to
    override the once-per-day guard; an unattended trigger POSTs without it."""
    force = bool((request.get_json(silent=True) or {}).get("force", False))
    return success_response(mail_service.send_current_month(force=force), "Window-time report email processed")


@bp.route("/email-status", methods=["GET"])
@admin_required
def email_status():
    """SMTP configured? enabled? who To/Cc? last send? — drives the Email-now UI."""
    return success_response(mail_service.status())


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
