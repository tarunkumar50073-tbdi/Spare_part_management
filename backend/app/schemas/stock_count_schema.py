"""Marshmallow schemas for Daily Stock Count validation."""
from marshmallow import Schema, fields, validate


class StockCountEntrySchema(Schema):
    part_id = fields.Integer(required=True, validate=validate.Range(min=1))
    counted_qty = fields.Decimal(required=True, places=2, validate=validate.Range(min=0))


class StockCountSubmitSchema(Schema):
    count_date = fields.Date(required=True)
    entries = fields.List(fields.Nested(StockCountEntrySchema), required=True, validate=validate.Length(min=1))
