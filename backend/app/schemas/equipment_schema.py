"""Validation for the Line / Machine / Die master. Shapes and lengths only — the
kind check, name normalisation and uniqueness live in EquipmentService so the
install form's quick-add and the master screen agree."""
from marshmallow import EXCLUDE, Schema, fields, validate


class EquipmentCreateSchema(Schema):
    class Meta:
        unknown = EXCLUDE

    kind = fields.String(required=True, validate=validate.OneOf(["LINE", "MACHINE", "DIE"]))
    name = fields.String(required=True, validate=validate.Length(min=1, max=80))
    code = fields.String(allow_none=True, validate=validate.Length(max=40))


class EquipmentUpdateSchema(Schema):
    class Meta:
        unknown = EXCLUDE

    kind = fields.String(validate=validate.OneOf(["LINE", "MACHINE", "DIE"]))
    name = fields.String(validate=validate.Length(min=1, max=80))
    code = fields.String(allow_none=True, validate=validate.Length(max=40))
    is_active = fields.Boolean()
