"""Rack Availability Monitoring: whenever rack occupancy could have
changed (ERP stock sync, a holding-to-rack transfer, production
consumption freeing space), check every part that still has material
sitting in the Holding Area — if its assigned racks now have available
space, raise/refresh a RACK_SPACE_AVAILABLE notification telling the
operator to transfer.

Not a real background job (no scheduler exists in this app) — invoked
synchronously at the end of the trigger-point calls listed above, same
request-driven style as the rest of this codebase."""
from app.repositories.holding_entry_repository import HoldingEntryRepository
from app.repositories.rack_bin_repository import RackBinRepository
from app.repositories.part_repository import PartRepository
from app.services.notification_service import NotificationService


class RackAlertService:
    def __init__(self):
        self.holding_repo = HoldingEntryRepository()
        self.rack_bin_repo = RackBinRepository()
        self.part_repo = PartRepository()
        self.notification_service = NotificationService()

    def check_and_notify(self, part_id=None):
        part_ids = [part_id] if part_id else self.holding_repo.list_all_open_parts()
        for pid in part_ids:
            self._check_part(pid)

    def _check_part(self, part_id):
        open_entries = self.holding_repo.list_open_by_part(part_id)
        if not open_entries:
            return

        racks = [r for r in self.rack_bin_repo.list_by_part(part_id) if not r.is_blocked]
        available_bins = sum(max(r.bins_allocated - r.bins_occupied, 0) for r in racks)
        if available_bins <= 0:
            return

        part = self.part_repo.get_by_id(part_id)
        holding_qty = sum(float(e.remaining_qty) for e in open_entries)
        message = (
            f"Rack space is available. Part {part.part_no}: Holding Qty {holding_qty}, "
            f"Available Rack Space {available_bins} bin(s). Please transfer Holding Area stock to the assigned rack."
        )
        self.notification_service.create_or_refresh("RACK_SPACE_AVAILABLE", message, part_id=part_id)
