"""Store Stock screen: Available Store Stock vs Pending RQC Stock. Only
Available Store Stock can be used/issued — Pending RQC is visibility-only,
waiting on RQC's own ERP (see SRVService.inspect)."""
from sqlalchemy import func
from app.extensions import db
from app.models.srv import SRV
from app.repositories.part_repository import PartRepository
from app.repositories.erp_stock_repository import ERPStockRepository
from app.repositories.store_stock_repository import PartStockRepository
from app.models.store import DEFAULT_STORE_CODE

STATUS_PENDING_RQC = "INSPECTION_PENDING"


class StoreStockService:
    def __init__(self):
        self.part_repo = PartRepository()
        self.erp_stock_repo = ERPStockRepository()
        self.part_stock_repo = PartStockRepository()

    def _available_qty_by_part(self):
        """ERP-synced qty is the source of truth once ERP has pushed for a
        part; falls back to the internally-computed PartStock sum for any
        part ERP hasn't synced yet."""
        erp_qty = {row.part_id: float(row.qty_on_hand) for row in self.erp_stock_repo.list_all()}
        fallback = {}
        for row in self.part_stock_repo.list_all():
            fallback[row.part_id] = fallback.get(row.part_id, 0) + float(row.qty_on_hand)
        merged = dict(fallback)
        merged.update(erp_qty)
        return merged, set(erp_qty.keys())

    def get_summary(self):
        parts = self.part_repo.get_active(DEFAULT_STORE_CODE)
        available_qty, erp_synced_parts = self._available_qty_by_part()

        pending_rqc_rows = (
            db.session.query(SRV.part_id, func.sum(SRV.qty_received).label("qty"))
            .filter(SRV.status == STATUS_PENDING_RQC)
            .group_by(SRV.part_id)
            .all()
        )
        pending_rqc_by_part = {row.part_id: float(row.qty or 0) for row in pending_rqc_rows}

        available = []
        pending_rqc = []
        for part in parts:
            qty = available_qty.get(part.id, 0)
            if qty:
                available.append({
                    "part_id": part.id, "part_no": part.part_no, "part_name": part.part_name,
                    "uom": part.uom, "qty_on_hand": qty, "source": "ERP" if part.id in erp_synced_parts else "Internal",
                })
            rqc_qty = pending_rqc_by_part.get(part.id, 0)
            if rqc_qty:
                pending_rqc.append({
                    "part_id": part.id, "part_no": part.part_no, "part_name": part.part_name,
                    "uom": part.uom, "qty_on_hand": rqc_qty,
                })

        return {"available": available, "pending_rqc": pending_rqc}
