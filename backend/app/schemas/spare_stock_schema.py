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
    """Physically receiving supplier material (spec 1 / 9): a positive quantity
    plus optional detail (supplier / invoice / physical check / responsible
    section). It records a receipt waiting for the ERP GRN and the quality
    clearance — it does NOT add to on-hand (see SpareStockService.receive)."""
    class Meta:
        unknown = EXCLUDE

    qty = fields.Decimal(required=True, places=2, validate=validate.Range(min=0, min_inclusive=False))
    reference = fields.String(allow_none=True, validate=validate.Length(max=80))
    remarks = fields.String(allow_none=True, validate=validate.Length(max=255))
    supplier_id = fields.Integer(allow_none=True)
    # An ERP vendor (gate entry / GRN) — the receipt service refuses a code ERP
    # has never shown supplying this part.
    ven_cd = fields.String(allow_none=True, validate=validate.Length(max=30))
    ven_name = fields.String(allow_none=True, validate=validate.Length(max=160))
    supplier_source = fields.String(allow_none=True, validate=validate.Length(max=20))
    invoice_no = fields.String(allow_none=True, validate=validate.Length(max=60))
    invoice_date = fields.Date(allow_none=True)
    check_result = fields.String(allow_none=True, validate=validate.OneOf(list(CHECK_RESULTS)))
    department = fields.String(allow_none=True, validate=validate.Length(max=40))
    scanned_code = fields.String(allow_none=True, validate=validate.Length(max=80))
    scan_source = fields.String(allow_none=True, validate=validate.Length(max=20))


class SpareIssueSchema(Schema):
    """Stage 1 issue: a positive quantity deducted from on-hand, to a department +
    person. Machine/line are NOT captured here (the store may not know them) —
    the user confirms them later. Department is checked against the master in the
    service. scanned_code / scan_source say how the part was identified (spec 24
    audit), and go on the journal row."""
    class Meta:
        unknown = EXCLUDE

    qty = fields.Decimal(required=True, places=2, validate=validate.Range(min=0, min_inclusive=False))
    department = fields.String(required=True, validate=validate.Length(min=1, max=40))
    issued_to = fields.String(allow_none=True, validate=validate.Length(max=80))
    machine = fields.String(allow_none=True, validate=validate.Length(max=60))  # optional (legacy one-stage)
    returnable = fields.Boolean(load_default=False)  # a die/tool expected back
    reference = fields.String(allow_none=True, validate=validate.Length(max=80))
    remarks = fields.String(allow_none=True, validate=validate.Length(max=255))
    scanned_code = fields.String(allow_none=True, validate=validate.Length(max=80))
    scan_source = fields.String(allow_none=True, validate=validate.Length(max=20))


class SpareConfirmSchema(Schema):
    """Stage 2 confirmation by the user at the line — where the part was fitted
    — and every later "Update Line / Machine" (repeatable). A place field left
    out keeps the current value; one sent as null / blank clears it, so no
    load_default here — the route must be able to tell the two apart.
    actual_qty is checked against what is still out in the service."""
    class Meta:
        unknown = EXCLUDE

    line_name = fields.String(allow_none=True, validate=validate.Length(max=60))
    line_no = fields.String(allow_none=True, validate=validate.Length(max=30))
    machine = fields.String(allow_none=True, validate=validate.Length(max=60))
    die_no = fields.String(allow_none=True, validate=validate.Length(max=60))
    actual_qty = fields.Decimal(allow_none=True, places=2, validate=validate.Range(min=0))
    remarks = fields.String(allow_none=True, validate=validate.Length(max=255))


class SpareLocationSchema(Schema):
    """Update a spare's rack/shelf location (old + new recorded in history)."""
    class Meta:
        unknown = EXCLUDE

    new_location = fields.String(required=True, validate=validate.Length(min=1, max=40))
    reason = fields.String(required=True, validate=validate.Length(min=1, max=255))
    qty = fields.Decimal(allow_none=True, places=2, validate=validate.Range(min=0))


class SpareReturnSchema(Schema):
    """A part coming back to the store against its original issue (spec 13) —
    held for the store inspection, not put back in stock. qty is optional
    (omitted returns everything still out on the issue); reason is one of
    RETURN_REASONS (models/spare_stock.py) or the operator's own words for
    "Other", so it is free text up to 60 characters, not an enum; note is any
    extra remark; returned_by is the person who handed it over. reason stays
    optional so the legacy one-click return of a returnable tool still works."""
    class Meta:
        unknown = EXCLUDE

    qty = fields.Decimal(allow_none=True, places=2, validate=validate.Range(min=0, min_inclusive=False))
    reason = fields.String(allow_none=True, validate=validate.Length(max=60))
    note = fields.String(allow_none=True, validate=validate.Length(max=255))
    returned_by = fields.String(allow_none=True, validate=validate.Length(max=80))
    scanned_code = fields.String(allow_none=True, validate=validate.Length(max=80))
    scan_source = fields.String(allow_none=True, validate=validate.Length(max=20))
