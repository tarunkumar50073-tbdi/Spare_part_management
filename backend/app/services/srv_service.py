"""SRV (Store process-flow) business logic. The entire receiving pipeline —
gate entry, unload, material verification, and SRV creation (with its own
srv_no) — is ERP-inbound: ERP owns that data and pushes it in via API,
this app performs none of those decisions itself, just records what ERP
sends and displays it. Everything from routing onward (RQC clearance is
also ERP-inbound) through rack allocation, Holding Area/FIFO, store
transfer and ERP-confirmed production consumption is where this app's own
warehouse-floor logic lives. See app/models/srv.py for the full status
progression."""
import math
from app.models.base import utcnow
from app.models.srv import ROUTING_TYPES
from app.repositories.srv_repository import SRVRepository
from app.repositories.part_repository import PartRepository
from app.repositories.supplier_repository import SupplierRepository
from app.repositories.store_stock_repository import PartStockRepository, StockLedgerRepository
from app.repositories.rack_bin_repository import RackBinRepository
from app.repositories.holding_entry_repository import HoldingEntryRepository
from app.services.rack_bin_service import RackBinService
from app.services.holding_service import HoldingService
from app.services.rack_alert_service import RackAlertService
from app.services.notification_service import NotificationService
from app.services.audit_log_service import AuditLogService
from app.utils.db_tx import atomic
from app.utils.exceptions import NotFoundError, BadRequestError


class SRVService:
    def __init__(self):
        self.repo = SRVRepository()
        self.part_repo = PartRepository()
        self.supplier_repo = SupplierRepository()
        self.stock_repo = PartStockRepository()
        self.ledger_repo = StockLedgerRepository()
        self.rack_bin_repo = RackBinRepository()
        self.holding_entry_repo = HoldingEntryRepository()
        self.rack_bin_service = RackBinService()
        self.holding_service = HoldingService()
        self.rack_alert_service = RackAlertService()
        self.notification_service = NotificationService()
        self.audit_log_service = AuditLogService()

    def list_srvs(self, **filters):
        return self.repo.search(**filters)

    def get(self, srv_id):
        srv = self.repo.get_by_id(srv_id)
        if not srv:
            raise NotFoundError(f"SRV {srv_id} not found")
        return srv

    def ingest_gate_entry(self, data):
        """Inbound gate-entry API — Steps 1-2: Supplier Vehicle Arrives /
        ERP Gate Entry. Creates one PENDING_UNLOAD SRV line per invoice
        line item; the rest of the flow is driven from the app. part_no is
        matched against the ERP's own Item Code directly."""
        vendor_code = data["vendor_code"]
        supplier = self.supplier_repo.get_by_vendor_code(vendor_code)
        if not supplier:
            raise BadRequestError(f"Unknown vendor code: {vendor_code}")

        gate_entry_time = data["gate_entry_time"]
        invoice_no = data.get("invoice_no")
        gate_entry_no = data.get("gate_entry_no")
        vehicle_no = data.get("vehicle_no")

        created = []
        with atomic():
            for line in data["lines"]:
                part = self.part_repo.get_by_part_no(line["part_no"])
                if not part:
                    raise BadRequestError(f"Unknown part no: {line['part_no']}")
                srv = self.repo.create(
                    vendor_code=vendor_code,
                    supplier_name=supplier.supplier_name,
                    invoice_no=invoice_no,
                    gate_entry_no=gate_entry_no,
                    vehicle_no=vehicle_no,
                    challan_no=line.get("challan_no"),
                    po_no=line.get("po_no"),
                    part_id=part.id,
                    part_no=part.part_no,
                    part_name=part.part_name,
                    qty_invoiced=line["qty_invoiced"],
                    qc_required=line["qc_required"],
                    status="PENDING_UNLOAD",
                    gate_entry_time=gate_entry_time,
                )
                self._check_fifo_risk(part)
                created.append(srv)
        return created

    def _check_fifo_risk(self, part):
        """FIFO Protection (mandatory): if this part already has material
        sitting in the Holding Area and ERP sends a new gate entry for the
        same part, warn — don't block. ERP is master; we surface the risk,
        we don't reject its own data."""
        if not self.holding_entry_repo.has_open_for_part(part.id):
            return
        self.notification_service.create_or_refresh(
            "FIFO_VIOLATION_RISK",
            f"FIFO Warning — {part.part_no}: existing Holding Quantity found. Transfer old Holding Area stock first.",
            part_id=part.id,
        )
        self.audit_log_service.log("FIFO_WARNING", "PART", part.id, user="SYSTEM", remarks=f"New receipt while holding stock open for {part.part_no}")

    def gate_out(self, gate_entry_time_key, vendor_code=None, gate_entry_no=None,
                 vehicle_no=None, gate_out_time=None):
        """Inbound API — the gate reports a vehicle has left. Stamped on every
        SRV line that arrived on that vehicle, because a gate pass covers the
        whole truck, not one part.

        Deliberately not a manual action: gate entry, unload and verify all
        arrive from ERP's own API, and a vehicle-out time typed by hand here
        would be the one timestamp in the chain nobody could trace back.

        Matched on gate_entry_no when ERP sends one (its own gate pass is the
        natural key), otherwise on vendor + vehicle for the day, which is what
        identifies a truck when there is no pass number."""
        rows = self.repo.find_for_gate_out(
            gate_entry_time_key, vendor_code=vendor_code,
            gate_entry_no=gate_entry_no, vehicle_no=vehicle_no,
        )
        if not rows:
            raise NotFoundError("No gate entry found for this vehicle")
        stamped = gate_out_time or utcnow()
        with atomic():
            for srv in rows:
                self.repo.update(srv, gate_out_time=stamped)
        return rows

    def unload(self, srv_id):
        """Step 3: Material Unloading. Inbound API — ERP reports the truck
        has been unloaded; not a manual action in this app."""
        srv = self._require_status(srv_id, "PENDING_UNLOAD")
        return self.repo.update(srv, status="UNLOADED", unloaded_at=utcnow())

    def verify(self, srv_id, qty_received, remarks=None):
        """Step 4: Material Verification. Inbound API — ERP owns barcode/
        invoice verification and pushes the final verified quantity; this
        app performs no verification of its own."""
        srv = self._require_status(srv_id, "UNLOADED")
        fields = {"status": "VERIFIED", "verified_at": utcnow(), "qty_received": qty_received}
        if remarks:
            fields["remarks"] = remarks
        return self.repo.update(srv, **fields)

    def create_srv(self, srv_id, srv_no, short_note_no=None):
        """Steps 5-6: SRV Creation. Inbound API — ERP has already decided
        the SRV (short-material branch included) and pushes the finished
        record, srv_no included; this app does not mint srv_no itself."""
        with atomic():
            srv = self._require_status(srv_id, "VERIFIED")
            short_qty = max(float(srv.qty_invoiced or 0) - float(srv.qty_received or 0), 0)
            is_short = short_qty > 0
            srv = self.repo.update(
                srv,
                status="SRV_CREATED",
                srv_created_at=utcnow(),
                srv_no=srv_no,
                short_qty=short_qty,
                is_short=is_short,
                short_note_sent=bool(short_note_no),
                short_note_no=short_note_no,
            )
            self.audit_log_service.log("SRV_GENERATED", "SRV", srv.id, user="SYSTEM", quantity=srv.qty_received, remarks=srv.srv_no)
            return self._auto_route(srv)

    def _auto_route(self, srv):
        """Steps 7-8 run automatically the instant an SRV is created —
        routing is decided purely by the ERP-supplied qc_required flag on
        this SRV line, never by the part's own DOL/OTHER/TOOL_ROOM
        classification (that stays available only as a manual override via
        route()). qc_required=False lands straight in main store stock;
        qc_required=True drops into the RQC inspection queue awaiting RQC's
        own ERP to clear it. Maintenance parts follow this exact same rule —
        there is no separate maintenance-parts path."""
        srv = self.forward_to_rqc(srv.id)
        return self.route(srv.id, routing="OTHER" if srv.qc_required else "DOL")

    def forward_to_rqc(self, srv_id):
        """Step 7: SRV forwarded to RQC for quality clearance. Called
        automatically from create_srv() — not a standalone user action."""
        srv = self._require_status(srv_id, "SRV_CREATED")
        return self.repo.update(srv, status="RQC_FORWARDED", rqc_forwarded_at=utcnow())

    def route(self, srv_id, routing=None):
        """Step 8: Material Routing. DOL -> Store Location directly (skips
        inspection, qc_required=False); OTHER -> RQC Inspection queue,
        awaiting clearance via RQC's own ERP (qc_required=True); TOOL_ROOM
        is a manual-override-only option, never chosen automatically.
        Called automatically from create_srv() using the SRV's own
        qc_required flag — routing param is a manual-override escape hatch,
        not the normal path."""
        with atomic():
            srv = self._require_status(srv_id, "RQC_FORWARDED")
            routing = routing or ("OTHER" if srv.qc_required else "DOL")
            if routing not in ROUTING_TYPES:
                raise BadRequestError(f"routing must be one of {ROUTING_TYPES}")

            if routing == "DOL":
                srv = self.repo.update(srv, routing=routing, routed_at=utcnow(), status="STORED", stored_at=utcnow())
                self._receive_into_store(srv)
                return srv
            if routing == "TOOL_ROOM":
                return self.repo.update(
                    srv, routing=routing, routed_at=utcnow(),
                    status="FORWARDED_TOOL_ROOM", forwarded_tool_room_at=utcnow(),
                )
            return self.repo.update(srv, routing=routing, routed_at=utcnow(), status="INSPECTION_PENDING")

    def inspect(self, srv_id, result, rejection_reason=None):
        """Steps 9-11: Quality Inspection -> Inspection Result -> Store
        Action (Approved -> stored, Rejected -> returned to supplier).
        Inbound API — called by RQC's own ERP once they clear (or reject)
        the part, not a manual action in this app."""
        srv = self._require_status(srv_id, "INSPECTION_PENDING")
        if result not in ("Approved", "Rejected"):
            raise BadRequestError("result must be Approved or Rejected")

        if result == "Approved":
            with atomic():
                srv = self.repo.update(
                    srv, inspection_result=result, inspected_at=utcnow(),
                    status="STORED", stored_at=utcnow(),
                )
                self._receive_into_store(srv)
                self.audit_log_service.log("QC_APPROVAL", "SRV", srv.id, user="SYSTEM", quantity=srv.qty_received)
                return srv
        return self.repo.update(
            srv, inspection_result=result, inspected_at=utcnow(),
            rejection_reason=rejection_reason,
            status="RETURNED_TO_SUPPLIER", returned_at=utcnow(),
        )

    def clear_tool_room(self, srv_id):
        """Tool Room / Maintenance clearance. Inbound API — called by
        Maintenance's own ERP once they clear the part; stock then arrives
        into main store the same way DOL or RQC-approved material does."""
        with atomic():
            srv = self._require_status(srv_id, "FORWARDED_TOOL_ROOM")
            srv = self.repo.update(srv, status="STORED", stored_at=utcnow(), tool_room_cleared_at=utcnow())
            self._receive_into_store(srv)
            return srv

    def transfer(self, srv_id):
        """Step 12: Store Transfer, Receiving Store -> Part Store. No manual
        button anywhere in this app any more — chained automatically right
        after material reaches STORED (see _receive_into_store); this is
        pure ledger bookkeeping, not a physical action, so there's nothing
        for an operator to confirm."""
        with atomic():
            srv = self._require_status(srv_id, "STORED")
            qty = self._effective_qty(srv)
            self.stock_repo.adjust(srv.part_id, "RECEIVING_STORE", -qty)
            self.stock_repo.adjust(srv.part_id, "PART_STORE", qty)
            self.ledger_repo.record(srv.part_id, "RECEIVING_STORE", -qty, "TRANSFER_OUT", srv_id=srv.id)
            self.ledger_repo.record(srv.part_id, "PART_STORE", qty, "TRANSFER_IN", srv_id=srv.id)
            return self.repo.update(srv, status="TRANSFERRED", transferred_at=utcnow())

    def confirm_consumption(self, srv_id):
        """Step 13-14: ERP Production Punch. There is no manual Production
        Issue step in this app any more — the operator physically takes the
        feeder off the rack with no slip, no manual entry, no store
        transaction. Stock stays booked in Part Store until this inbound API
        call from Production's own ERP confirms the BOM child part was
        actually consumed; that single call both closes out custody
        (supplied_at) and deducts stock (consumed_at) in one step, since
        there's no longer a separate "handed to production" moment to
        record on our side."""
        with atomic():
            srv = self._require_status(srv_id, "TRANSFERRED")
            qty = self._effective_qty(srv)
            self.stock_repo.adjust(srv.part_id, "PART_STORE", -qty)
            self.ledger_repo.record(srv.part_id, "PART_STORE", -qty, "PRODUCTION_CONSUMPTION", srv_id=srv.id)
            self._release_rack_occupancy(srv.part_id, float(qty))
            now = utcnow()
            srv = self.repo.update(srv, status="CONSUMED", supplied_at=now, consumed_at=now)
            self.rack_alert_service.check_and_notify(part_id=srv.part_id)
            return srv

    def _release_rack_occupancy(self, part_id, qty):
        """Production physically taking material off a rack is the one
        real "space just freed up" moment in this app — computed here from
        our own SRV/part knowledge, never read off ERP's stock number (ERP
        has no concept of which rack material sits in). Walks the part's
        racks oldest-assigned-first (documented simplification — no
        per-lot rack tracking exists) releasing bins until qty is covered."""
        remaining = qty
        for rack in sorted(self.rack_bin_repo.list_by_part(part_id), key=lambda r: r.id):
            if remaining <= 0 or rack.bins_occupied <= 0:
                continue
            bins_to_release = min(rack.bins_occupied, math.ceil(remaining / float(rack.bin_capacity)))
            self.rack_bin_service.adjust_occupancy(rack.id, -bins_to_release)
            remaining -= bins_to_release * float(rack.bin_capacity)

    def list_pending_put_away(self):
        return self.repo.list_pending_put_away()

    def put_away_confirm(self, srv_id, rack_bin_id, scanned_part_code):
        """Rack Allocation: operator scans the rack, scans the part, then
        confirms. Both scans are validated here rather than trusted from
        the client. If the scanned rack has no space left (or is blocked),
        material is redirected into the Holding Area instead of being
        forced into storage — see HoldingService.create_entry."""
        srv = self.get(srv_id)
        if srv.put_away_status != "PENDING":
            raise BadRequestError(f"SRV {srv_id} rack allocation is already {srv.put_away_status}")

        part = self.part_repo.get_by_scan_code(scanned_part_code)
        if not part or part.id != srv.part_id:
            raise BadRequestError(f"Scanned part does not match SRV {srv_id} (expected {srv.part_no})")

        rack_bin = self.rack_bin_repo.get_by_id(rack_bin_id)
        if not rack_bin:
            raise NotFoundError(f"Rack/Bin {rack_bin_id} not found")
        if rack_bin.part_id != srv.part_id:
            raise BadRequestError(f"Rack {rack_bin.location}/{rack_bin.rack_no} is not allocated to {srv.part_no}")

        qty = float(self._effective_qty(srv))
        bins_needed = math.ceil(qty / float(rack_bin.bin_capacity))
        available = rack_bin.bins_allocated - rack_bin.bins_occupied

        with atomic():
            if rack_bin.is_blocked or bins_needed > available:
                reason = "OVERFLOW" if self._exceeds_total_capacity(part, qty) else "ASSIGNED_RACK_FULL"
                self.holding_service.create_entry(srv, qty, reason)
                return self.repo.update(srv, put_away_status="HOLDING")

            srv = self.repo.update(srv, rack_bin_id=rack_bin_id, put_away_status="COMPLETED", put_away_at=utcnow())
            self.rack_bin_service.adjust_occupancy(rack_bin_id, bins_needed)
            self.audit_log_service.log(
                "RACK_ALLOCATION", "SRV", srv.id, user="STORE",
                new_location=f"{rack_bin.location}/{rack_bin.rack_no}", quantity=qty,
            )
            return srv

    def _exceeds_total_capacity(self, part, qty):
        """Overflow (structurally too small even empty) vs. Assigned Rack
        Full (temporarily full) — checked against the part's own nominal
        bin_capacity summed across all its non-blocked racks."""
        if not part.bin_capacity or float(part.bin_capacity) <= 0:
            return False
        bins_needed_total = math.ceil(qty / float(part.bin_capacity))
        total_bins = sum(r.bins_allocated for r in self.rack_bin_repo.list_by_part(part.id) if not r.is_blocked)
        return total_bins < bins_needed_total

    def _receive_into_store(self, srv):
        qty = self._effective_qty(srv)
        self.stock_repo.adjust(srv.part_id, "RECEIVING_STORE", qty)
        self.ledger_repo.record(srv.part_id, "RECEIVING_STORE", qty, "SRV_STORED", srv_id=srv.id, source_type="BUY")
        self.repo.update(srv, put_away_status="PENDING")
        self.transfer(srv.id)

    @staticmethod
    def _effective_qty(srv):
        return srv.qty_received if srv.qty_received is not None else srv.qty_invoiced

    def _require_status(self, srv_id, expected_status):
        srv = self.get(srv_id)
        if srv.status != expected_status:
            raise BadRequestError(f"SRV {srv_id} must be in {expected_status} status (currently {srv.status})")
        return srv
