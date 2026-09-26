"""Receiving & GRN REST API (/api/v1/receiving-monitor).

One read: ERP GRN lines, the store's own receipts, the SRV pipeline and gate
arrivals with no receipt yet, for a store's parts — see ReceivingMonitorService.
"""
from flask import Blueprint, request

from app.services.receiving_monitor_service import DEFAULT_DAYS, ReceivingMonitorService
from app.utils.authz import permission_required, require_store_access
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response

bp = Blueprint("receiving_monitor", __name__, url_prefix="/api/v1/receiving-monitor")
service = ReceivingMonitorService()


@bp.route("", methods=["GET"])
@permission_required("spare_store", "view")
def monitor():
    code = request.args.get("store_code")
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    raw = request.args.get("days")
    try:
        days = int(raw) if raw not in (None, "") else DEFAULT_DAYS
    except ValueError:
        raise BadRequestError("days must be a whole number") from None
    return success_response(service.monitor(code, days=days))
