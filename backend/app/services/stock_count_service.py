"""Daily physical stock count business logic — the in-app replacement for
the Excel count sheet, feeding COV Days."""
from datetime import date
from app.extensions import db
from app.repositories.stock_count_repository import StockCountRepository
from app.repositories.part_repository import PartRepository
from app.services.cov_service import COVService
from app.services.live_stock_service import LiveStockService
from app.utils.excel_io import bulk_import, build_export, to_number, to_text
from app.models.store import DEFAULT_STORE_CODE

# Ordered on purpose — match_columns() takes the first alias that hits, and
# the SCM "BIN STOCK REPORT" carries several plausible-looking columns at
# once. Its "Total Qty" is the real physical count (Cov. Days on that sheet
# is exactly Total Qty / peak-per-day), while "Total Store Rack Qty" is rack
# capacity (store rack capacity x packing standard) and must never win.
FIELD_ALIASES = {
    "part_no": (
        "partno", "partnumber", "tbdipartno", "partcode",
        "itemcode", "itemno", "materialcode", "childpartno",
    ),
    "counted_qty": (
        "countedqty", "countqty", "physicalqty", "physicalstock", "actualqty",
        "totalqty", "closingstock", "closingqty", "onhandqty", "balanceqty",
        "stockqty", "quantity", "qty", "count",
    ),
}
REQUIRED_FIELDS = ["part_no", "counted_qty"]

TEMPLATE_COLUMNS = [("Part No", "part_no"), ("Part Name", "part_name"), ("Counted Qty", "counted_qty")]
EXPORT_COLUMNS = [
    ("Part No", "part_no"), ("Part Name", "part_name"), ("UOM", "uom"),
    ("Counted Qty", "counted_qty"), ("Daily Consumption", "daily_consumption"),
    ("COV Days", "cov_days"), ("Indicator", "indicator"),
]


class StockCountService:
    def __init__(self):
        self.repo = StockCountRepository()
        self.part_repo = PartRepository()
        self.cov_service = COVService()

    def submit(self, count_date, entries):
        """entries: list of {part_id, counted_qty}. Refreshes Short/Excess
        Since tracking for every part whose count just changed."""
        for entry in entries:
            self.repo.upsert(entry["part_id"], count_date, entry["counted_qty"])
        db.session.commit()
        for entry in entries:
            part = self.part_repo.get_by_id(entry["part_id"])
            if part:
                self.cov_service.refresh_since_tracking(part)
        LiveStockService.invalidate_rows_cache()
        return len(entries)

    def get_today_sheet(self, count_date=None):
        count_date = count_date or date.today()
        parts = self.part_repo.get_active(DEFAULT_STORE_CODE)
        existing = {row.part_id: row for row in self.repo.list_by_date(count_date)}
        latest_map = self.cov_service.get_latest_map()
        sheet = []
        for part in parts:
            row = existing.get(part.id)
            status = self.cov_service.get_status(part, latest_map=latest_map)
            sheet.append({
                "part_id": part.id,
                "part_no": part.part_no,
                "part_name": part.part_name,
                "uom": part.uom,
                "counted_qty": float(row.counted_qty) if row else None,
                "count_date": count_date.isoformat(),
                "cov_days": status["cov_days"],
                "indicator": status["indicator"],
                "basis": status["basis"],
                "daily_consumption": status["daily_consumption"],
            })
        return sheet

    def bulk_import_excel(self, file_stream, count_date, sheet_name=None):
        """A part gets one count row per date, but a count sheet lists it once
        per rack location — the SCM report has parts spread over two or three
        racks. So quantities are totalled per part across the whole file and
        written once at the end. Upserting row by row kept only whichever
        location happened to be last and silently dropped the rest: one part
        landed as 0 when its real stock was 180,800, and duly showed up as
        short."""
        totals = {}

        def row_processor(raw_row):
            part_no = to_text(raw_row.get("part_no"))
            if not part_no:
                raise ValueError("Part No is required")
            part = self.part_repo.get_by_part_no(part_no)
            if not part:
                raise ValueError(f"Unknown Part No: {part_no}")

            counted_qty = to_number(raw_row.get("counted_qty"))
            if counted_qty is None:
                raise ValueError("Counted Qty is required")

            totals[part.id] = totals.get(part.id, 0) + counted_qty

        report = bulk_import(file_stream, FIELD_ALIASES, REQUIRED_FIELDS, row_processor, sheet_name)

        for part_id, qty in totals.items():
            self.repo.upsert(part_id, count_date, qty)
        db.session.commit()

        for part_id in totals:
            part = self.part_repo.get_by_id(part_id)
            if part:
                self.cov_service.refresh_since_tracking(part)
        LiveStockService.invalidate_rows_cache()
        # Rows and parts differ whenever a part is racked in more than one
        # place; both are worth showing so a smaller part count doesn't read
        # as rows having gone missing.
        report["parts_updated"] = len(totals)
        return report

    def build_template(self):
        parts = self.part_repo.get_active(DEFAULT_STORE_CODE)
        rows = [{"part_no": p.part_no, "part_name": p.part_name, "counted_qty": ""} for p in parts]
        return build_export(TEMPLATE_COLUMNS, rows)

    def export_sheet(self, count_date=None):
        return build_export(EXPORT_COLUMNS, self.get_today_sheet(count_date))
