"""Notifications REST API (/api/v1/spare-alerts).

The Notification Center and the top-bar bell read the same computed alert set —
see SpareAlertsService. Any signed-in user may ask (the bell sits on every
screen), but only about a store they have access to.
"""
from flask import Blueprint, request

from app.services.spare_alerts_service import SpareAlertsService
from app.utils.authz import require_store_access
from app.utils.authz import SPARE_STOCK_VIEW, permission_required
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response

bp = Blueprint("spare_alerts", __name__, url_prefix="/api/v1/spare-alerts")
service = SpareAlertsService()


@bp.route("", methods=["GET"])
@permission_required(SPARE_STOCK_VIEW, "view")
def list_alerts():
    code = request.args.get("store_code")
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    return success_response(service.alerts(code))
