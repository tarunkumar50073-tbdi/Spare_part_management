"""ERP Stock Synchronization — inbound push from ERP (Step 9 of the spec:
ERP is the master inventory; Part Store only displays it). Same
mock-now/real-later shape as ERPClient, but inverted direction: here ERP
calls us whenever its stock changes, matching every other ERP touchpoint
already in this app (gate entry, RQC clearance, production punch)."""
from app.models.base import utcnow
from app.repositories.erp_stock_repository import ERPStockRepository
from app.repositories.part_repository import PartRepository
from app.services.audit_log_service import AuditLogService
from app.services.rack_alert_service import RackAlertService
from app.utils.db_tx import atomic
from app.utils.exceptions import BadRequestError


class ERPStockSyncService:
    def __init__(self):
        self.repo = ERPStockRepository()
        self.part_repo = PartRepository()
        self.audit_log_service = AuditLogService()
        self.rack_alert_service = RackAlertService()

    def sync(self, rows):
        """rows: [{part_no, qty_on_hand}, ...] pushed by ERP. Unknown part
        numbers are reported back rather than silently dropped, so a bad
        ERP payload surfaces immediately instead of quietly losing a line.
        Rack occupancy is never derived from this number (see RackBin
        model docstring) — this only updates the displayed stock figure
        and, via RackAlertService, re-checks whether any part's Holding
        Area stock can now be transferred."""
        synced_at = utcnow()
        updated = []
        errors = []
        with atomic():
            for row in rows:
                part = self.part_repo.get_by_part_no(row["part_no"])
                if not part:
                    errors.append({"part_no": row["part_no"], "reason": "Unknown part no"})
                    continue
                updated.append(self.repo.upsert(part.id, row["qty_on_hand"], synced_at).to_dict())
                self.audit_log_service.log(
                    "STOCK_SYNCHRONIZATION", "PART", part.id, user="SYSTEM", quantity=row["qty_on_hand"],
                )
            if not updated and errors:
                raise BadRequestError("No rows synced — all part numbers were unrecognized", errors=errors)
            if updated:
                self.rack_alert_service.check_and_notify()
        return {"synced": len(updated), "errors": errors}

    def get_all(self):
        return {row.part_id: float(row.qty_on_hand) for row in self.repo.list_all()}
