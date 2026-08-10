"""Validation for spare on-hand stock writes.

Quantity is bounded at zero: a negative on-hand is not a shortage, it is a
data-entry slip, and letting one through would make every downstream figure
(stock value, below-minimum count, shortfall) quietly wrong.
"""
from marshmallow import Schema, fields, validate

from app.models.spare_stock import TXN_TYPES
from app.services.spare_stock_service import DEPARTMENTS


class SpareStockSetSchema(Schema):
    qty_on_hand = fields.Decimal(required=True, places=2, validate=validate.Range(min=0))
    # OPENING for the first count, ADJUSTMENT for a correction. RECEIPT and
    # ISSUE are written by the issue/receipt flow, not typed in here.
    txn_type = fields.String(
        load_default="ADJUSTMENT",
        validate=validate.OneOf([t for t in TXN_TYPES if t in ("OPENING", "ADJUSTMENT")]),
    )
    reference = fields.String(allow_none=True, validate=validate.Length(max=80))
    remarks = fields.String(allow_none=True, validate=validate.Length(max=255))


class SpareIssueSchema(Schema):
    """Issuing a spare to a department: a positive quantity that will be
    deducted from on-hand, tagged with which department drew it."""
    qty = fields.Decimal(required=True, places=2, validate=validate.Range(min=0, min_inclusive=False))
    department = fields.String(required=True, validate=validate.OneOf(list(DEPARTMENTS)))
    reference = fields.String(allow_none=True, validate=validate.Length(max=80))
    remarks = fields.String(allow_none=True, validate=validate.Length(max=255))
