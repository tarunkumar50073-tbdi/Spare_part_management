"""Marshmallow schemas for authentication."""
from marshmallow import Schema, fields, validate


class LoginSchema(Schema):
    username = fields.String(required=True, validate=validate.Length(min=1, max=50))
    # Only a lower bound, and a generous upper one: rejecting a long password
    # would be a hint about what the stored one looks like.
    password = fields.String(required=True, validate=validate.Length(min=1, max=200))
