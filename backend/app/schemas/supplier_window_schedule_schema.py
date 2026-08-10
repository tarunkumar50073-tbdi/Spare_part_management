"""Marshmallow schemas for Supplier Window Schedule validation."""
from marshmallow import Schema, fields, validate
from app.models.supplier_window_schedule import FREQUENCIES


class SupplierWindowScheduleCreateSchema(Schema):
    vendor_code = fields.String(required=True, validate=validate.Length(min=1, max=20))
    window_start = fields.Time(required=True)
    window_end = fields.Time(required=True)
    frequency = fields.String(load_default="Daily", validate=validate.OneOf(FREQUENCIES))
    effective_from = fields.Date(required=True)
    status = fields.String(load_default="Active", validate=validate.OneOf(["Active", "Inactive"]))


class SupplierWindowScheduleUpdateSchema(Schema):
    window_start = fields.Time()
    window_end = fields.Time()
    frequency = fields.String(validate=validate.OneOf(FREQUENCIES))
    effective_from = fields.Date()
    status = fields.String(validate=validate.OneOf(["Active", "Inactive"]))
