"""Marshmallow schemas for Supplier validation/serialization."""
from marshmallow import Schema, fields, validate


class SupplierCreateSchema(Schema):
    vendor_code = fields.String(required=True, validate=validate.Length(min=1, max=20))
    supplier_name = fields.String(required=True, validate=validate.Length(min=1, max=150))
    status = fields.String(validate=validate.OneOf(["Active", "Inactive"]), load_default="Active")
    vehicle_tracking_enabled = fields.Boolean(load_default=False)


class SupplierUpdateSchema(Schema):
    supplier_name = fields.String(validate=validate.Length(min=1, max=150))
    status = fields.String(validate=validate.OneOf(["Active", "Inactive"]))
    vehicle_tracking_enabled = fields.Boolean()
