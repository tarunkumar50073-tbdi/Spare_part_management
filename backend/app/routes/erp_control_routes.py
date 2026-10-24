"""ERP Control Center REST API (/api/v1/erp-control).

One read-only call — see ERPControlService. Store-scoped like every other
spare read; gated on the ERP-gap module right, whose screen this sits beside.
"""
from flask import Blueprint, request

from app.services.erp_control_service import ERPControlService
from app.utils.authz import permission_required, require_store_access
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response

bp = Blueprint("erp_control", __name__, url_prefix="/api/v1/erp-control")
service = ERPControlService()


@bp.route("/status", methods=["GET"])
@permission_required("erp_control", "view")
def status():
    code = request.args.get("store_code")
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    return success_response(service.status(code))
