"""ERP Stock Synchronization API (/api/v1/erp) — inbound push. ERP is the
master inventory; this is how Part Store's Dashboard/Store Stock/Reports stay
in sync, matching every other ERP touchpoint in this app (gate entry, RQC
clearance, production punch are all ERP-initiated calls too)."""
from flask import Blueprint, request
from marshmallow import Schema, fields, validate
from app.services.erp_stock_sync_service import ERPStockSyncService
from app.services.erp_sync_service import ERPSyncService
from app.services.erp_db_client import ERPDBNotConfigured
from app.utils.validators import validate_payload
from app.utils.response import success_response
from app.utils.authz import machine_required, admin_required

bp = Blueprint("erp", __name__, url_prefix="/api/v1/erp")
service = ERPStockSyncService()
sync_service = ERPSyncService()


class StockSyncLineSchema(Schema):
    part_no = fields.String(required=True)
    qty_on_hand = fields.Decimal(required=True, places=2)


class StockSyncSchema(Schema):
    lines = fields.List(fields.Nested(StockSyncLineSchema), required=True, validate=validate.Length(min=1))


@bp.route("/stock-sync", methods=["POST"])
@machine_required
def stock_sync():
    data = validate_payload(StockSyncSchema(), request.get_json(force=True) or {})
    result = service.sync(data["lines"])
    return success_response(result, f"{result['synced']} part(s) synced from ERP")


@bp.route("/sync", methods=["POST"])
@admin_required
def erp_db_sync():
    """Pull the ERP report tables (read-only) into the local mirrors now —
    Gate Entry + Receiving Register today. Returns per-table row counts, or a
    clear 'not configured' message when ERP DB credentials are unset."""
    try:
        result = sync_service.sync_all()
    except ERPDBNotConfigured:
        return success_response({"configured": False}, "ERP DB is not configured — set ERP_DB_* to enable the sync")
    if "skipped" in result:
        return success_response({"configured": True, "synced": result}, result["skipped"])
    total = sum(v for v in result.values() if isinstance(v, (int, float)))
    return success_response({"configured": True, "synced": result}, f"{total} row(s) synced from ERP")


@bp.route("/sync/status", methods=["GET"])
@admin_required
def erp_db_sync_status():
    """Last ERP-sync result, poll interval, and whether ERP DB is configured."""
    return success_response(sync_service.status())


@bp.route("/sync/ping", methods=["GET"])
@admin_required
def erp_db_ping():
    """Liveness check for the ERP DB connection (read-only)."""
    from app.services.erp_db_client import ERPDBClient
    try:
        return success_response(ERPDBClient().ping())
    except ERPDBNotConfigured:
        return success_response({"ok": False, "configured": False}, "ERP DB is not configured")
    except Exception as exc:  # noqa: BLE001 — surface a connection failure as data, not a 500
        return success_response({"ok": False, "error": type(exc).__name__})
