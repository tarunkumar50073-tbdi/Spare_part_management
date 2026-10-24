"""Barcode REST API (/api/v1/barcode).

The single backend surface every scan source (tablet camera, USB/Bluetooth gun,
manual entry) resolves through, plus label print/reprint, the label printer's
status and admin supplier barcode mapping + scan audit. Store-scoped like the
rest of the Spare Parts module; mutations that are ERP/admin territory are
decorated accordingly.
"""
from flask import Blueprint, request, session

from app.repositories.barcode_repository import PartBarcodeRepository
from app.repositories.part_repository import PartRepository
from app.schemas.barcode_schema import (
    BarcodeResolveSchema, BulkLabelPrintSchema, LabelPrintSchema, SupplierBarcodeMapSchema,
)
from app.services.auth_service import AuthService
from app.services.barcode_service import BarcodeService
from app.utils.authz import permission_required, require_store_access, scoped_store
from app.utils.event_bus import publish
from app.utils.exceptions import BadRequestError, NotFoundError
from app.utils.response import success_response
from app.utils.validators import validate_payload

bp = Blueprint("barcode", __name__, url_prefix="/api/v1/barcode")
service = BarcodeService()
auth = AuthService()
part_repo = PartRepository()
barcode_repo = PartBarcodeRepository()

# Labels are printed from Scan Part, the Store Stock list and Part Master; an
# edit right on any one of those screens may print (read-only users may not —
# a print is recorded in the part's history).
PRINT_MODULES = ("scan_part", "store_stock", "part_master")


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


@bp.route("/printer-status", methods=["GET"])
def printer_status():
    """What the print dialog shows for the label printer. Never a guessed
    Online / Offline: NOT_DETECTABLE for the browser print path, and
    REACHABLE / UNREACHABLE only from a live TCP check of a network printer
    an admin configured (see BarcodeService.printer_status)."""
    return success_response(service.printer_status())


@bp.route("/resolve", methods=["POST"])
def resolve():
    """Shared resolve — camera / gun / manual all POST here. A failed scan
    answers 400/404 with errors.result (UNKNOWN_BARCODE, INACTIVE_BARCODE,
    OTHER_STORE, INACTIVE_PART, CODE_TOO_LONG, FAILED) so the screen can tell
    an unmapped supplier barcode from the rest. A blank or over-long read is
    a scan like any other (audited, same shape), so the schema lets it through."""
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
@permission_required(PRINT_MODULES, "edit")
def print_label():
    """Record a confirmed label print. `source` (how the part was identified)
    decides whether a reason is needed — see BarcodeService.record_print.

    A print changes what the part's scan result shows (printed count, the
    printed location and whether it is now stale, Print vs Reprint, the
    timeline), so it is pushed like a stock event: another workstation or part
    drawer showing the part refreshes instead of still offering "Print Label"."""
    data = validate_payload(LabelPrintSchema(), request.get_json(force=True) or {})
    _require_part_store(data["part_id"])
    result = service.record_print(
        data["part_id"], copies=data["copies"], user=_username(),
        is_reprint=data.get("is_reprint", False), reason=data.get("reason"),
        source=data.get("source"), printer_name=data.get("printer_name"),
    )
    publish("stock", {"part_id": result["part_id"], "action": "label_print"})
    return success_response(result, "Label print recorded", 201)


@bp.route("/print-bulk", methods=["POST"])
@permission_required(PRINT_MODULES, "edit")
def print_labels_bulk():
    """Record labels for up to 300 parts in one go (the stock list's bulk
    action, so the source is STORE_STOCK unless the caller says otherwise).
    Every part is store-checked first, so one foreign id refuses the whole
    batch rather than printing part of it."""
    data = validate_payload(BulkLabelPrintSchema(), request.get_json(force=True) or {})
    for pid in data["part_ids"]:
        _require_part_store(pid)
    result = service.record_bulk_print(
        data["part_ids"], copies=data["copies"], user=_username(), reason=data.get("reason"),
        source=data.get("source") or "STORE_STOCK", printer_name=data.get("printer_name"),
    )
    # Pushed only when something was printed — a batch that skipped every
    # part changed nothing any screen shows (see print_label).
    if result["printed"]:
        publish("stock", {"part_ids": [p["part_id"] for p in result["printed"]],
                          "action": "label_print"})
    return success_response(result, f"{len(result['printed'])} label(s) recorded", 201)


@bp.route("/print-history", methods=["GET"])
def print_history():
    """A part's label prints, newest first (at most 200 per request)."""
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
    # The Scan Audit screen is no longer administrators only (Store Supervisor
    # template, 17 Oct 2026), so the store it asks for must be one of the
    # caller's own, like every other store screen.
    code = scoped_store(request.args.get("store_code"))
    return success_response(service.list_scan_audit(
        store_code=code,
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
    # Same rule as every other part id here: the mapping's part must be in a
    # store the caller may act on, so a raw mapping id can't switch off another
    # store's barcode (audit finding AUTHZ-1).
    mapping = barcode_repo.get_by_id(mapping_id)
    if not mapping:
        raise NotFoundError(f"Barcode mapping {mapping_id} not found")
    _require_part_store(mapping.part_id)
    body = request.get_json(force=True) or {}
    active = bool(body.get("active", True))
    return success_response(
        service.set_mapping_active(mapping_id, active, user=_username()),
        "Mapping updated",
    )
