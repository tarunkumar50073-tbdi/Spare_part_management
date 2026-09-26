"""Validation for the store inspection of returned spares (spec 14).

The shape only — which result is allowed from which bucket, and how much is
left to inspect, depend on the return's current split and are checked in
SpareReturnService with an operator message.
"""
from marshmallow import EXCLUDE, Schema, fields, pre_load, validate

from app.models.spare_flow import INSPECTION_RESULTS


class SpareInspectSchema(Schema):
    """result: GOOD | INSPECTION_REQUIRED | DAMAGED | SCRAP. qty: how much of the
    chosen bucket this result covers. from_bucket: PENDING / HOLD / DAMAGED (or
    RETURN_PENDING / RETURN_HOLD) — omitted, the service takes what is waiting,
    then what is held, then what is damaged."""
    class Meta:
        unknown = EXCLUDE

    result = fields.String(required=True, validate=validate.OneOf(list(INSPECTION_RESULTS)))
    qty = fields.Decimal(required=True, places=2, validate=validate.Range(min=0, min_inclusive=False))
    from_bucket = fields.String(allow_none=True, validate=validate.Length(max=20))
    remarks = fields.String(allow_none=True, validate=validate.Length(max=255))

    @pre_load
    def _upper_keys(self, data, **kwargs):
        """Accept "good" as well as "GOOD" — the codes are case-insensitive."""
        if isinstance(data, dict):
            data = dict(data)
            for key in ("result", "from_bucket"):
                if isinstance(data.get(key), str):
                    data[key] = data[key].strip().upper()
        return data
