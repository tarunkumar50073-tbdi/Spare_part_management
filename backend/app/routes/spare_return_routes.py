"""Spare return inspection REST API - spec 13 / 14.

Prefix /api/v1/spare-flow. A return is raised against its original issue on
/spare-stock/issues/<id>/return (spare_stock_routes) and taken straight back
into store stock (store rule, 14 Oct 2026); the inspection here is for a return
recorded before that rule and still waiting. Every id is resolved to its own
store and store access is enforced on it.
"""
from flask import Blueprint, request

from app.routes._spare_common import require_doc_store, store_code_arg, username
from app.schemas.spare_return_schema import SpareInspectSchema
from app.services.spare_return_service import SpareReturnService
from app.utils.authz import permission_required
from app.utils.event_bus import publish
from app.utils.response import success_response
from app.utils.validators import validate_payload

bp = Blueprint("spare_returns", __name__, url_prefix="/api/v1/spare-flow")
service = SpareReturnService()

# What the operator is told after an inspection, by result.
_DONE = {
    "GOOD": "back in store stock",
    "INSPECTION_REQUIRED": "moved to return hold",
    "DAMAGED": "moved to damaged stock",
    "SCRAP": "scrapped",
}


@bp.route("/returns", methods=["GET"])
def list_returns():
    """A store's returns, newest first; ?status=OPEN (or one / several
    statuses, comma-separated) narrows it."""
    return success_response(service.list(
        store_code_arg(), status=request.args.get("status"),
        limit=request.args.get("limit", type=int),
    ))


@bp.route("/returns/<int:return_id>", methods=["GET"])
def get_return(return_id):
    ret = require_doc_store(service.get(return_id), "Return")
    return success_response(service.to_dict(ret))


@bp.route("/returns/<int:return_id>/inspect", methods=["POST"])
@permission_required("scan_part", "edit")
def inspect_return(return_id):
    """Spec 14 store inspection: {result, qty, from_bucket?, remarks?}. Only
    GOOD adds the quantity back to available stock."""
    ret = require_doc_store(service.get(return_id), "Return")
    data = validate_payload(SpareInspectSchema(), request.get_json(force=True, silent=True) or {})
    result = service.inspect(
        ret.id, data["result"], float(data["qty"]),
        from_bucket=data.get("from_bucket"), remarks=data.get("remarks"), user=username(),
    )
    publish("stock", {"part_id": ret.part_id, "return_id": ret.id, "action": "inspect"})
    done = result["inspection"]
    return success_response(
        result, f"{done['qty']:g} {_DONE[done['result']]} · {result['return_no']}", 201)
