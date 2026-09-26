"""Validation for printing an ERP gate entry's QR labels (/gate-labels/print).

Shape and length only. The rules — every part one of the store's active items
on that gate entry, a reprint needs a reason, at most MAX_LABELS_PER_PRINT
labels in all — live in GateLabelService, which answers with a 400 and an
operator-readable message. `unknown = EXCLUDE` so the body may also carry
store_code (read separately by the route).
"""
from marshmallow import EXCLUDE, Schema, fields, validate

from app.services.gate_label_service import MAX_COPIES_PER_PART, MAX_LABELS_PER_PRINT


class GateLabelItemSchema(Schema):
    class Meta:
        unknown = EXCLUDE

    part_id = fields.Integer(required=True, validate=validate.Range(min=1))
    copies = fields.Integer(required=True, validate=validate.Range(min=1, max=MAX_COPIES_PER_PART))


class GateLabelPrintSchema(Schema):
    """One confirmed print job for a gate entry: the parts chosen and their
    copies, the printer the operator used, and the reason when any of them was
    labelled for this gate entry before."""
    class Meta:
        unknown = EXCLUDE

    gate_entry_no = fields.String(required=True, validate=validate.Length(min=1, max=60))
    items = fields.List(fields.Nested(GateLabelItemSchema), required=True,
                        validate=validate.Length(min=1, max=MAX_LABELS_PER_PRINT))
    printer_name = fields.String(allow_none=True, validate=validate.Length(max=80))
    reason = fields.String(allow_none=True, validate=validate.Length(max=255))
