"""In-house Production Receipt — inbound push from ERP's own Production
Punch (mock-now/real-later, same shape as ERPStockSyncService/gate-entry).
This is the "MAKE" counterpart to a purchased SRV: a finished part_no's
stock lands straight into Part Store (already-inspected shop-floor output,
no RQC hop needed) and the movement is tagged source_type="MAKE" on the
ledger so StoreDashboardService.get_source_breakdown() can tell it apart
from a purchased (BUY/SRV) receipt for the same part_no."""
from app.models.base import utcnow
from app.repositories.production_receipt_repository import ProductionReceiptRepository
from app.repositories.part_repository import PartRepository
from app.repositories.store_stock_repository import PartStockRepository, StockLedgerRepository
from app.services.audit_log_service import AuditLogService
from app.utils.exceptions import NotFoundError


class ProductionReceiptService:
    def __init__(self):
        self.repo = ProductionReceiptRepository()
        self.part_repo = PartRepository()
        self.stock_repo = PartStockRepository()
        self.ledger_repo = StockLedgerRepository()
        self.audit_log_service = AuditLogService()

    def create(self, part_no, qty_produced, production_order_no=None):
        part = self.part_repo.get_by_part_no(part_no)
        if not part:
            raise NotFoundError(f"Unknown part no: {part_no}")

        produced_at = utcnow()
        receipt = self.repo.create(
            part_id=part.id, qty_produced=qty_produced,
            produced_at=produced_at, production_order_no=production_order_no,
        )
        self.stock_repo.adjust(part.id, "PART_STORE", qty_produced)
        self.ledger_repo.record(
            part.id, "PART_STORE", qty_produced, "PRODUCTION_RECEIPT",
            production_receipt_id=receipt.id, source_type="MAKE",
        )
        self.audit_log_service.log(
            "PRODUCTION_RECEIPT", "PART", part.id, user="SYSTEM", quantity=qty_produced,
        )
        return self._enrich(receipt)

    def _enrich(self, receipt):
        d = receipt.to_dict()
        d["part_no"] = receipt.part.part_no
        d["part_name"] = receipt.part.part_name
        return d

    def list_all(self, part_id=None):
        return [self._enrich(r) for r in self.repo.search(part_id=part_id).all()]
