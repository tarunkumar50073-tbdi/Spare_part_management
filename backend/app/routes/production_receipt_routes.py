"""In-house Production Receipt API (/api/v1/production-receipts) — inbound
push from ERP's own Production Punch, the "MAKE" counterpart to a
purchased SRV. Matches every other ERP touchpoint in this app (gate entry,
RQC clearance, stock sync are all ERP-initiated calls too)."""
from flask import Blueprint, request
from marshmallow import Schema, fields
from app.services.production_receipt_service import ProductionReceiptService
from app.utils.validators import validate_payload
from app.utils.response import success_response

bp = Blueprint("production_receipts", __name__, url_prefix="/api/v1/production-receipts")
service = ProductionReceiptService()


class ProductionReceiptSchema(Schema):
    part_no = fields.String(required=True)
    qty_produced = fields.Decimal(required=True, places=2)
    production_order_no = fields.String(required=False, allow_none=True)


@bp.route("", methods=["GET"])
def list_receipts():
    return success_response(service.list_all(part_id=request.args.get("part_id", type=int)))


@bp.route("", methods=["POST"])
def create_receipt():
    data = validate_payload(ProductionReceiptSchema(), request.get_json(force=True) or {})
    receipt = service.create(
        data["part_no"], data["qty_produced"], production_order_no=data.get("production_order_no"),
    )
    return success_response(receipt, "Production receipt recorded", 201)
