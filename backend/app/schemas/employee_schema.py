"""Validation for the Employee master. Shapes and lengths only — the mobile
number normalisation, uniqueness and the department check live in
EmployeeService so the counter's quick-add and the master screen agree."""
from marshmallow import EXCLUDE, Schema, fields, validate


class EmployeeCreateSchema(Schema):
    class Meta:
        unknown = EXCLUDE

    mobile = fields.String(required=True, validate=validate.Length(min=10, max=20))
    name = fields.String(required=True, validate=validate.Length(min=1, max=80))
    employee_code = fields.String(allow_none=True, validate=validate.Length(max=30))
    department = fields.String(required=True, validate=validate.Length(min=1, max=40))
    designation = fields.String(allow_none=True, validate=validate.Length(max=60))
    company = fields.String(allow_none=True, validate=validate.Length(max=80))


class EmployeeUpdateSchema(Schema):
    class Meta:
        unknown = EXCLUDE

    mobile = fields.String(validate=validate.Length(min=10, max=20))
    name = fields.String(validate=validate.Length(min=1, max=80))
    employee_code = fields.String(allow_none=True, validate=validate.Length(max=30))
    department = fields.String(validate=validate.Length(min=1, max=40))
    designation = fields.String(allow_none=True, validate=validate.Length(max=60))
    company = fields.String(allow_none=True, validate=validate.Length(max=80))
    is_active = fields.Boolean()
