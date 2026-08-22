"""Validation for spare on-hand stock writes.

Quantity is bounded at zero: a negative on-hand is not a shortage, it is a
data-entry slip, and letting one through would make every downstream figure
(stock value, below-minimum count, shortfall) quietly wrong.

Department is validated against the live department master in the service (not a
hardcoded list here), so a newly-added department works with no code change.
"""
from marshmallow import EXCLUDE, Schema, fields, validate

from app.models.spare_stock import CHECK_RESULTS, TXN_TYPES


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


class SpareReceiveSchema(Schema):
    """Physically receiving new stock: a positive quantity added to on-hand, plus
    optional structured detail (supplier / invoice / physical check / responsible
    section). No RQC and no put-away — spec-compliant for spares."""
    class Meta:
        unknown = EXCLUDE

    qty = fields.Decimal(required=True, places=2, validate=validate.Range(min=0, min_inclusive=False))
    reference = fields.String(allow_none=True, validate=validate.Length(max=80))
    remarks = fields.String(allow_none=True, validate=validate.Length(max=255))
    supplier_id = fields.Integer(allow_none=True)
    invoice_no = fields.String(allow_none=True, validate=validate.Length(max=60))
    invoice_date = fields.Date(allow_none=True)
    check_result = fields.String(allow_none=True, validate=validate.OneOf(list(CHECK_RESULTS)))
    department = fields.String(allow_none=True, validate=validate.Length(max=40))


class SpareIssueSchema(Schema):
    """Stage 1 issue: a positive quantity deducted from on-hand, to a department +
    person. Machine/line are NOT captured here (the store may not know them) —
    the user confirms them later. Department is checked against the master in the
    service."""
    class Meta:
        unknown = EXCLUDE

    qty = fields.Decimal(required=True, places=2, validate=validate.Range(min=0, min_inclusive=False))
    department = fields.String(required=True, validate=validate.Length(min=1, max=40))
    issued_to = fields.String(allow_none=True, validate=validate.Length(max=80))
    machine = fields.String(allow_none=True, validate=validate.Length(max=60))  # optional (legacy one-stage)
    returnable = fields.Boolean(load_default=False)  # a die/tool expected back
    reference = fields.String(allow_none=True, validate=validate.Length(max=80))
    remarks = fields.String(allow_none=True, validate=validate.Length(max=255))


class SpareConfirmSchema(Schema):
    """Stage 2 confirmation by the user at the line — where the part was fitted."""
    class Meta:
        unknown = EXCLUDE

    line_name = fields.String(allow_none=True, validate=validate.Length(max=60))
    line_no = fields.String(allow_none=True, validate=validate.Length(max=30))
    machine = fields.String(allow_none=True, validate=validate.Length(max=60))
    actual_qty = fields.Decimal(allow_none=True, places=2, validate=validate.Range(min=0))
    remarks = fields.String(allow_none=True, validate=validate.Length(max=255))


class SpareLocationSchema(Schema):
    """Update a spare's rack/shelf location (old + new recorded in history)."""
    class Meta:
        unknown = EXCLUDE

    new_location = fields.String(required=True, validate=validate.Length(min=1, max=40))
    reason = fields.String(required=True, validate=validate.Length(min=1, max=255))
    qty = fields.Decimal(allow_none=True, places=2, validate=validate.Range(min=0))
