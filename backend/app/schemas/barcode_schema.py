"""Validation for the barcode module (resolve, label print, supplier mapping).

`unknown = EXCLUDE` so a shared request body may also carry store_code (read
separately by the route) without tripping validation.
"""
from marshmallow import EXCLUDE, Schema, fields, validate

from app.models.part_barcode import SYMBOLOGIES
from app.models.scan_audit import SCAN_MODES, SCAN_SOURCES


class BarcodeResolveSchema(Schema):
    class Meta:
        unknown = EXCLUDE

    code = fields.String(required=True, validate=validate.Length(min=1, max=80))
    scan_source = fields.String(
        load_default="MANUAL_ENTRY", validate=validate.OneOf(list(SCAN_SOURCES))
    )
    scan_mode = fields.String(
        load_default="LOOKUP", validate=validate.OneOf(list(SCAN_MODES))
    )


class BulkLabelPrintSchema(Schema):
    class Meta:
        unknown = EXCLUDE

    part_ids = fields.List(fields.Integer(validate=validate.Range(min=1)), required=True,
                           validate=validate.Length(min=1, max=300))
    copies = fields.Integer(load_default=1, validate=validate.Range(min=1, max=10))
    reason = fields.String(allow_none=True, validate=validate.Length(max=255))


class LabelPrintSchema(Schema):
    class Meta:
        unknown = EXCLUDE

    part_id = fields.Integer(required=True, validate=validate.Range(min=1))
    copies = fields.Integer(load_default=1, validate=validate.Range(min=1, max=100))
    is_reprint = fields.Boolean(load_default=False)
    reason = fields.String(allow_none=True, validate=validate.Length(max=255))


class SupplierBarcodeMapSchema(Schema):
    class Meta:
        unknown = EXCLUDE

    part_id = fields.Integer(required=True, validate=validate.Range(min=1))
    code = fields.String(required=True, validate=validate.Length(min=1, max=80))
    supplier_id = fields.Integer(allow_none=True)
    symbology = fields.String(
        load_default="CODE128", validate=validate.OneOf(list(SYMBOLOGIES))
    )
