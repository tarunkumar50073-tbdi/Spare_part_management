"""Marshmallow schemas for the Department master."""
from marshmallow import Schema, fields, validate


class DepartmentCreateSchema(Schema):
    name = fields.String(required=True, validate=validate.Length(min=1, max=60))
    # allow_none so an address can be added later; the frontend sends null (not
    # "") to clear a field, because Email would reject an empty string.
    email = fields.Email(allow_none=True)
    notify_reorder = fields.Boolean(load_default=False)
    sort_order = fields.Integer(load_default=100, validate=validate.Range(min=0))
    is_active = fields.Boolean(load_default=True)


class DepartmentUpdateSchema(Schema):
    name = fields.String(validate=validate.Length(min=1, max=60))
    email = fields.Email(allow_none=True)
    notify_reorder = fields.Boolean()
    sort_order = fields.Integer(validate=validate.Range(min=0))
    is_active = fields.Boolean()


class DepartmentRecipientCreateSchema(Schema):
    name = fields.String(required=True, validate=validate.Length(min=1, max=120))
    email = fields.Email(allow_none=True)
    role = fields.String(load_default="TO", validate=validate.OneOf(["TO", "CC", "BCC"]))
    is_active = fields.Boolean(load_default=True)


class DepartmentRecipientUpdateSchema(Schema):
    name = fields.String(validate=validate.Length(min=1, max=120))
    email = fields.Email(allow_none=True)
    role = fields.String(validate=validate.OneOf(["TO", "CC", "BCC"]))
    is_active = fields.Boolean()
