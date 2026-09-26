"""Validation for the spare RGP (supplier rework) writes — spec 15-19.

Shape and length only. The business rules — an RGP only from a return's hold /
damaged quantity, a vendor code only from ERP for this part, the quantity
limits of each step — live in SpareRgpService, which answers with a 400 and an
operator-readable message.
"""
from marshmallow import EXCLUDE, Schema, fields, validate

from app.models.spare_flow import SUPPLIER_SOURCES

_POSITIVE = validate.Range(min=0, min_inclusive=False)


class _ScanFields(Schema):
    """How the operator reached the part (spec 24) — optional on every write."""
    class Meta:
        unknown = EXCLUDE

    scanned_code = fields.String(allow_none=True, validate=validate.Length(max=80))
    scan_source = fields.String(allow_none=True, validate=validate.Length(max=20))


class SpareRgpOutSchema(_ScanFields):
    """RGP OUT - REWORK from a return. from_bucket defaults (in the service) to
    DAMAGED when the return has damaged qty, else RETURN_HOLD. ven_name may be
    left blank when the supplier comes from ERP (ven_cd) or the master
    (supplier_id) — the service fills it from there."""
    qty = fields.Decimal(required=True, places=2, validate=_POSITIVE)
    from_bucket = fields.String(allow_none=True, validate=validate.OneOf(["DAMAGED", "RETURN_HOLD"]))
    supplier_id = fields.Integer(allow_none=True)
    ven_cd = fields.String(allow_none=True, validate=validate.Length(max=30))
    ven_name = fields.String(allow_none=True, validate=validate.Length(max=160))
    supplier_source = fields.String(required=True, validate=validate.OneOf(list(SUPPLIER_SOURCES)))
    rework_reason = fields.String(required=True, validate=validate.Length(min=1, max=120))
    remarks = fields.String(allow_none=True, validate=validate.Length(max=255))
    rgp_date = fields.Date(allow_none=True)
    expected_return_date = fields.Date(allow_none=True)
    erp_challan_no = fields.String(allow_none=True, validate=validate.Length(max=40))


class SpareRgpSupplierReturnSchema(_ScanFields):
    """The supplier brought reworked material back (waits for the RGP GRN)."""
    qty = fields.Decimal(required=True, places=2, validate=_POSITIVE)
    remarks = fields.String(allow_none=True, validate=validate.Length(max=255))


class SpareRgpGrnSchema(_ScanFields):
    """The RGP GRN the supervisor created in ERP — its number is required."""
    qty = fields.Decimal(required=True, places=2, validate=_POSITIVE)
    grn_no = fields.String(required=True, validate=validate.Length(min=1, max=40))
    grn_date = fields.Date(allow_none=True)
    remarks = fields.String(allow_none=True, validate=validate.Length(max=255))


class SpareRgpCancelSchema(Schema):
    class Meta:
        unknown = EXCLUDE

    reason = fields.String(required=True, validate=validate.Length(min=1, max=255))
