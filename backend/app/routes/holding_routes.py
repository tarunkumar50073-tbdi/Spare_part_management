"""Holding Area REST API (/api/v1/holding)."""
from flask import Blueprint, request
from app.services.holding_service import HoldingService
from app.schemas.holding_schema import TransferSchema
from app.utils.validators import validate_payload
from app.utils.response import success_response
from app.utils.authz import permission_required

bp = Blueprint("holding", __name__, url_prefix="/api/v1/holding")
service = HoldingService()


@bp.route("", methods=["GET"])
def list_holding():
    status = request.args.get("status")
    part_id = request.args.get("part_id", type=int)
    return success_response(service.list_all(status=status, part_id=part_id))


@bp.route("/<int:holding_entry_id>/transfer", methods=["POST"])
@permission_required("child_store", "edit")
def transfer(holding_entry_id):
    data = validate_payload(TransferSchema(), request.get_json(force=True) or {})
    entry = service.transfer_to_rack(
        holding_entry_id, data["rack_bin_id"], float(data["transfer_qty"]), data["scanned_part_code"]
    )
    return success_response(entry, "Transferred to rack" if entry["holding_status"] == "COMPLETED" else "Partial transfer recorded")


@bp.route("/<int:holding_entry_id>/history", methods=["GET"])
def history(holding_entry_id):
    rows = service.get_history(holding_entry_id)
    return success_response([r.to_dict() for r in rows])
