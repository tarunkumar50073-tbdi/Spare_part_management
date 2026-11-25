"""Current Stock / Pending GRN / Stock Valuation API — read-only ERP report
mirrors (/api/v1/current-stock, /pending-grn, /stock-valuation)."""
from flask import Blueprint, request

from app.services.erp_report_service import ERPReportService
from app.utils.authz import permission_required, scoped_store
from app.utils.response import success_response

bp = Blueprint("erp_reports", __name__, url_prefix="/api/v1")
service = ERPReportService()


def _store():
    return scoped_store(request.args.get("store_code"))


# ERP's stock and its value: only for a login that sees a stock / rate screen
# (25 Nov 2026 audit: open to any login, the TV and kiosk logins included).
_STOCK_VIEW = ("spare_store", "store_stock", "inventory_control", "erp_gap", "erp_control", "reports",
               "part_ledger", "part_master", "receiving", "child_store")


@bp.route("/current-stock", methods=["GET"])
@permission_required(_STOCK_VIEW, "view")
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
@permission_required(_STOCK_VIEW, "view")
def stock_valuation():
    return success_response(service.stock_valuation(
        _store(), request.args.get("item_cd"), request.args.get("limit", type=int)))
