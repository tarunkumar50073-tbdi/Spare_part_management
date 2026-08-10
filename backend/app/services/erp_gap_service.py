"""ERP vs Physical Gap — reconciliation between the ERP-pushed stock figure
(ERPStock, the master live number) and an operator-uploaded physical count
(PhysicalStock). Physical is a SEPARATE reconciliation store from Daily
Stock Count (which drives COV/Short/Excess), so uploading or removing a
snapshot here never disturbs the COV basis — "Remove Physical Data" simply
clears the reconciliation.

Status (physical vs ERP): MATCH (equal), SHORT (physical < ERP — floor has
less than ERP believes), EXCESS (physical > ERP). NOT_SYNCED when ERP hasn't
pushed that part yet; NO_PHYSICAL when no physical snapshot exists yet.
"""
from app.models.base import utcnow
from app.repositories.part_repository import PartRepository
from app.repositories.erp_stock_repository import ERPStockRepository
from app.repositories.physical_stock_repository import PhysicalStockRepository
from app.utils.excel_io import bulk_import, build_export, build_template, to_number, to_text
from app.utils.db_tx import atomic
from app.models.store import DEFAULT_STORE_CODE

FIELD_ALIASES = {
    "part_no": {"partno", "partnumber"},
    "physical_qty": {"physicalqty", "physicalquantity", "countedqty", "qty", "quantity"},
}
REQUIRED_FIELDS = ["part_no", "physical_qty"]

TEMPLATE_COLUMNS = ["Part No", "Part Name", "Physical Qty"]

EXPORT_COLUMNS = [
    ("Part No", "part_no"), ("Part Name", "part_name"), ("Category", "category"),
    ("ERP Stock", "erp_qty"), ("Physical Stock", "physical_qty"),
    ("Gap (Physical - ERP)", "gap_qty"), ("Status", "status"),
]


class ERPGapService:
    def __init__(self):
        self.part_repo = PartRepository()
        self.erp_repo = ERPStockRepository()
        self.physical_repo = PhysicalStockRepository()

    @staticmethod
    def _status(erp_qty, physical_qty):
        if physical_qty is None:
            return "NO_PHYSICAL"
        if erp_qty is None:
            return "NOT_SYNCED"
        if physical_qty == erp_qty:
            return "MATCH"
        return "SHORT" if physical_qty < erp_qty else "EXCESS"

    def get_gap(self, keyword=None, category=None, status=None):
        erp_map = {r.part_id: (float(r.qty_on_hand), r.synced_at) for r in self.erp_repo.list_all()}
        physical_map = self.physical_repo.map_by_part()

        rows = []
        for part in self.part_repo.get_active(DEFAULT_STORE_CODE):
            erp = erp_map.get(part.id)
            phys = physical_map.get(part.id)
            erp_qty = erp[0] if erp else None
            physical_qty = float(phys.qty) if phys else None
            if erp_qty is None and physical_qty is None:
                continue
            gap_qty = (physical_qty - erp_qty) if (erp_qty is not None and physical_qty is not None) else None
            rows.append({
                "part_id": part.id, "part_no": part.part_no, "part_name": part.part_name,
                "category": part.category, "sub_category": part.sub_category,
                "erp_qty": erp_qty, "physical_qty": physical_qty, "gap_qty": gap_qty,
                "status": self._status(erp_qty, physical_qty),
                "erp_synced_at": erp[1].isoformat() if erp else None,
                "physical_uploaded_at": phys.uploaded_at.isoformat() if phys else None,
            })

        if keyword:
            kw = keyword.lower()
            rows = [r for r in rows if kw in r["part_no"].lower() or kw in r["part_name"].lower()]
        if category:
            rows = [r for r in rows if r["category"] == category]
        if status:
            rows = [r for r in rows if r["status"] == status]

        rows.sort(key=lambda r: abs(r["gap_qty"]) if r["gap_qty"] is not None else -1, reverse=True)
        return rows

    def get_summary(self):
        rows = self.get_gap()
        reconciled = [r for r in rows if r["gap_qty"] is not None]
        matched = sum(1 for r in reconciled if r["status"] == "MATCH")
        return {
            "total": len(rows),
            "matched": matched,
            "short": sum(1 for r in rows if r["status"] == "SHORT"),
            "excess": sum(1 for r in rows if r["status"] == "EXCESS"),
            "no_physical": sum(1 for r in rows if r["status"] == "NO_PHYSICAL"),
            "not_synced": sum(1 for r in rows if r["status"] == "NOT_SYNCED"),
            "accuracy_pct": round(matched / len(reconciled) * 100, 2) if reconciled else None,
        }

    def import_physical_excel(self, file_stream):
        """Physical Excel upload → upsert into PhysicalStock (Part No +
        Physical Qty). Unknown part numbers are reported per-row, not
        silently dropped."""
        now = utcnow()
        seen = set()

        def row_processor(raw_row):
            part_no = to_text(raw_row.get("part_no"))
            if not part_no:
                raise ValueError("Part No is required")
            if part_no in seen:
                raise ValueError(f"Duplicate Part No in file: {part_no}")
            seen.add(part_no)
            part = self.part_repo.get_by_part_no(part_no)
            if not part:
                raise ValueError(f"Unknown Part No: {part_no}")
            qty = to_number(raw_row.get("physical_qty"))
            if qty is None:
                raise ValueError("Physical Qty is required")
            self.physical_repo.upsert(part.id, qty, now)

        with atomic():
            return bulk_import(file_stream, FIELD_ALIASES, REQUIRED_FIELDS, row_processor)

    def clear_physical(self):
        """Remove Physical Data — clears the whole reconciliation snapshot."""
        return self.physical_repo.clear_all()

    @staticmethod
    def build_template():
        return build_template(TEMPLATE_COLUMNS)

    def export_excel(self, keyword=None, category=None, status=None):
        return build_export(EXPORT_COLUMNS, self.get_gap(keyword, category, status))
