"""Marshmallow schemas for Rack/Bin master validation."""
from marshmallow import Schema, fields, validate


class RackBinCreateSchema(Schema):
    location = fields.String(required=True, validate=validate.Length(min=1, max=20))
    rack_no = fields.String(required=True, validate=validate.Length(min=1, max=20))
    part_no = fields.String(required=True, validate=validate.Length(min=1, max=30))
    bin_capacity = fields.Decimal(required=True, places=2, validate=validate.Range(min=0, min_inclusive=False))
    bins_allocated = fields.Integer(load_default=0, validate=validate.Range(min=0))


class RackBinUpdateSchema(Schema):
    bin_capacity = fields.Decimal(places=2, validate=validate.Range(min=0, min_inclusive=False))
    bins_allocated = fields.Integer(validate=validate.Range(min=0))
    is_blocked = fields.Boolean()
