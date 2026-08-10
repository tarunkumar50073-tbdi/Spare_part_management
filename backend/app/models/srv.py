"""SRV (Store Receipt Voucher): tracks one part line item through the full
Store process flow — from gate entry through production consumption.

Status progression ("PART PROCESS FLOW - STORE"). Routing to Store Stock vs
RQC is automatic on SRV creation (SRVService._auto_route), decided purely by
the ERP-supplied `qc_required` flag on this SRV line — never by the part's
own DOL/OTHER/TOOL_ROOM classification. `routing`/ROUTING_TYPES and the
Tool Room path are kept only as a manual-override escape hatch (see
SRVService.route); the automatic path only ever produces STORE or RQC.
Clearance from RQC is an inbound API call from RQC's own ERP, not a manual
action in this app:
PENDING_UNLOAD -> UNLOADED -> VERIFIED -> SRV_CREATED
  -> (auto-routed by qc_required) False: STORED directly (stock in main store)
             | True: INSPECTION_PENDING (awaiting RQC's own ERP)
                  -> RQC clears "Approved" -> STORED (stock in main store)
                  -> RQC clears "Rejected" -> RETURNED_TO_SUPPLIER (terminal)
  -> TRANSFERRED -> Production physically takes the material (no manual Issue
     step) -> ERP's own Production Punch confirms actual consumption ->
     CONSUMED (terminal — this is the point Part Store stock is deducted).

Rack Allocation (put_away_status/rack_bin_id/put_away_at below) only
starts once material actually reaches STORED — i.e. immediately for
qc_required=False, or after RQC's own ERP approves for qc_required=True
(see SRVService._receive_into_store). If the assigned rack has no space,
put_away_status becomes HOLDING instead of COMPLETED and a HoldingEntry is
created (see SRVService.put_away_confirm / HoldingService).
"""
from app.extensions import db
from app.models.base import BaseModel

STATUSES = [
    "PENDING_UNLOAD", "UNLOADED", "VERIFIED", "SRV_CREATED", "RQC_FORWARDED",
    "INSPECTION_PENDING", "INSPECTED_APPROVED", "INSPECTED_REJECTED",
    "STORED", "RETURNED_TO_SUPPLIER", "TRANSFERRED", "SUPPLIED", "CONSUMED",
    "FORWARDED_TOOL_ROOM",
]

ROUTING_TYPES = ["DOL", "OTHER", "TOOL_ROOM"]

PUT_AWAY_STATUSES = ["PENDING", "HOLDING", "COMPLETED"]


class SRV(BaseModel):
    __tablename__ = "srvs"

    srv_no = db.Column(db.String(30), unique=True, nullable=True, index=True)

    # Gate entry link — arrives via the inbound gate-entry API. Field names
    # follow the real ERP "Gate Entry Register" export: part_no below is
    # matched against the ERP's own Item Code (not a separate mapping).
    vendor_code = db.Column(db.String(20), nullable=False, index=True)
    supplier_name = db.Column(db.String(150), nullable=False)
    invoice_no = db.Column(db.String(50), nullable=True)
    gate_entry_no = db.Column(db.String(30), nullable=True, index=True)  # ERP's own gate entry no.
    vehicle_no = db.Column(db.String(20), nullable=True)
    challan_no = db.Column(db.String(30), nullable=True)
    po_no = db.Column(db.String(30), nullable=True)

    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)
    part_no = db.Column(db.String(30), nullable=False)
    part_name = db.Column(db.String(150), nullable=False)

    qty_invoiced = db.Column(db.Numeric(12, 2), nullable=False)
    qty_received = db.Column(db.Numeric(12, 2), nullable=True)
    scanned_qty = db.Column(db.Numeric(12, 2), nullable=False, default=0)  # running tally from barcode scans
    short_qty = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    is_short = db.Column(db.Boolean, nullable=False, default=False)
    short_note_sent = db.Column(db.Boolean, nullable=False, default=False)
    short_note_no = db.Column(db.String(30), nullable=True)  # issued by ERP when short

    # ERP configuration for this line — the sole input to auto-routing
    # (Store Stock vs Pending RQC). Never decided from Part.part_type.
    qc_required = db.Column(db.Boolean, nullable=False, default=True)

    routing = db.Column(db.String(10), nullable=True)  # DOL / OTHER / TOOL_ROOM — manual-override only
    inspection_result = db.Column(db.String(10), nullable=True)  # Approved / Rejected
    rejection_reason = db.Column(db.String(255), nullable=True)
    remarks = db.Column(db.String(255), nullable=True)

    status = db.Column(db.String(20), nullable=False, default="PENDING_UNLOAD", index=True)

    # Stage timestamps — one per process-flow step, for traceability.
    gate_entry_time = db.Column(db.DateTime(timezone=True), nullable=True)
    # When the vehicle left the gate. Distinct from unloaded_at, which is about
    # the material: a truck can sit at the dock long after its last box is off.
    # Recorded at the gate, so it is the only honest answer to "how long was
    # that vehicle inside".
    gate_out_time = db.Column(db.DateTime(timezone=True), nullable=True)
    unloaded_at = db.Column(db.DateTime(timezone=True), nullable=True)
    verified_at = db.Column(db.DateTime(timezone=True), nullable=True)
    srv_created_at = db.Column(db.DateTime(timezone=True), nullable=True)
    rqc_forwarded_at = db.Column(db.DateTime(timezone=True), nullable=True)
    routed_at = db.Column(db.DateTime(timezone=True), nullable=True)
    inspected_at = db.Column(db.DateTime(timezone=True), nullable=True)
    stored_at = db.Column(db.DateTime(timezone=True), nullable=True)
    returned_at = db.Column(db.DateTime(timezone=True), nullable=True)
    forwarded_tool_room_at = db.Column(db.DateTime(timezone=True), nullable=True)
    tool_room_cleared_at = db.Column(db.DateTime(timezone=True), nullable=True)
    transferred_at = db.Column(db.DateTime(timezone=True), nullable=True)
    supplied_at = db.Column(db.DateTime(timezone=True), nullable=True)
    consumed_at = db.Column(db.DateTime(timezone=True), nullable=True)

    # Rack Allocation — NULL until material actually reaches STORED (see
    # SRVService._receive_into_store), so an SRV still working through
    # unload/verify/RQC doesn't show up as "pending rack allocation".
    put_away_status = db.Column(db.String(10), nullable=True, default=None)
    rack_bin_id = db.Column(db.Integer, db.ForeignKey("rack_bins.id"), nullable=True)
    put_away_at = db.Column(db.DateTime(timezone=True), nullable=True)

    part = db.relationship("Part")
    rack_bin = db.relationship("RackBin")

    __table_args__ = (
        db.CheckConstraint(f"status IN ({','.join(repr(s) for s in STATUSES)})", name="ck_srv_status"),
        db.CheckConstraint(
            f"routing IS NULL OR routing IN ({','.join(repr(r) for r in ROUTING_TYPES)})", name="ck_srv_routing"
        ),
        db.CheckConstraint(
            "inspection_result IS NULL OR inspection_result IN ('Approved','Rejected')",
            name="ck_srv_inspection_result",
        ),
        db.CheckConstraint(
            f"put_away_status IS NULL OR put_away_status IN ({','.join(repr(s) for s in PUT_AWAY_STATUSES)})",
            name="ck_srv_put_away_status",
        ),
    )

    def __repr__(self):
        return f"<SRV {self.srv_no or 'PENDING'} {self.part_no} {self.status}>"
