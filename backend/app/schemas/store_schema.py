"""Marshmallow schemas for the Store / Section masters."""
from marshmallow import Schema, fields, validate


class StoreCreateSchema(Schema):
    code = fields.String(required=True, validate=validate.Length(min=1, max=30))
    name = fields.String(required=True, validate=validate.Length(min=1, max=100))
    icon = fields.String(allow_none=True, validate=validate.Length(max=10))
    description = fields.String(allow_none=True, validate=validate.Length(max=255))
    sort_order = fields.Integer(load_default=100, validate=validate.Range(min=0))
    is_active = fields.Boolean(load_default=True)


class StoreUpdateSchema(Schema):
    name = fields.String(validate=validate.Length(min=1, max=100))
    icon = fields.String(allow_none=True, validate=validate.Length(max=10))
    description = fields.String(allow_none=True, validate=validate.Length(max=255))
    sort_order = fields.Integer(validate=validate.Range(min=0))
    is_active = fields.Boolean()


class SectionCreateSchema(Schema):
    name = fields.String(required=True, validate=validate.Length(min=1, max=60))
    sort_order = fields.Integer(load_default=100, validate=validate.Range(min=0))
    is_active = fields.Boolean(load_default=True)


class SectionUpdateSchema(Schema):
    name = fields.String(validate=validate.Length(min=1, max=60))
    sort_order = fields.Integer(validate=validate.Range(min=0))
    is_active = fields.Boolean()
