"""Inventory Overview REST API (/api/v1/inventory-overview)."""
from flask import Blueprint, request, send_file
from app.services.inventory_overview_service import InventoryOverviewService
from app.utils.pagination import get_pagination_params
from app.utils.response import success_response, paginated_response

bp = Blueprint("inventory_overview", __name__, url_prefix="/api/v1/inventory-overview")
service = InventoryOverviewService()


@bp.route("/categories", methods=["GET"])
def category_summary():
    return success_response(service.get_category_summary())


@bp.route("", methods=["GET"])
def list_detail():
    page, per_page = get_pagination_params()
    items, pagination = service.list_detail(
        keyword=request.args.get("keyword"),
        category=request.args.get("category"),
        sub_category=request.args.get("sub_category"),
        status=request.args.get("status"),
        page=page, per_page=per_page,
    )
    return paginated_response(items, pagination)


@bp.route("/value-by-category", methods=["GET"])
def value_by_category():
    return success_response(service.get_inventory_value_by_category())


@bp.route("/stock-status-summary", methods=["GET"])
def stock_status_summary():
    return success_response(service.get_stock_status_summary())


@bp.route("/top-short-parts", methods=["GET"])
def top_short_parts():
    return success_response(service.get_top_short_parts())


@bp.route("/export", methods=["GET"])
def export_inventory_overview():
    buf = service.export_excel(
        keyword=request.args.get("keyword"),
        category=request.args.get("category"),
        sub_category=request.args.get("sub_category"),
        status=request.args.get("status"),
    )
    return send_file(buf, as_attachment=True, download_name="inventory_overview_export.xlsx",
                      mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
