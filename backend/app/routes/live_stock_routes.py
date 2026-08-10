"""Live Stock REST API (/api/v1/live-stock)."""
from flask import Blueprint, request, send_file
from app.services.live_stock_service import LiveStockService
from app.utils.pagination import get_pagination_params
from app.utils.response import success_response, paginated_response

bp = Blueprint("live_stock", __name__, url_prefix="/api/v1/live-stock")
service = LiveStockService()


@bp.route("", methods=["GET"])
def list_live_stock():
    page, per_page = get_pagination_params()
    items, pagination = service.list_all(
        keyword=request.args.get("keyword"),
        category=request.args.get("category"),
        status=request.args.get("status"),
        supplier=request.args.get("supplier"),
        critical=request.args.get("critical") in ("1", "true"),
        page=page, per_page=per_page,
    )
    return paginated_response(items, pagination)


@bp.route("/short", methods=["GET"])
def short_parts():
    return success_response(service.list_short(
        category=request.args.get("category"),
        supplier=request.args.get("supplier"),
    ))


@bp.route("/excess", methods=["GET"])
def excess_parts():
    return success_response(service.list_excess())


@bp.route("/excess/top-oldest", methods=["GET"])
def top_oldest_excess():
    return success_response(service.top_oldest_excess())


@bp.route("/export", methods=["GET"])
def export_live_stock():
    buf = service.export_excel(
        keyword=request.args.get("keyword"),
        category=request.args.get("category"),
        status=request.args.get("status"),
        supplier=request.args.get("supplier"),
        critical=request.args.get("critical") in ("1", "true"),
    )
    return send_file(buf, as_attachment=True, download_name="live_stock_export.xlsx",
                      mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
