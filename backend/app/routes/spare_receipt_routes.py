"""Spare receiving flow REST API - spec 1 / 9 (receipt -> ERP GRN -> quality -> stock).

Prefix /api/v1/spare-flow. Every write needs scan_part "edit" (the Scan Part
workstation is where receiving happens) and is scoped to the receipt's / part's
own store (audit finding AUTHZ-1). Only the quality clearance changes available
stock; receive, GRN and cancel are document steps.
"""
from flask import Blueprint, request

from app.routes._spare_common import require_doc_store, require_part_store, store_code_arg, username
from app.schemas.spare_receipt_schema import (
    SpareReceiptCancelSchema, SpareReceiptCreateSchema, SpareReceiptGrnSchema, SpareReceiptQualitySchema,
)
from app.services.spare_receipt_service import SPARE_STORE_CODE, SpareReceiptService
from app.utils.authz import permission_required
from app.utils.event_bus import publish
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response
from app.utils.validators import validate_payload

bp = Blueprint("spare_receipts", __name__, url_prefix="/api/v1/spare-flow")
service = SpareReceiptService()

# A receipts list is a work list, not an archive export.
_LIST_MAX = 1000


def _body(schema):
    return validate_payload(schema, request.get_json(force=True, silent=True) or {})


def _receipt(receipt_id):
    """The receipt, 404 if missing, store access enforced on its own store."""
    return require_doc_store(service.get(receipt_id), "Receipt")


def _n(v):
    return f"{float(v):g}"


@bp.route("/receipts", methods=["POST"])
@permission_required("scan_part", "edit")
def receive():
    """Material physically received and checked — held for the ERP GRN. No
    stock moves here."""
    data = _body(SpareReceiptCreateSchema())
    part = require_part_store(data["part_id"])
    if part.store_code != SPARE_STORE_CODE:
        raise BadRequestError(
            f"Part '{part.part_no}' is not a Spare Parts Store part — receive it through its own store")
    result = service.receive(
        part.id, float(data["qty"]), user=username(),
        supplier_id=data.get("supplier_id"), ven_cd=data.get("ven_cd"), ven_name=data.get("ven_name"),
        supplier_source=data.get("supplier_source"), invoice_no=data.get("invoice_no"),
        invoice_date=data.get("invoice_date"), check_result=data.get("check_result"),
        remarks=data.get("remarks"), scanned_code=data.get("scanned_code"),
        scan_source=data.get("scan_source"),
    )
    publish("stock", {"part_id": part.id, "receipt_id": result["id"], "action": "receive"})
    return success_response(
        result, f"Received {_n(result['qty_received'])} · {result['receipt_no']} — record the ERP GRN next", 201)


@bp.route("/receipts/<int:receipt_id>/grn", methods=["POST"])
@permission_required("scan_part", "edit")
def record_grn(receipt_id):
    """The supervisor created the GRN in ERP: record its number here (ERP itself
    is not written) and hand the material to Maintenance / Tool Room."""
    _receipt(receipt_id)
    data = _body(SpareReceiptGrnSchema())
    result = service.record_grn(
        receipt_id, data["grn_no"], grn_date=data.get("grn_date"),
        quality_by=data["quality_by"], remarks=data.get("remarks"), user=username(),
    )
    publish("stock", {"part_id": result["part_id"], "receipt_id": receipt_id, "action": "grn"})
    msg = f"GRN {result['grn_no']} recorded · {result['receipt_no']} is with {result['quality_by']} for quality"
    return success_response(result, msg, 201)


@bp.route("/receipts/<int:receipt_id>/quality", methods=["POST"])
@permission_required("scan_part", "edit")
def quality_clear(receipt_id):
    """Maintenance / Tool Room's verdict. The accepted quantity becomes
    available stock; the rejected quantity never does."""
    _receipt(receipt_id)
    data = _body(SpareReceiptQualitySchema())
    result = service.quality_clear(
        receipt_id, float(data["accepted_qty"]),
        float(data["rejected_qty"]) if data.get("rejected_qty") is not None else 0.0,
        remarks=data.get("remarks"), user=username(),
    )
    publish("stock", {"part_id": result["part_id"], "receipt_id": receipt_id, "action": "quality"})
    accepted, rejected = result["qty_accepted"] or 0, result["qty_rejected"] or 0
    if accepted:
        msg = f"Quality cleared · {_n(accepted)} added to store stock"
        if rejected:
            msg += f", {_n(rejected)} rejected"
    else:
        msg = f"Rejected by quality · {_n(rejected)} not added to stock"
    return success_response(result, msg, 201)


@bp.route("/receipts/<int:receipt_id>/cancel", methods=["POST"])
@permission_required("scan_part", "edit")
def cancel(receipt_id):
    """Take back a receipt recorded by mistake — only before its GRN."""
    _receipt(receipt_id)
    data = _body(SpareReceiptCancelSchema())
    result = service.cancel(receipt_id, data["reason"], user=username())
    publish("stock", {"part_id": result["part_id"], "receipt_id": receipt_id, "action": "cancel_receipt"})
    return success_response(result, f"Receipt {result['receipt_no']} cancelled", 201)


@bp.route("/receipts", methods=["GET"])
def list_receipts():
    """A store's receipts, newest first. ?status= one status, a comma list, or
    OPEN (received + quality pending); ?limit= caps the list."""
    code = store_code_arg()
    limit = request.args.get("limit", type=int)
    limit = min(limit, _LIST_MAX) if limit and limit > 0 else _LIST_MAX
    return success_response(service.list(code, status=request.args.get("status"), limit=limit))
