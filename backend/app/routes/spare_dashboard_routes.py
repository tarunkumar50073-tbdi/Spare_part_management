"""Spare Parts Store dashboard aggregate (/api/v1/dashboard/spare).

One call for the whole above-the-fold dashboard — see SpareDashboardService.
"""
from flask import Blueprint, request

from app.services.spare_dashboard_service import SpareDashboardService
from app.utils.authz import permission_required, require_store_access
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response

bp = Blueprint("spare_dashboard", __name__, url_prefix="/api/v1/dashboard/spare")
service = SpareDashboardService()


@bp.route("/overview", methods=["GET"])
@permission_required("spare_store", "view")
def overview():
    code = request.args.get("store_code")
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    return success_response(service.overview(code, section_id=request.args.get("section_id", type=int)))
