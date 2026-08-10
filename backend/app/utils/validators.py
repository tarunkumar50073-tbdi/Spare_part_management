"""Validation wrapper that converts marshmallow errors into our ValidationError."""
from app.utils.exceptions import ValidationError


def validate_payload(schema, data):
    errors = schema.validate(data)
    if errors:
        raise ValidationError("Validation failed", errors=errors)
    return schema.load(data)
