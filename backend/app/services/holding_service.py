"""Holding Area — material that couldn't be placed into its assigned
rack(s) during Put Away. Owns entry creation (called from
SRVService.put_away_confirm when a rack has no space), FIFO priority
numbering, and transfer-to-rack (with mandatory oldest-first enforcement
and partial-transfer support)."""
import math
from app.models.base import utcnow
from app.repositories.holding_entry_repository import HoldingEntryRepository
from app.repositories.rack_bin_repository import RackBinRepository
from app.repositories.part_repository import PartRepository
from app.repositories.srv_repository import SRVRepository
from app.services.rack_bin_service import RackBinService
from app.services.notification_service import NotificationService
from app.services.audit_log_service import AuditLogService
from app.services.rack_alert_service import RackAlertService
from app.utils.db_tx import atomic
from app.utils.exceptions import NotFoundError, BadRequestError


class HoldingService:
    def __init__(self):
        self.repo = HoldingEntryRepository()
        self.rack_bin_repo = RackBinRepository()
        self.part_repo = PartRepository()
        self.srv_repo = SRVRepository()
        self.rack_bin_service = RackBinService()
        self.notification_service = NotificationService()
        self.audit_log_service = AuditLogService()
        self.rack_alert_service = RackAlertService()

    def list_all(self, status=None, part_id=None):
        rows = self.repo.search(status=status, part_id=part_id).all()
        return [self._enrich(r) for r in rows]

    def get(self, holding_entry_id):
        row = self.repo.get_by_id(holding_entry_id)
        if not row:
            raise NotFoundError(f"Holding entry {holding_entry_id} not found")
        return row

    def create_entry(self, srv, qty, reason):
        """Called from SRVService.put_away_confirm when the assigned
        rack(s) can't take the material. Not a standalone user action."""
        part = srv.part
        assigned_rack = next(iter(self.rack_bin_repo.list_by_part(part.id)), None)
        entry = self.repo.create(
            srv_id=srv.id, part_id=part.id, invoice_no=srv.invoice_no,
            holding_qty=qty, remaining_qty=qty,
            temporary_location=f"HOLD-{part.part_no}",
            assigned_rack_id=assigned_rack.id if assigned_rack else None,
            holding_reason=reason, holding_status="PENDING", holding_date=utcnow(),
        )
        self._renumber_fifo(part.id)

        reason_label = "Assigned Rack Full" if reason == "ASSIGNED_RACK_FULL" else reason.replace("_", " ").title()
        self.notification_service.create_or_refresh(
            "ASSIGNED_RACK_FULL",
            f"{part.part_no}: {reason_label} — {qty} moved to Holding Area ({entry.temporary_location}).",
            part_id=part.id, holding_entry_id=entry.id,
        )
        self.audit_log_service.log(
            "HOLDING_AREA_ENTRY", "HOLDING_ENTRY", entry.id, user="SYSTEM",
            new_location=entry.temporary_location, quantity=qty, remarks=reason_label,
        )
        return entry

    def transfer_to_rack(self, holding_entry_id, rack_bin_id, transfer_qty, scanned_part_code):
        entry = self.get(holding_entry_id)
        if entry.holding_status == "COMPLETED":
            raise BadRequestError(f"Holding entry {holding_entry_id} is already completed")

        part = self.part_repo.get_by_scan_code(scanned_part_code)
        if not part or part.id != entry.part_id:
            raise BadRequestError(f"Scanned part does not match this holding entry (expected {entry.part.part_no})")

        # FIFO — mandatory oldest-first. The operator doesn't choose; the
        # system enforces it (this entry must be the queue head for its part).
        queue = self.repo.list_open_by_part(entry.part_id)
        if queue and queue[0].id != entry.id:
            raise BadRequestError(
                f"FIFO violation — holding entry #{queue[0].id} ({queue[0].holding_date.date()}) "
                f"must be transferred first for {part.part_no}"
            )

        if transfer_qty <= 0 or transfer_qty > float(entry.remaining_qty):
            raise BadRequestError(f"Transfer qty must be between 0 and {entry.remaining_qty}")

        rack_bin = self.rack_bin_repo.get_by_id(rack_bin_id)
        if not rack_bin:
            raise NotFoundError(f"Rack/Bin {rack_bin_id} not found")
        if rack_bin.part_id != entry.part_id:
            raise BadRequestError(f"Rack {rack_bin.location}/{rack_bin.rack_no} is not allocated to {part.part_no}")
        if rack_bin.is_blocked:
            raise BadRequestError(f"Rack {rack_bin.location}/{rack_bin.rack_no} is blocked")

        bins_needed = math.ceil(transfer_qty / float(rack_bin.bin_capacity))
        available = rack_bin.bins_allocated - rack_bin.bins_occupied
        if bins_needed > available:
            raise BadRequestError(f"Not enough space in {rack_bin.location}/{rack_bin.rack_no} — {available} bin(s) available, {bins_needed} needed")

        with atomic():
            self.rack_bin_service.adjust_occupancy(rack_bin_id, bins_needed)

            remaining = float(entry.remaining_qty) - transfer_qty
            new_status = "COMPLETED" if remaining <= 0 else "PARTIAL_TRANSFER"
            entry = self.repo.update(
                entry, remaining_qty=remaining, holding_status=new_status,
                transfer_date=utcnow(), assigned_rack_id=rack_bin_id,
            )

            if new_status == "COMPLETED":
                srv = self.srv_repo.get_by_id(entry.srv_id)
                if srv:
                    self.srv_repo.update(srv, rack_bin_id=rack_bin_id, put_away_status="COMPLETED", put_away_at=utcnow())
                self.notification_service.resolve_for_holding_entry(entry.id)
                self._renumber_fifo(entry.part_id)
                if not self.repo.list_open_by_part(entry.part_id):
                    # Nothing left in this part's Holding Area queue — clear
                    # every holding-related alert for it, not just the one tied
                    # to this specific entry (RACK_SPACE_AVAILABLE is per-part).
                    self.notification_service.resolve_all_for_part(
                        entry.part_id, ["RACK_SPACE_AVAILABLE", "ASSIGNED_RACK_FULL", "FIFO_VIOLATION_RISK"]
                    )

            self.audit_log_service.log(
                "HOLDING_AREA_TRANSFER", "HOLDING_ENTRY", entry.id, user="STORE",
                old_location=entry.temporary_location, new_location=f"{rack_bin.location}/{rack_bin.rack_no}",
                quantity=transfer_qty,
            )
            self.rack_alert_service.check_and_notify()
            return self._enrich(entry)

    def get_history(self, holding_entry_id):
        self.get(holding_entry_id)  # 404 if missing
        return self.audit_log_service.list_all(entity_type="HOLDING_ENTRY", entity_id=holding_entry_id).all()

    def _renumber_fifo(self, part_id):
        """1 = oldest. Recomputed across a part's open entries whenever one
        is created or completed, so the queue never has gaps/duplicates."""
        for i, entry in enumerate(self.repo.list_open_by_part(part_id), start=1):
            self.repo.update(entry, fifo_priority=i)

    def _enrich(self, row):
        d = row.to_dict()
        d["part_no"] = row.part.part_no
        d["part_name"] = row.part.part_name
        if row.assigned_rack:
            d["assigned_rack_label"] = f"{row.assigned_rack.location}/{row.assigned_rack.rack_no}"
            d["available_rack_space"] = max(row.assigned_rack.bins_allocated - row.assigned_rack.bins_occupied, 0)
        else:
            d["assigned_rack_label"] = None
            d["available_rack_space"] = None
        return d
