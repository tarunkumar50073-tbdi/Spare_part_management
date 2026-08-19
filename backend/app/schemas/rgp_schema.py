"""Marshmallow schema for a Pending RGP row (ERP report columns)."""
from marshmallow import Schema, fields, validate


class RGPCreateSchema(Schema):
    store_code = fields.String(load_default="CHILD_PART", validate=validate.Length(max=30))
    ven_cd = fields.String(allow_none=True, validate=validate.Length(max=60))
    ven_name = fields.String(allow_none=True, validate=validate.Length(max=150))
    challan_no = fields.String(allow_none=True, validate=validate.Length(max=60))
    challan_dt = fields.Date(allow_none=True)
    challan_type = fields.String(allow_none=True, validate=validate.Length(max=60))
    resp_loc_name = fields.String(allow_none=True, validate=validate.Length(max=150))
    resp_emp = fields.String(allow_none=True, validate=validate.Length(max=60))
    resp_emp_name = fields.String(allow_none=True, validate=validate.Length(max=150))
    target_dt = fields.Date(allow_none=True)
    item_cd = fields.String(allow_none=True, validate=validate.Length(max=60))
    item_desc = fields.String(allow_none=True, validate=validate.Length(max=255))
    challan_qty = fields.Float(allow_none=True)
    receipt_qty = fields.Float(allow_none=True)
    balance_qty = fields.Float(allow_none=True)
    pend_days = fields.Integer(allow_none=True)
