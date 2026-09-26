"""Pending RGP API (/api/v1/rgp).

The store carries the Returnable Gate Pass report (returnable material still
out); the Live Dashboard reads the pending count. ERP will feed the same table
later — the rows and the count stay identical.
"""
from flask import Blueprint, request

from app.schemas.rgp_schema import RGPCreateSchema
from app.services.rgp_service import RGPService
from app.utils.authz import permission_required, require_store_access
from app.utils.response import success_response
from app.utils.validators import validate_payload

bp = Blueprint("rgp", __name__, url_prefix="/api/v1/rgp")
service = RGPService()


@bp.route("", methods=["GET"])
def list_rgp():
    store = request.args.get("store_code")
    if store:
        require_store_access(store)
    pending_only = request.args.get("pending") in ("1", "true")
    return success_response(service.list_rgps(store, pending_only=pending_only))


@bp.route("/pending-count", methods=["GET"])
def pending_count():
    store = request.args.get("store_code")
    if store:
        require_store_access(store)
    return success_response({"pending": service.pending_count(store)})


# A write like any other Child Parts operation: without a module right any
# signed-in user could post rows into the store's Pending RGP report. The spare
# store's own supplier rework lives on /spare-flow (spare_rgp_routes).
@bp.route("", methods=["POST"])
@permission_required("child_store", "edit")
def create_rgp():
    data = validate_payload(RGPCreateSchema(), request.get_json(force=True) or {})
    require_store_access(data.get("store_code") or "CHILD_PART")
    return success_response(service.create_rgp(data), "RGP created", 201)
