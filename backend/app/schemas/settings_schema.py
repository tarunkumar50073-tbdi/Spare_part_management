"""Schemas for admin-editable settings."""
from marshmallow import Schema, fields, validate

# Symbologies the label renderer (JsBarcode) supports for the printed barcode.
LABEL_SYMBOLOGIES = ["CODE128", "CODE39", "EAN13"]


class LabelConfigSchema(Schema):
    """The barcode label template an admin can edit from Settings. All fields
    optional on update — only what is sent is changed, the rest keeps its
    current value (merged over the defaults in BarcodeService)."""
    width_mm = fields.Integer(validate=validate.Range(min=20, max=300))
    height_mm = fields.Integer(validate=validate.Range(min=10, max=300))
    symbology = fields.String(validate=validate.OneOf(LABEL_SYMBOLOGIES))
    show_part_no = fields.Boolean()
    show_description = fields.Boolean()
    description_max_chars = fields.Integer(validate=validate.Range(min=8, max=120))
