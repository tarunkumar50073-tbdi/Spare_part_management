"""Marshmallow schemas for authentication."""
from marshmallow import Schema, fields, validate


class LoginSchema(Schema):
    username = fields.String(required=True, validate=validate.Length(min=1, max=50))
    # Only a lower bound, and a generous upper one: rejecting a long password
    # would be a hint about what the stored one looks like.
    password = fields.String(required=True, validate=validate.Length(min=1, max=200))
    # The Security Check code (2 letters + 2 numbers); the route says when it is
    # missing, so a sign-in without one gets the same plain message.
    captcha = fields.String(load_default=None, allow_none=True, validate=validate.Length(max=10))
