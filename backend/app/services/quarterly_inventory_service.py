"""Quarterly Inventory business logic — periodic ERP-vs-physical
reconciliation, uploaded via Excel per Fiscal Year + Quarter (Toyota
Boshoku Inventory Excel format). Separate module from Daily Stock Count."""
from app.repositories.quarterly_inventory_repository import QuarterlyInventoryRepository
from app.repositories.part_repository import PartRepository
from app.models.quarterly_inventory import QUARTERS
from app.utils.excel_io import bulk_import, build_template, to_number, to_text

# Ordered tuples, not sets — match_columns() takes the first alias that hits
# and the plant's inventory sheet carries several qty columns at once. Its
# "Total Physical Qty" is the counted total (the per-location columns beside
# it are its breakdown), and its ERP column is dated per count — "ERP Stock 21
# JUNE 26" — so that one relies on the normalized-prefix match rather than an
# exact name that would need editing every quarter.
FIELD_ALIASES = {
    "part_no": ("partno", "partnumber", "tbpartno", "tbdipartno", "itemcode", "materialcode"),
    "erp_quantity": ("erpquantity", "erpqty", "erpstock", "systemquantity", "systemqty", "bookqty"),
    "physical_quantity": (
        "totalphysicalqty", "physicalquantity", "physicalqty", "physicalstock",
        "countedqty", "actualqty",
    ),
}
REQUIRED_FIELDS = ["part_no", "erp_quantity", "physical_quantity"]

TEMPLATE_COLUMNS = ["Part No", "Part Name", "ERP Quantity", "Physical Quantity"]


class QuarterlyInventoryService:
    def __init__(self):
        self.repo = QuarterlyInventoryRepository()
        self.part_repo = PartRepository()

    @staticmethod
    def _status_for(erp_qty, physical_qty):
        if physical_qty == erp_qty:
            return "MATCH"
        return "SHORT" if physical_qty < erp_qty else "EXCESS"

    def bulk_import_excel(self, file_stream, fiscal_year, quarter, sheet_name=None):
        if quarter not in QUARTERS:
            raise ValueError(f"quarter must be one of {QUARTERS}")

        def row_processor(raw_row):
            part_no = to_text(raw_row.get("part_no"))
            if not part_no:
                raise ValueError("Part No is required")
            part = self.part_repo.get_by_part_no(part_no)
            if not part:
                raise ValueError(f"Unknown Part No: {part_no}")

            erp_qty = to_number(raw_row.get("erp_quantity"))
            physical_qty = to_number(raw_row.get("physical_quantity"))
            if erp_qty is None or physical_qty is None:
                raise ValueError("ERP Quantity and Physical Quantity are required")

            status = self._status_for(erp_qty, physical_qty)
            self.repo.upsert(fiscal_year, quarter, part.id, erp_qty, physical_qty, status)

        return bulk_import(file_stream, FIELD_ALIASES, REQUIRED_FIELDS, row_processor, sheet_name)

    def _enrich(self, row):
        part = row.part
        unit_price = float(part.unit_price) if part.unit_price is not None else 0
        erp_qty = float(row.erp_quantity)
        physical_qty = float(row.physical_quantity)
        gap_qty = physical_qty - erp_qty
        return {
            "id": row.id, "fiscal_year": row.fiscal_year, "quarter": row.quarter,
            "part_id": part.id, "part_no": part.part_no, "part_name": part.part_name,
            "category": part.category, "sub_category": part.sub_category,
            "erp_quantity": erp_qty, "physical_quantity": physical_qty,
            "gap_quantity": gap_qty, "gap_value": round(gap_qty * unit_price, 2),
            "erp_value": round(erp_qty * unit_price, 2), "physical_value": round(physical_qty * unit_price, 2),
            "status": row.status,
        }

    def list_detail(self, fiscal_year, quarter, keyword=None, category=None, status=None):
        rows = [self._enrich(r) for r in self.repo.search(fiscal_year, quarter).all()]
        if keyword:
            kw = keyword.lower()
            rows = [r for r in rows if kw in r["part_no"].lower() or kw in r["part_name"].lower()]
        if category:
            rows = [r for r in rows if r["category"] == category]
        if status:
            rows = [r for r in rows if r["status"] == status]
        return rows

    def get_summary(self, fiscal_year, quarter):
        rows = self.list_detail(fiscal_year, quarter)
        total = len(rows)
        matched = sum(1 for r in rows if r["status"] == "MATCH")
        short = sum(1 for r in rows if r["status"] == "SHORT")
        excess = sum(1 for r in rows if r["status"] == "EXCESS")
        return {
            "fiscal_year": fiscal_year, "quarter": quarter,
            "total_parts_counted": total, "matched_parts": matched, "variance_parts": short + excess,
            "short_count": short, "excess_count": excess,
            "inventory_accuracy_pct": round(matched / total * 100, 2) if total else 0,
            "physical_inventory_value": round(sum(r["physical_value"] for r in rows), 2),
            "erp_value": round(sum(r["erp_value"] for r in rows), 2),
            "gap_value": round(sum(r["gap_value"] for r in rows), 2),
        }

    def _period_stats(self, rows, label_key, label_value):
        total = len(rows)
        matched = sum(1 for r in rows if r["status"] == "MATCH")
        return {
            label_key: label_value, "total_parts": total, "variance_parts": total - matched,
            "inventory_accuracy_pct": round(matched / total * 100, 2) if total else 0,
            "gap_value": round(sum(r["gap_value"] for r in rows), 2),
        }

    def get_fy_comparison(self):
        result = []
        for fy in self.repo.list_fiscal_years():
            rows = []
            for q in self.repo.list_quarters(fy):
                rows.extend(self.list_detail(fy, q))
            result.append(self._period_stats(rows, "fiscal_year", fy))
        return result

    def get_quarter_comparison(self, fiscal_year):
        result = []
        for q in QUARTERS:
            rows = self.list_detail(fiscal_year, q)
            if not rows:
                continue
            result.append(self._period_stats(rows, "quarter", q))
        return result

    @staticmethod
    def build_template():
        return build_template(TEMPLATE_COLUMNS)
