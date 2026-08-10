"""Marshmallow schemas for Milkrun grouping validation."""
from marshmallow import Schema, fields, validate


class MilkrunGroupCreateSchema(Schema):
    group_code = fields.String(required=True, validate=validate.Length(min=1, max=20))
    group_name = fields.String(required=True, validate=validate.Length(min=1, max=100))
    window_start = fields.Time(allow_none=True)
    window_end = fields.Time(allow_none=True)
    status = fields.String(load_default="Active", validate=validate.OneOf(["Active", "Inactive"]))


class MilkrunGroupUpdateSchema(Schema):
    group_name = fields.String(validate=validate.Length(min=1, max=100))
    window_start = fields.Time(allow_none=True)
    window_end = fields.Time(allow_none=True)
    status = fields.String(validate=validate.OneOf(["Active", "Inactive"]))


class SupplierMilkrunMappingSchema(Schema):
    vendor_code = fields.String(required=True, validate=validate.Length(min=1, max=20))
    milkrun_group_id = fields.Integer(required=True, validate=validate.Range(min=1))
    status = fields.String(load_default="Active", validate=validate.OneOf(["Active", "Inactive"]))
