"""Gate Entry / Gate Exit API (/api/v1/gate) — vehicle in/out and material
arrival history. Read-only (ERP-fed)."""
from flask import Blueprint, request

from app.services.gate_service import GateService
from app.utils.authz import require_store_access
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response

bp = Blueprint("gate", __name__, url_prefix="/api/v1/gate")
service = GateService()


@bp.route("/entries", methods=["GET"])
def entries():
    store = request.args.get("store_code")
    if store:
        require_store_access(store)
    return success_response(service.list_entries(
        store, request.args.get("item_code"), request.args.get("limit", type=int)))


@bp.route("/entries/arrivals", methods=["GET"])
def arrivals():
    item = request.args.get("item_code")
    if not item:
        raise BadRequestError("item_code is required")
    store = request.args.get("store_code")
    if store:
        require_store_access(store)
    return success_response(service.item_arrivals(item, store))


@bp.route("/exits", methods=["GET"])
def exits():
    store = request.args.get("store_code")
    if store:
        require_store_access(store)
    return success_response(service.list_exits(
        store, request.args.get("vehicle_number"), request.args.get("limit", type=int)))
