"""Store Dashboard REST API (/api/v1/store/dashboard)."""
from flask import Blueprint, request
from app.services.store_dashboard_service import StoreDashboardService
from app.services.erp_ledger_import_service import ERPLedgerImportService
from app.services.erp_ledger_inbox_service import ERPLedgerInboxService
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response

bp = Blueprint("store_dashboard", __name__, url_prefix="/api/v1/store/dashboard")
service = StoreDashboardService()
erp_ledger_import_service = ERPLedgerImportService()
erp_ledger_inbox_service = ERPLedgerInboxService()


@bp.route("/summary", methods=["GET"])
def summary():
    return success_response(service.get_summary())


@bp.route("/pending-rgp", methods=["GET"])
def pending_rgp():
    """Pending Returnable Gate Passes — sourced from ERP. Returns null until
    ERP_API_BASE_URL is configured, so the dashboard shows "—" (no data) rather
    than a fabricated count."""
    from app.services.erp_client import ERPClient, ERPNotConfigured
    try:
        count = ERPClient().get_pending_rgp()
    except ERPNotConfigured:
        count = None
    return success_response({"pending_rgp": count})


@bp.route("/part-summary", methods=["GET"])
def part_summary():
    return success_response(service.get_part_wise_summary())


@bp.route("/pipeline", methods=["GET"])
def pipeline():
    return success_response(service.get_flow_pipeline())


@bp.route("/critical-parts", methods=["GET"])
def critical_parts():
    return success_response(service.get_critical_short_parts())


@bp.route("/short-parts", methods=["GET"])
def short_parts():
    return success_response(service.get_short_parts())


@bp.route("/production-critical-parts", methods=["GET"])
def production_critical_parts():
    """Today's Production Critical Parts banner — Coverage < 1 Day OR Out of Stock."""
    return success_response(service.get_critical_parts())


@bp.route("/charts/daily-receiving", methods=["GET"])
def daily_receiving():
    return success_response(service.get_daily_receiving())


@bp.route("/todays-issues", methods=["GET"])
def todays_issues():
    return success_response(service.get_todays_issues())


@bp.route("/todays-receipts", methods=["GET"])
def todays_receipts():
    return success_response(service.get_todays_receipts())


@bp.route("/pending-srv", methods=["GET"])
def pending_srv():
    return success_response(service.get_pending_srv_detail())


@bp.route("/parts/<int:part_id>/consumption-history", methods=["GET"])
def part_consumption_history(part_id):
    return success_response(service.get_part_consumption_history(part_id))


@bp.route("/parts/<int:part_id>/source-breakdown-monthly", methods=["GET"])
def part_source_breakdown_monthly(part_id):
    return success_response(service.get_part_source_breakdown_monthly(part_id))


@bp.route("/erp-ledger/import", methods=["POST"])
def erp_ledger_import():
    """One-time ERP stock-ledger Excel import — backfills BOP (SR) and
    in-house (PP) receipts into the source-breakdown history. De-duped by
    Doc No so a later ERP API push of the same rows won't double-count."""
    file = request.files.get("file")
    if not file or file.filename == "":
        raise BadRequestError("No file uploaded")
    report = erp_ledger_import_service.import_excel(file.stream)
    return success_response(report, f"{report['created']} of {report['total_rows']} receipts imported", 201)


@bp.route("/erp-ledger/inbox-status", methods=["GET"])
def erp_ledger_inbox_status():
    return success_response(erp_ledger_inbox_service.status())


@bp.route("/erp-ledger/scan-now", methods=["POST"])
def erp_ledger_scan_now():
    """Immediately scan the inbox folder and import any dropped ledger files —
    the manual trigger alongside the background poller."""
    results = erp_ledger_inbox_service.scan_once()
    return success_response(
        {"processed": results, "status": erp_ledger_inbox_service.status()},
        f"{len(results)} file(s) processed",
    )


@bp.route("/charts/daily-stock-movement", methods=["GET"])
def daily_stock_movement():
    return success_response(service.get_daily_stock_movement())


@bp.route("/charts/supplier-receiving-trend", methods=["GET"])
def supplier_receiving_trend():
    return success_response(service.get_supplier_receiving_trend())


@bp.route("/charts/rack-utilization", methods=["GET"])
def rack_utilization():
    return success_response(service.get_rack_utilization_chart())


@bp.route("/alerts", methods=["GET"])
def alerts():
    return success_response(service.get_alerts())


@bp.route("/erp-status", methods=["GET"])
def erp_status():
    """Just the last ERP push time, for the top bar's status pill. A single
    MAX() — the analytics bundle below would drag a trend and two breakdowns
    along with it, on every page, on every screen in the plant."""
    return success_response({"last_erp_sync": service.get_last_erp_sync()})


@bp.route("/analytics", methods=["GET"])
def analytics():
    """Bundled data for the Dashboard's donut charts, trend chart and Last
    ERP Sync card — one round trip instead of four."""
    return success_response({
        "trend": service.get_trend(),
        "coverage_distribution": service.get_coverage_distribution(),
        **service.get_category_breakdown(),
        "last_erp_sync": service.get_last_erp_sync(),
    })
