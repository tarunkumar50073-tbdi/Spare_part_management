"""Marshmallow schemas for the Report Recipient master."""
from marshmallow import Schema, fields, validate


class ReportRecipientCreateSchema(Schema):
    report_key = fields.String(load_default="window_time", validate=validate.Length(min=1, max=40))
    name = fields.String(required=True, validate=validate.Length(min=1, max=120))
    # allow_none so the address can be added later; the frontend sends null (not
    # "") to clear it, because Email would reject an empty string.
    email = fields.Email(allow_none=True)
    role = fields.String(load_default="TO", validate=validate.OneOf(["TO", "CC"]))
    sort_order = fields.Integer(load_default=100, validate=validate.Range(min=0))
    is_active = fields.Boolean(load_default=True)


class ReportRecipientUpdateSchema(Schema):
    name = fields.String(validate=validate.Length(min=1, max=120))
    email = fields.Email(allow_none=True)
    role = fields.String(validate=validate.OneOf(["TO", "CC"]))
    sort_order = fields.Integer(validate=validate.Range(min=0))
    is_active = fields.Boolean()
