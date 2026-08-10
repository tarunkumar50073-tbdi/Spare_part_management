"""Marshmallow schemas for Supplier Vehicle Window validation."""
from marshmallow import Schema, fields, validate


class SupplierVehicleWindowCreateSchema(Schema):
    vendor_code = fields.String(required=True, validate=validate.Length(min=1, max=20))
    # Optional: an ad-hoc vehicle may have no known number or date yet — the
    # service fills a placeholder ("—") / today so it can still be logged.
    vehicle_no = fields.String(required=False, allow_none=True, load_default=None, validate=validate.Length(max=20))
    expected_date = fields.Date(required=False, allow_none=True, load_default=None)
    # Optional: left blank for an ad-hoc vehicle with no decided window.
    window_start = fields.DateTime(allow_none=True, load_default=None)
    window_end = fields.DateTime(allow_none=True, load_default=None)
    notes = fields.String(allow_none=True, validate=validate.Length(max=200))


class SupplierVehicleWindowUpdateSchema(Schema):
    vehicle_no = fields.String(allow_none=True, validate=validate.Length(max=20))
    expected_date = fields.Date(allow_none=True)
    window_start = fields.DateTime(allow_none=True)
    window_end = fields.DateTime(allow_none=True)
    notes = fields.String(allow_none=True, validate=validate.Length(max=200))
