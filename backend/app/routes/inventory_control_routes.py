"""Inventory Control REST API (/api/v1/inventory-control).

One call for the Critical / Short / Reorder / Excess screen, so its four tabs
are counted from the same stock list — see InventoryControlService."""
from flask import Blueprint, request

from app.services.inventory_control_service import InventoryControlService
from app.utils.authz import permission_required, require_store_access
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response

bp = Blueprint("inventory_control", __name__, url_prefix="/api/v1/inventory-control")
service = InventoryControlService()


@bp.route("", methods=["GET"])
@permission_required("inventory_control", "view")
def overview():
    code = request.args.get("store_code")
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    return success_response(service.overview(code, section_id=request.args.get("section_id", type=int)))
