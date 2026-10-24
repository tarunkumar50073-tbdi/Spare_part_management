"""Marshmallow schemas for Part master validation.

Numeric fields are bounded so a negative can't be stored: a negative
counted_qty produced a negative Coverage Day that still read as "Short",
and a negative daily_consumption dropped the part out of Short/Excess
reporting entirely. daily_consumption stops at >= 0 rather than > 0 only
because a handful of live parts already hold 0, and rejecting it would
block editing them; 0 and NULL behave identically downstream (no COV
basis), so 0 remains meaningless-but-tolerated rather than an error.
bin_capacity and package_standard are strictly positive — both are used as
divisors.

store_code/section_id and location/rework_location are accepted here because
Marshmallow rejects unknown fields: without them the Part Master form could
not send a store, so every part created through the UI landed with
store_code = NULL and vanished from both store dashboards (which count only
parts that have a store — StoreService._summaries_by_store skips a part with
no code). location/rework_location are likewise the two fields the Spare
Parts Store is organised around and had no way in at all."""
from marshmallow import Schema, fields, validate
from app.models.part import CATEGORIES


class PartCreateSchema(Schema):
    part_no = fields.String(required=True, validate=validate.Length(min=1, max=30))
    part_name = fields.String(required=True, validate=validate.Length(min=1, max=150))
    uom = fields.String(validate=validate.Length(min=1, max=10), load_default="PCS")
    barcode = fields.String(allow_none=True, validate=validate.Length(max=60))
    part_type = fields.String(validate=validate.OneOf(["DOL", "OTHER", "TOOL_ROOM"]), load_default="OTHER")
    min_stock_level = fields.Decimal(load_default=0, places=2, validate=validate.Range(min=0))
    reorder_level = fields.Decimal(allow_none=True, places=2, validate=validate.Range(min=0))
    max_stock_level = fields.Decimal(allow_none=True, places=2, validate=validate.Range(min=0))
    is_active = fields.Boolean(load_default=True)
    discontinued = fields.Boolean(load_default=False)
    target_cov_days_min = fields.Decimal(load_default=1, places=2, validate=validate.Range(min=0))
    target_cov_days_max = fields.Decimal(allow_none=True, places=2, validate=validate.Range(min=0))
    bin_capacity = fields.Decimal(allow_none=True, places=2, validate=validate.Range(min=0, min_inclusive=False))
    category = fields.String(allow_none=True, validate=validate.OneOf(CATEGORIES))
    sub_category = fields.String(allow_none=True, validate=validate.Length(max=50))
    specification = fields.String(allow_none=True, validate=validate.Length(max=255))
    model_no = fields.String(allow_none=True, validate=validate.Length(max=60))
    new_part_no = fields.String(allow_none=True, validate=validate.Length(max=30))
    old_part_no = fields.String(allow_none=True, validate=validate.Length(max=30))
    package_standard = fields.Decimal(allow_none=True, places=2, validate=validate.Range(min=0, min_inclusive=False))
    supplier_id = fields.Integer(allow_none=True, validate=validate.Range(min=1))
    daily_consumption = fields.Decimal(allow_none=True, places=2, validate=validate.Range(min=0))
    unit_price = fields.Decimal(allow_none=True, places=2, validate=validate.Range(min=0))
    store_code = fields.String(allow_none=True, validate=validate.Length(max=30))
    section_id = fields.Integer(allow_none=True, validate=validate.Range(min=1))
    location = fields.String(allow_none=True, validate=validate.Length(max=60))
    rework_location = fields.String(allow_none=True, validate=validate.Length(max=60))


class PartUpdateSchema(Schema):
    part_name = fields.String(validate=validate.Length(min=1, max=150))
    uom = fields.String(validate=validate.Length(min=1, max=10))
    barcode = fields.String(allow_none=True, validate=validate.Length(max=60))
    part_type = fields.String(validate=validate.OneOf(["DOL", "OTHER", "TOOL_ROOM"]))
    min_stock_level = fields.Decimal(places=2, validate=validate.Range(min=0))
    reorder_level = fields.Decimal(allow_none=True, places=2, validate=validate.Range(min=0))
    max_stock_level = fields.Decimal(allow_none=True, places=2, validate=validate.Range(min=0))
    is_active = fields.Boolean()
    discontinued = fields.Boolean()
    target_cov_days_min = fields.Decimal(places=2, validate=validate.Range(min=0))
    target_cov_days_max = fields.Decimal(allow_none=True, places=2, validate=validate.Range(min=0))
    bin_capacity = fields.Decimal(allow_none=True, places=2, validate=validate.Range(min=0, min_inclusive=False))
    category = fields.String(allow_none=True, validate=validate.OneOf(CATEGORIES))
    sub_category = fields.String(allow_none=True, validate=validate.Length(max=50))
    specification = fields.String(allow_none=True, validate=validate.Length(max=255))
    model_no = fields.String(allow_none=True, validate=validate.Length(max=60))
    new_part_no = fields.String(allow_none=True, validate=validate.Length(max=30))
    old_part_no = fields.String(allow_none=True, validate=validate.Length(max=30))
    package_standard = fields.Decimal(allow_none=True, places=2, validate=validate.Range(min=0, min_inclusive=False))
    supplier_id = fields.Integer(allow_none=True, validate=validate.Range(min=1))
    daily_consumption = fields.Decimal(allow_none=True, places=2, validate=validate.Range(min=0))
    unit_price = fields.Decimal(allow_none=True, places=2, validate=validate.Range(min=0))
    store_code = fields.String(allow_none=True, validate=validate.Length(max=30))
    section_id = fields.Integer(allow_none=True, validate=validate.Range(min=1))
    location = fields.String(allow_none=True, validate=validate.Length(max=60))
    rework_location = fields.String(allow_none=True, validate=validate.Length(max=60))
