"""Barcode REST API (/api/v1/barcode).

The single backend surface every scan source (tablet camera, USB/Bluetooth gun,
manual entry) resolves through, plus label print/reprint and admin supplier
barcode mapping + scan audit. Store-scoped like the rest of the Spare Parts
module; mutations that are ERP/admin territory are decorated accordingly.
"""
from flask import Blueprint, request, session

from app.repositories.part_repository import PartRepository
from app.schemas.barcode_schema import (
    BarcodeResolveSchema, BulkLabelPrintSchema, LabelPrintSchema, SupplierBarcodeMapSchema,
)
from app.services.auth_service import AuthService
from app.services.barcode_service import BarcodeService
from app.utils.authz import permission_required, require_store_access
from app.utils.exceptions import BadRequestError, NotFoundError
from app.utils.response import success_response
from app.utils.validators import validate_payload

bp = Blueprint("barcode", __name__, url_prefix="/api/v1/barcode")
service = BarcodeService()
auth = AuthService()
part_repo = PartRepository()


def _username():
    user = auth.get_user(session.get("user_id"))
    return user.username if user else None


def _require_part_store(part_id):
    """Resolve the part's own store and enforce access on it — a raw part_id
    can't be used to touch another store's part (audit finding AUTHZ-1)."""
    part = part_repo.get_by_id(part_id)
    if not part:
        raise NotFoundError(f"Part {part_id} not found")
    require_store_access(part.store_code)
    return part


@bp.route("/label-config", methods=["GET"])
def label_config():
    """Configurable label template (default 100mm x 50mm) — the frontend reads
    the size here rather than hardcoding it, so a roll change is a config change."""
    return success_response(service.label_config())


@bp.route("/resolve", methods=["POST"])
def resolve():
    """Shared resolve — camera / gun / manual all POST here."""
    body = request.get_json(force=True) or {}
    store_code = body.get("store_code") or request.args.get("store_code")
    if not store_code:
        raise BadRequestError("store_code is required")
    require_store_access(store_code)
    data = validate_payload(BarcodeResolveSchema(), body)
    result = service.resolve(
        store_code, data["code"], scan_source=data["scan_source"],
        scan_mode=data["scan_mode"], user=_username(),
    )
    return success_response(result, "Resolved")


@bp.route("/print", methods=["POST"])
def print_label():
    data = validate_payload(LabelPrintSchema(), request.get_json(force=True) or {})
    _require_part_store(data["part_id"])
    result = service.record_print(
        data["part_id"], copies=data["copies"], user=_username(),
        is_reprint=data.get("is_reprint", False), reason=data.get("reason"),
    )
    return success_response(result, "Label print recorded", 201)


@bp.route("/print-bulk", methods=["POST"])
def print_labels_bulk():
    """Record labels for up to 300 parts in one go (the stock list's bulk
    action). Every part is store-checked first, so one foreign id refuses the
    whole batch rather than printing part of it."""
    data = validate_payload(BulkLabelPrintSchema(), request.get_json(force=True) or {})
    for pid in data["part_ids"]:
        _require_part_store(pid)
    result = service.record_bulk_print(data["part_ids"], copies=data["copies"],
                                       user=_username(), reason=data.get("reason"))
    return success_response(result, f"{len(result['printed'])} label(s) recorded", 201)


@bp.route("/print-history", methods=["GET"])
def print_history():
    part_id = request.args.get("part_id", type=int)
    if not part_id:
        raise BadRequestError("part_id is required")
    _require_part_store(part_id)
    return success_response(service.print_history(
        part_id, limit=request.args.get("limit", default=50, type=int),
    ))


@bp.route("/part/<int:part_id>/barcodes", methods=["GET"])
def part_barcodes(part_id):
    _require_part_store(part_id)
    return success_response(service.list_part_barcodes(part_id))


@bp.route("/scan-audit", methods=["GET"])
@permission_required("scan_audit", "view")
def scan_audit():
    return success_response(service.list_scan_audit(
        store_code=request.args.get("store_code"),
        result=request.args.get("result"),
        scan_mode=request.args.get("scan_mode"),
        scan_source=request.args.get("scan_source"),
        part_id=request.args.get("part_id", type=int),
        limit=request.args.get("limit", default=200, type=int),
    ))


@bp.route("/mapping", methods=["POST"])
@permission_required("supplier_barcodes", "edit")
def create_mapping():
    data = validate_payload(SupplierBarcodeMapSchema(), request.get_json(force=True) or {})
    _require_part_store(data["part_id"])
    result = service.map_supplier_barcode(
        data["part_id"], data["code"], supplier_id=data.get("supplier_id"),
        symbology=data["symbology"], user=_username(),
    )
    return success_response(result, "Supplier barcode mapped", 201)


@bp.route("/mapping/<int:mapping_id>/active", methods=["PUT"])
@permission_required("supplier_barcodes", "edit")
def set_mapping_active(mapping_id):
    body = request.get_json(force=True) or {}
    active = bool(body.get("active", True))
    return success_response(
        service.set_mapping_active(mapping_id, active, user=_username()),
        "Mapping updated",
    )
