"""Marshmallow schemas for SRV / gate-entry workflow validation."""
from marshmallow import Schema, fields, validate


class GateEntryLineSchema(Schema):
    part_no = fields.String(required=True)  # matched against ERP's own Item Code
    qty_invoiced = fields.Decimal(required=True, places=2, validate=validate.Range(min=0, min_inclusive=False))
    challan_no = fields.String(allow_none=True)
    po_no = fields.String(allow_none=True)
    # ERP configuration — the sole input to auto-routing (Store Stock vs
    # Pending RQC). Required: routing must never fall back to guessing.
    qc_required = fields.Boolean(required=True)


class GateEntrySchema(Schema):
    """Payload for the inbound gate-entry API — Steps 1-2 of the process
    flow (Supplier Vehicle Arrives / ERP Gate Entry). Field names follow the
    real ERP "Gate Entry Register" export (Gate Entry No./Ven Cd/Item
    Code/Challan No/Po No/Vehicle No etc.) so the real API push is a
    straight field-for-field mapping, no translation layer needed."""
    vendor_code = fields.String(required=True)
    invoice_no = fields.String(allow_none=True)
    gate_entry_no = fields.String(allow_none=True)
    gate_entry_time = fields.DateTime(required=True)
    vehicle_no = fields.String(allow_none=True)
    lines = fields.List(fields.Nested(GateEntryLineSchema), required=True, validate=validate.Length(min=1))


class GateOutSchema(Schema):
    """Payload for the inbound gate-out API — the vehicle has left the gate.
    Same shape as the gate-entry push, minus the lines: a gate pass covers the
    whole truck, so identifying the truck is enough. Send gate_entry_no when
    ERP has one; otherwise vendor_code + vehicle_no identifies it for the day.
    gate_out_time is optional and defaults to now, for a gate system that
    posts as the barrier lifts."""
    gate_entry_no = fields.String(allow_none=True)
    vendor_code = fields.String(allow_none=True)
    vehicle_no = fields.String(allow_none=True)
    gate_out_time = fields.DateTime(allow_none=True)


class VerifySchema(Schema):
    qty_received = fields.Decimal(required=True, places=2, validate=validate.Range(min=0))
    remarks = fields.String(allow_none=True, validate=validate.Length(max=255))


class RouteSchema(Schema):
    routing = fields.String(allow_none=True, validate=validate.OneOf(["DOL", "OTHER", "TOOL_ROOM"]))


class InspectSchema(Schema):
    result = fields.String(required=True, validate=validate.OneOf(["Approved", "Rejected"]))
    rejection_reason = fields.String(allow_none=True, validate=validate.Length(max=255))


class CreateSrvSchema(Schema):
    """ERP pushes the already-decided SRV record — srv_no is ERP's own
    number, never minted by this app."""
    srv_no = fields.String(required=True, validate=validate.Length(min=1, max=30))
    short_note_no = fields.String(allow_none=True, validate=validate.Length(max=30))


class PutAwayConfirmSchema(Schema):
    rack_bin_id = fields.Integer(required=True, validate=validate.Range(min=1))
    scanned_part_code = fields.String(required=True, validate=validate.Length(min=1, max=60))
