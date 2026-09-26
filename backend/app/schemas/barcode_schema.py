"""Validation for the barcode module (resolve, label print, supplier mapping).

`unknown = EXCLUDE` so a shared request body may also carry store_code (read
separately by the route) without tripping validation.
"""
from marshmallow import EXCLUDE, Schema, fields, validate

from app.models.label_print_audit import PRINT_SOURCES
from app.models.part_barcode import SYMBOLOGIES
from app.models.scan_audit import SCAN_MODES, SCAN_SOURCES

# The most a resolve request may carry. Deliberately far above any label code
# (a mapped barcode is at most 80 characters) and with no minimum: a blank read
# and an over-long read — a vendor QR carrying lot and quantity too — are both
# scans, which BarcodeService.resolve audits and answers in the one failed-scan
# shape {result, code}. Rejected here they would skip the audit and come back
# as a bare validation error. The cap only bounds the request body; a QR label
# holds a few thousand characters at most.
SCAN_READ_MAX = 4096


class BarcodeResolveSchema(Schema):
    class Meta:
        unknown = EXCLUDE

    code = fields.String(required=True, validate=validate.Length(max=SCAN_READ_MAX))
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
    # The stock list's bulk action; the route treats a missing / null source as
    # STORE_STOCK.
    source = fields.String(allow_none=True, validate=validate.OneOf(list(PRINT_SOURCES)))
    printer_name = fields.String(allow_none=True, validate=validate.Length(max=80))


class LabelPrintSchema(Schema):
    """One confirmed print. `source` is how the part was identified (spec 8) and
    decides the reprint rule; a caller that sends none keeps the old rule
    (printed before = reprint). `printer_name` is the printer the operator chose."""
    class Meta:
        unknown = EXCLUDE

    part_id = fields.Integer(required=True, validate=validate.Range(min=1))
    copies = fields.Integer(load_default=1, validate=validate.Range(min=1, max=100))
    is_reprint = fields.Boolean(load_default=False)
    reason = fields.String(allow_none=True, validate=validate.Length(max=255))
    source = fields.String(allow_none=True, validate=validate.OneOf(list(PRINT_SOURCES)))
    printer_name = fields.String(allow_none=True, validate=validate.Length(max=80))


class SupplierBarcodeMapSchema(Schema):
    class Meta:
        unknown = EXCLUDE

    part_id = fields.Integer(required=True, validate=validate.Range(min=1))
    code = fields.String(required=True, validate=validate.Length(min=1, max=80))
    supplier_id = fields.Integer(allow_none=True)
    symbology = fields.String(
        load_default="CODE128", validate=validate.OneOf(list(SYMBOLOGIES))
    )
