"""Marshmallow schemas for BOM validation."""
from marshmallow import Schema, fields, validate


class BOMCreateSchema(Schema):
    fg_no = fields.String(required=True, validate=validate.Length(min=1, max=30))
    fg_name = fields.String(validate=validate.Length(max=150))
    part_no = fields.String(required=True, validate=validate.Length(min=1, max=30))
    qty_per_unit = fields.Decimal(required=True, places=4, validate=validate.Range(min=0, min_inclusive=False))


class BOMUpdateSchema(Schema):
    qty_per_unit = fields.Decimal(required=True, places=4, validate=validate.Range(min=0, min_inclusive=False))
