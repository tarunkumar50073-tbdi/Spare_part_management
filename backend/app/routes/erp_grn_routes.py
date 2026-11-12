"""Spare receiving read from ERP (/api/v1/erp-grn).

Receiving, the GRN and the quality clearance happen in ERP; these endpoints only
show what the app read from the ERP GRN register and what it did with it, and
let an authorised user run the stock-in now, take back a GRN added beyond what
ERP accepts ("Check with ERP"), or move the "post from" date.
"""
from flask import Blueprint, request

from app.routes._spare_common import store_code_arg, username
from app.services.erp_grn_posting_service import ErpGrnPostingService
from app.utils.authz import admin_required, permission_required
from app.utils.event_bus import publish
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response

bp = Blueprint("erp_grn", __name__, url_prefix="/api/v1/erp-grn")
service = ErpGrnPostingService()


@bp.route("/preview", methods=["GET"])
@permission_required(("spare_store", "store_stock", "receiving", "work_queue"), "view")
def preview():
    """Every ERP GRN line of the store's parts and its state: quality pending,
    rejected, already in stock, will be added, or skipped (with the reason)."""
    return success_response(service.preview(store_code_arg()))


@bp.route("/post", methods=["POST"])
@permission_required(("store_stock", "receiving"), "create")
def post_now():
    """Add the accepted, not-yet-added ERP GRN lines to store stock now (the ERP
    sync does the same after every run)."""
    code = store_code_arg()
    result = service.post(code, user=username() or "ERP-GRN")
    if result.get("posted"):
        publish("stock", {"store_code": code, "action": "erp_grn"})
    return success_response(result, f"{len(result.get('posted', []))} GRN line(s) added to store stock")


@bp.route("/take-back", methods=["POST"])
@permission_required(("store_stock", "receiving"), "update")
def take_back():
    """Take back what was added from a GRN beyond what ERP accepts on it now
    (a "Check with ERP" line): {part_id, grn_no}. Added again once quality
    accepts it in ERP."""
    data = request.get_json(force=True) or {}
    try:
        part_id = int(data.get("part_id"))
    except (TypeError, ValueError):
        raise BadRequestError("part_id is required")
    grn_no = str(data.get("grn_no") or "").strip()
    if not grn_no:
        raise BadRequestError("grn_no is required")
    code = store_code_arg()
    result = service.take_back(code, part_id, grn_no, user=username())
    publish("stock", {"store_code": code, "action": "erp_grn"})
    return success_response(result, f"{result['qty']:g} taken back from store stock — GRN {result['grn_no']}")


@bp.route("/settings", methods=["GET"])
@permission_required(("spare_store", "store_stock", "receiving", "work_queue"), "view")
def get_settings():
    return success_response(service.settings())


@bp.route("/settings", methods=["PUT"])
@admin_required
def put_settings():
    return success_response(service.set_settings(request.get_json(force=True) or {}, user=username()),
                            "ERP receiving settings saved")
