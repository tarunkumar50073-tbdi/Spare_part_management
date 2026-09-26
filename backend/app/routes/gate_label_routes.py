"""QR labels from ERP gate entries (/api/v1/gate-labels).

Scan Part's Receive & Label lists the gate entries that brought the store's
parts and prints all their internal QR labels in one job — see
GateLabelService. Same rights as any other label print: a Scan Part, Store
Stock or Part Master right ("view" to list, "edit" to record a print) and
access to the store.
"""
from flask import Blueprint, request

from app.routes._spare_common import store_code_arg, username
from app.schemas.gate_label_schema import GateLabelPrintSchema
from app.services.gate_label_service import DEFAULT_DAYS, GateLabelService
from app.utils.authz import permission_required, require_store_access
from app.utils.event_bus import publish
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response
from app.utils.validators import validate_payload

bp = Blueprint("gate_labels", __name__, url_prefix="/api/v1/gate-labels")
service = GateLabelService()

# The screens that print labels (as /barcode/print).
PRINT_MODULES = ("scan_part", "store_stock", "part_master")


@bp.route("", methods=["GET"])
@permission_required(PRINT_MODULES, "view")
def gate_entries():
    """The window's gate entries with this store's items (?days=, default 30;
    ?q= gate entry no. / vendor / Part No.), newest first, with the ERP data's
    freshness."""
    code = store_code_arg()
    raw = request.args.get("days")
    try:
        days = int(raw) if raw not in (None, "") else DEFAULT_DAYS
    except ValueError:
        raise BadRequestError("days must be a whole number") from None
    return success_response(service.entries(code, days=days, q=request.args.get("q")))


@bp.route("/print", methods=["POST"])
@permission_required(PRINT_MODULES, "edit")
def print_labels():
    """Record a gate entry's labels once the operator confirmed they printed.
    Adds no stock and completes no GRN or quality; pushed like /barcode/print
    so a screen showing one of the parts refreshes its label status."""
    body = request.get_json(force=True, silent=True) or {}
    code = body.get("store_code") or request.args.get("store_code")
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    data = validate_payload(GateLabelPrintSchema(), body)
    result = service.record_print(
        code, data["gate_entry_no"], data["items"], user=username(),
        printer_name=data.get("printer_name"), reason=data.get("reason"),
    )
    publish("stock", {"part_ids": [p["part_id"] for p in result["printed"]],
                      "gate_entry_no": result["gate_entry_no"], "action": "label_print"})
    return success_response(
        result, f"{result['labels_total']} label(s) recorded for gate entry {result['gate_entry_no']}", 201)
