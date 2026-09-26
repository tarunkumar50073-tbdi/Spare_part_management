"""Validation for the spare receiving flow (spec 1 / 9): receive -> record the
ERP GRN -> quality clearance, plus cancelling a receipt before its GRN.

Shape and length only. The business rules — a vendor code must come from ERP,
quality_by must be Maintenance or Tool Room (and active in the department
master), accepted + rejected must equal the received quantity, which status
each step may start from — live in SpareReceiptService, so a direct service
call is held to them too and the operator gets one clear 400 message.
"""
from marshmallow import EXCLUDE, Schema, fields, pre_load, validate

from app.models.spare_flow import SUPPLIER_SOURCES
from app.models.spare_stock import CHECK_RESULTS


class _Form(Schema):
    """A form posts an untouched optional field as "" — read that as "not
    given" (None), so an empty invoice date or check result is not a 422."""
    class Meta:
        unknown = EXCLUDE

    @pre_load
    def _blank_is_none(self, data, **kwargs):
        if not isinstance(data, dict):
            return data
        return {k: (None if isinstance(v, str) and not v.strip() else v) for k, v in data.items()}


class SpareReceiptCreateSchema(_Form):
    """Material physically received: Part No + quantity + (optional) supplier,
    invoice and the physical check. No stock moves on receive."""
    part_id = fields.Integer(required=True)
    qty = fields.Decimal(required=True, places=2, validate=validate.Range(min=0, min_inclusive=False))
    supplier_id = fields.Integer(allow_none=True)
    # Picked from the part's ERP vendors (supplier-options), never typed free.
    ven_cd = fields.String(allow_none=True, validate=validate.Length(max=30))
    ven_name = fields.String(allow_none=True, validate=validate.Length(max=160))
    supplier_source = fields.String(allow_none=True, validate=validate.OneOf(SUPPLIER_SOURCES))
    invoice_no = fields.String(allow_none=True, validate=validate.Length(max=60))
    invoice_date = fields.Date(allow_none=True)
    check_result = fields.String(allow_none=True, validate=validate.OneOf(CHECK_RESULTS))
    remarks = fields.String(allow_none=True, validate=validate.Length(max=255))
    # How the part was identified (scanned supplier barcode / QR, search, manual).
    scanned_code = fields.String(allow_none=True, validate=validate.Length(max=80))
    scan_source = fields.String(allow_none=True, validate=validate.Length(max=20))


class SpareReceiptGrnSchema(_Form):
    """The GRN the supervisor created in ERP, and who inspects the material."""
    grn_no = fields.String(required=True, validate=validate.Length(min=1, max=40))
    grn_date = fields.Date(allow_none=True)
    quality_by = fields.String(required=True, validate=validate.Length(min=1, max=40))
    remarks = fields.String(allow_none=True, validate=validate.Length(max=255))


class SpareReceiptQualitySchema(_Form):
    """Maintenance / Tool Room's verdict. accepted + rejected must equal the
    received quantity (checked in the service against the receipt)."""
    accepted_qty = fields.Decimal(required=True, places=2, validate=validate.Range(min=0))
    rejected_qty = fields.Decimal(load_default=0, allow_none=True, places=2, validate=validate.Range(min=0))
    remarks = fields.String(allow_none=True, validate=validate.Length(max=255))


class SpareReceiptCancelSchema(_Form):
    """Taking back a receipt recorded by mistake (only before its GRN)."""
    reason = fields.String(required=True, validate=validate.Length(min=1, max=255))
