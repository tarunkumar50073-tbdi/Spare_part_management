"""Validation for kiosk part-requests and their supervisor issuance.

Quantities are bounded above zero; the service re-checks the scanned location
against the part's assigned location and caps the issued quantity against the
remaining request and the live on-hand stock.
"""
from marshmallow import EXCLUDE, Schema, fields, validate


class PartRequestCreateSchema(Schema):
    """Kiosk request: which part, how many, and who is asking (from the Employee
    master by id, with free-text name/mobile as a fallback)."""
    class Meta:
        unknown = EXCLUDE

    part_id = fields.Integer(required=True, validate=validate.Range(min=1))
    requested_qty = fields.Decimal(required=True, places=2, validate=validate.Range(min=0, min_inclusive=False))
    employee_id = fields.Integer(allow_none=True)
    requester_mobile = fields.String(allow_none=True, validate=validate.Length(max=20))
    requester_name = fields.String(allow_none=True, validate=validate.Length(max=120))
    department = fields.String(required=True, validate=validate.Length(min=1, max=40))
    remarks = fields.String(allow_none=True, validate=validate.Length(max=255))


class PartRequestIssueSchema(Schema):
    """Supervisor confirm-issue: the scanned bin location (validated Right/Wrong
    against the part), the actual issued quantity, and an optional idempotency
    token so a double click does not issue twice."""
    class Meta:
        unknown = EXCLUDE

    scanned_location = fields.String(required=True, validate=validate.Length(min=1, max=40))
    issued_qty = fields.Decimal(required=True, places=2, validate=validate.Range(min=0, min_inclusive=False))
    token = fields.String(allow_none=True, validate=validate.Length(max=64))
    remarks = fields.String(allow_none=True, validate=validate.Length(max=255))
