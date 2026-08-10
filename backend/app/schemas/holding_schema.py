"""Marshmallow schemas for Holding Area validation."""
from marshmallow import Schema, fields, validate


class TransferSchema(Schema):
    rack_bin_id = fields.Integer(required=True, validate=validate.Range(min=1))
    transfer_qty = fields.Decimal(required=True, places=2, validate=validate.Range(min=0, min_inclusive=False))
    scanned_part_code = fields.String(required=True, validate=validate.Length(min=1, max=60))
