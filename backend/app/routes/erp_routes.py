"""ERP Stock Synchronization API (/api/v1/erp) — inbound push. ERP is the
master inventory; this is how Part Store's Dashboard/Store Stock/Reports stay
in sync, matching every other ERP touchpoint in this app (gate entry, RQC
clearance, production punch are all ERP-initiated calls too)."""
from flask import Blueprint, request
from marshmallow import Schema, fields, validate
from app.services.erp_stock_sync_service import ERPStockSyncService
from app.utils.validators import validate_payload
from app.utils.response import success_response

bp = Blueprint("erp", __name__, url_prefix="/api/v1/erp")
service = ERPStockSyncService()


class StockSyncLineSchema(Schema):
    part_no = fields.String(required=True)
    qty_on_hand = fields.Decimal(required=True, places=2)


class StockSyncSchema(Schema):
    lines = fields.List(fields.Nested(StockSyncLineSchema), required=True, validate=validate.Length(min=1))


@bp.route("/stock-sync", methods=["POST"])
def stock_sync():
    data = validate_payload(StockSyncSchema(), request.get_json(force=True) or {})
    result = service.sync(data["lines"])
    return success_response(result, f"{result['synced']} part(s) synced from ERP")
