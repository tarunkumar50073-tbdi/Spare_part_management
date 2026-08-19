"""Receiving Register API (/api/v1/receiving-register) — a part's GRN receiving
history. Read-only (ERP-fed); the store looks up how/when a part was received.
"""
from flask import Blueprint, request

from app.services.receiving_register_service import ReceivingRegisterService
from app.utils.authz import require_store_access
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response

bp = Blueprint("receiving_register", __name__, url_prefix="/api/v1/receiving-register")
service = ReceivingRegisterService()


@bp.route("", methods=["GET"])
def list_rows():
    store = request.args.get("store_code")
    if store:
        require_store_access(store)
    return success_response(service.list_rows(
        store_code=store, item_cd=request.args.get("item_cd"),
        limit=request.args.get("limit", type=int),
    ))


@bp.route("/history", methods=["GET"])
def item_history():
    item_cd = request.args.get("item_cd")
    if not item_cd:
        raise BadRequestError("item_cd is required")
    store = request.args.get("store_code")
    if store:
        require_store_access(store)
    return success_response(service.item_history(item_cd, store_code=store))
