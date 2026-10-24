"""Current Stock / Pending GRN / Stock Valuation API — read-only ERP report
mirrors (/api/v1/current-stock, /pending-grn, /stock-valuation)."""
from flask import Blueprint, request

from app.services.erp_report_service import ERPReportService
from app.utils.authz import scoped_store
from app.utils.response import success_response

bp = Blueprint("erp_reports", __name__, url_prefix="/api/v1")
service = ERPReportService()


def _store():
    return scoped_store(request.args.get("store_code"))


@bp.route("/current-stock", methods=["GET"])
def current_stock():
    return success_response(service.current_stock(
        _store(), request.args.get("item_cd"), request.args.get("limit", type=int)))


@bp.route("/pending-grn", methods=["GET"])
def pending_grn():
    return success_response(service.pending_grn(_store(), request.args.get("limit", type=int)))


@bp.route("/pending-grn/count", methods=["GET"])
def pending_grn_count():
    return success_response({"pending": service.pending_grn_count(_store())})


@bp.route("/stock-valuation", methods=["GET"])
def stock_valuation():
    return success_response(service.stock_valuation(
        _store(), request.args.get("item_cd"), request.args.get("limit", type=int)))
