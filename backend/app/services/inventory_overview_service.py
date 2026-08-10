"""Inventory Overview — a category-first view across the whole Part
Master, built on top of LiveStockService's row-building so it reuses the
exact same Coverage Day / rack / value logic as Live Stock/Short/Excess
Parts instead of recomputing it. Each of Part.CATEGORIES gets its own
section with a sub-category breakdown, matching the store's real BOP/
Import/Maintenance-Tool Room/Consumable/In-Parts split."""
from app.models.part import CATEGORIES
from app.models.rack_bin import DEAD_STOCK_LOCATION
from app.services.live_stock_service import LiveStockService
from app.utils.excel_io import build_export
from app.utils.pagination import paginate_list

STOCK_STATUSES = ["Healthy", "Short", "Excess", "Dead Stock", "Unknown"]
# COVService indicators -> the coarser stock-status buckets shown here.
_STATUS_MAP = {"Normal": "Healthy", "Short": "Short", "OutOfStock": "Short", "Excess": "Excess"}

EXPORT_COLUMNS = [
    ("Part No", "part_no"), ("Part Description", "part_name"), ("Category", "category"),
    ("Sub Category", "sub_category"), ("Rack No", "rack_no"), ("UOM", "uom"),
    ("In Stock", "live_stock"), ("Unit Price", "unit_price"), ("Total Value", "total_value"),
    ("Stock Status", "stock_status"),
]


class InventoryOverviewService:
    def __init__(self):
        self.live_stock_service = LiveStockService()

    def _rows(self):
        rows = self.live_stock_service._all_rows()
        for r in rows:
            rack_no = (r["rack_no"] or "").upper()
            if DEAD_STOCK_LOCATION in rack_no:
                r["stock_status"] = "Dead Stock"
            else:
                r["stock_status"] = _STATUS_MAP.get(r["status"], "Unknown")
        return rows

    def get_category_summary(self):
        """One card per category: total part count + a sub-category
        breakdown (top 4 by count, rest folded into "Others"), matching the
        Inventory Overview mockup's category cards."""
        rows = self._rows()
        cards = []
        for cat in CATEGORIES:
            cat_rows = [r for r in rows if r["category"] == cat]
            sub_counts = {}
            for r in cat_rows:
                key = r["sub_category"] or "Uncategorized"
                sub_counts[key] = sub_counts.get(key, 0) + 1
            ordered = sorted(sub_counts.items(), key=lambda kv: -kv[1])
            top, rest = ordered[:4], ordered[4:]
            breakdown = [{"name": name, "count": count} for name, count in top]
            if rest:
                breakdown.append({"name": "Others", "count": sum(c for _, c in rest)})
            cards.append({"category": cat, "total": len(cat_rows), "sub_categories": breakdown})
        return cards

    def list_detail(self, keyword=None, category=None, sub_category=None, status=None, page=1, per_page=10):
        rows = self._rows()
        if keyword:
            kw = keyword.lower()
            rows = [r for r in rows if kw in r["part_no"].lower() or kw in r["part_name"].lower()]
        if category:
            rows = [r for r in rows if r["category"] == category]
        if sub_category:
            rows = [r for r in rows if r["sub_category"] == sub_category]
        if status:
            rows = [r for r in rows if r["stock_status"] == status]
        return paginate_list(rows, page, per_page)

    def get_inventory_value_by_category(self):
        rows = self._rows()
        result = {}
        for cat in CATEGORIES:
            result[cat] = round(sum(r["total_value"] or 0 for r in rows if r["category"] == cat), 2)
        return result

    def get_stock_status_summary(self):
        rows = self._rows()
        counts = {s: 0 for s in STOCK_STATUSES}
        for r in rows:
            counts[r["stock_status"]] += 1
        return counts

    def get_top_short_parts(self, limit=5):
        rows = [r for r in self._rows() if r["stock_status"] == "Short"]
        rows.sort(key=lambda r: r["cov_days"] if r["cov_days"] is not None else -1)
        return rows[:limit]

    def export_excel(self, keyword=None, category=None, sub_category=None, status=None):
        rows = self._rows()
        if keyword:
            kw = keyword.lower()
            rows = [r for r in rows if kw in r["part_no"].lower() or kw in r["part_name"].lower()]
        if category:
            rows = [r for r in rows if r["category"] == category]
        if sub_category:
            rows = [r for r in rows if r["sub_category"] == sub_category]
        if status:
            rows = [r for r in rows if r["stock_status"] == status]
        return build_export(EXPORT_COLUMNS, rows)
