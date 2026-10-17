"""Reports module — the Reports page's downloads, per store.

The Child Parts Store keeps its thirteen reports (SRV, Verification, Pending
RQC, Put Away, Rack Stock, Live Stock, Supplier and the quarterly inventory
ones), built here exactly as before. Every other store is a spare store: its
reports come from SpareReportService. Either way one (columns, rows) pair is
exported as Excel (excel_io.build_export), CSV (build_csv) or PDF
(utils/pdf_io.build_pdf_table), named "<Report> <DD.MM.YYYY>[ to <DD.MM.YYYY>]".
A spare store's reorder and excess lists download as Excel in the colours of
the reorder / excess mail sheets (their Report's paint and legend)."""
import io

from sqlalchemy import func
from app.extensions import db
from app.models.srv import SRV
from app.models.rack_bin import RackBin
from app.models.store import DEFAULT_STORE_CODE, Store
from app.repositories.srv_repository import SRVRepository
from app.repositories.rack_bin_repository import RackBinRepository
from app.repositories.supplier_repository import SupplierRepository
from app.services.store_stock_service import StoreStockService
from app.services.quarterly_inventory_service import QuarterlyInventoryService
from app.services.live_stock_service import LiveStockService
from app.services.reorder_mail_service import _file_safe, xlsx_table
from app.services.spare_report_service import SpareReportService, plant_today
from app.utils.excel_io import build_export, build_csv
from app.utils.pdf_io import build_pdf_table
from app.utils.exceptions import BadRequestError, NotFoundError

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
# format in the URL -> (file extension, mimetype)
FORMATS = {"excel": ("xlsx", XLSX_MIME), "csv": ("csv", "text/csv"), "pdf": ("pdf", "application/pdf")}

# One line per Child Parts report for the Reports page.
DESCRIPTIONS = {
    "srv": "Every SRV with its quantities, QC routing and status.",
    "verification": "SRVs verified by ERP: invoiced, received and short quantity.",
    "pending_rqc": "SRVs waiting for RQC inspection.",
    "put_away": "Put-away status and rack of every SRV.",
    "rack_stock": "Rack and bin allocation of every part.",
    "live_stock": "Live on-hand quantity of every child part.",
    "supplier": "Suppliers with the number of SRVs each.",
    "inventory_summary": "Quarterly inventory totals, accuracy and gap value per period.",
    "inventory_variance": "Parts whose physical count differed from ERP, per quarter.",
    "inventory_accuracy": "Inventory accuracy per quarter.",
    "fy_comparison": "Inventory accuracy and gap value, fiscal year against fiscal year.",
    "quarter_comparison": "Inventory accuracy and gap value, quarter against quarter.",
    "top_oldest_excess": "The 10 parts that have been in excess the longest.",
}


def _render(fmt, title, columns, rows, paint=None, legend=None):
    """`paint` and `legend` colour an Excel table the way the mails colour
    their sheets (reorder_mail_service.xlsx_table) — the reorder and excess
    lists, whose rows are keyed by column heading. CSV has no colours, and the
    PDF table draws none (pdf_io takes no cell colours), so both are as before."""
    if fmt == "excel":
        if paint is None and legend is None:
            return build_export(columns, rows)
        return io.BytesIO(xlsx_table([label for label, _ in columns], rows, paint, legend))
    if fmt == "csv":
        return build_csv(columns, rows)
    # The PDF writes str() of every cell: an empty cell must not read "None".
    return build_pdf_table(title, columns, [{k: ("" if v is None else v) for k, v in r.items()} for r in rows])


class ReportService:
    def __init__(self):
        self.srv_repo = SRVRepository()
        self.rack_bin_repo = RackBinRepository()
        self.supplier_repo = SupplierRepository()
        self.store_stock_service = StoreStockService()
        self.qty_inv_service = QuarterlyInventoryService()
        self.live_stock_service = LiveStockService()
        self.spare = SpareReportService()

    def _srv_rows(self):
        return [{
            "srv_no": s.srv_no or "", "vendor_code": s.vendor_code, "part_no": s.part_no,
            "part_name": s.part_name, "qty_invoiced": float(s.qty_invoiced or 0),
            "qty_received": float(s.qty_received) if s.qty_received is not None else "",
            "is_short": "Yes" if s.is_short else "No", "qc_required": "Yes" if s.qc_required else "No",
            "routing": s.routing or "", "status": s.status,
            "srv_created_at": s.srv_created_at.isoformat() if s.srv_created_at else "",
        } for s in self.srv_repo.get_all().order_by(SRV.created_at.desc()).all()]

    def _verification_rows(self):
        """Verification is ERP-pushed (see SRVService.verify) — qty_received
        here is the figure ERP verified, not a locally-scanned tally."""
        rows = self.srv_repo.get_all().filter(SRV.verified_at.isnot(None)).order_by(SRV.verified_at.desc()).all()
        return [{
            "part_no": s.part_no, "part_name": s.part_name, "qty_invoiced": float(s.qty_invoiced or 0),
            "qty_received": float(s.qty_received or 0),
            "short_qty": float(s.short_qty or 0), "verified_at": s.verified_at.isoformat() if s.verified_at else "",
        } for s in rows]

    def _pending_rqc_rows(self):
        rows = self.srv_repo.search(status="INSPECTION_PENDING")
        return [{
            "srv_no": s.srv_no or "", "part_no": s.part_no, "part_name": s.part_name,
            "vendor_code": s.vendor_code, "qty_received": float(s.qty_received or 0),
            "rqc_forwarded_at": s.rqc_forwarded_at.isoformat() if s.rqc_forwarded_at else "",
        } for s in rows]

    def _put_away_rows(self):
        rows = self.srv_repo.get_all().filter(SRV.srv_no.isnot(None)).order_by(SRV.srv_created_at.desc()).all()
        return [{
            "srv_no": s.srv_no or "", "part_no": s.part_no, "part_name": s.part_name,
            "put_away_status": s.put_away_status,
            "rack": f"{s.rack_bin.location}/{s.rack_bin.rack_no}" if s.rack_bin else "",
            "put_away_at": s.put_away_at.isoformat() if s.put_away_at else "",
        } for s in rows]

    def _rack_stock_rows(self):
        rows = self.rack_bin_repo.list_all()
        return [{
            "location": r.location, "rack_no": r.rack_no, "part_no": r.part.part_no,
            "part_name": r.part.part_name, "bin_capacity": float(r.bin_capacity or 0),
            "bins_allocated": r.bins_allocated,
        } for r in rows]

    def _live_stock_rows(self):
        return [{
            "part_no": r["part_no"], "part_name": r["part_name"], "uom": r["uom"],
            "qty_on_hand": r["qty_on_hand"], "source": r["source"],
        } for r in self.store_stock_service.get_summary()["available"]]

    def _supplier_rows(self):
        counts = dict(
            db.session.query(SRV.vendor_code, func.count(SRV.id)).group_by(SRV.vendor_code).all()
        )
        return [{
            "vendor_code": s.vendor_code, "supplier_name": s.supplier_name, "status": s.status,
            "total_srvs": counts.get(s.vendor_code, 0),
        } for s in self.supplier_repo.get_all().all()]

    def _all_periods(self):
        """Every (fiscal_year, quarter) combo that has Quarterly Inventory data."""
        periods = []
        for fy in self.qty_inv_service.repo.list_fiscal_years():
            for q in self.qty_inv_service.repo.list_quarters(fy):
                periods.append((fy, q))
        return periods

    def _inventory_summary_rows(self):
        rows = []
        for fy, q in self._all_periods():
            s = self.qty_inv_service.get_summary(fy, q)
            rows.append({
                "fiscal_year": fy, "quarter": q, "total_parts_counted": s["total_parts_counted"],
                "matched_parts": s["matched_parts"], "variance_parts": s["variance_parts"],
                "short_count": s["short_count"], "excess_count": s["excess_count"],
                "inventory_accuracy_pct": s["inventory_accuracy_pct"],
                "physical_inventory_value": s["physical_inventory_value"],
                "erp_value": s["erp_value"], "gap_value": s["gap_value"],
            })
        return rows

    def _inventory_variance_rows(self):
        rows = []
        for fy, q in self._all_periods():
            for r in self.qty_inv_service.list_detail(fy, q):
                if r["status"] == "MATCH":
                    continue
                rows.append(r)
        return rows

    def _inventory_accuracy_rows(self):
        rows = []
        for fy, q in self._all_periods():
            s = self.qty_inv_service.get_summary(fy, q)
            rows.append({
                "fiscal_year": fy, "quarter": q,
                "total_parts_counted": s["total_parts_counted"], "matched_parts": s["matched_parts"],
                "inventory_accuracy_pct": s["inventory_accuracy_pct"],
            })
        return rows

    def _fy_comparison_rows(self):
        return self.qty_inv_service.get_fy_comparison()

    def _quarter_comparison_rows(self):
        rows = []
        for fy in self.qty_inv_service.repo.list_fiscal_years():
            for r in self.qty_inv_service.get_quarter_comparison(fy):
                rows.append({"fiscal_year": fy, **r})
        return rows

    def _top_oldest_excess_rows(self):
        return self.live_stock_service.top_oldest_excess(10)

    REPORTS = {
        "srv": ("SRV Report", _srv_rows, [
            ("SRV No", "srv_no"), ("Vendor", "vendor_code"), ("Part No", "part_no"), ("Part Name", "part_name"),
            ("Qty Invoiced", "qty_invoiced"), ("Qty Received", "qty_received"), ("Short", "is_short"),
            ("QC Required", "qc_required"), ("Routing", "routing"), ("Status", "status"), ("Created At", "srv_created_at"),
        ]),
        "verification": ("Verification Report", _verification_rows, [
            ("Part No", "part_no"), ("Part Name", "part_name"), ("Qty Invoiced", "qty_invoiced"),
            ("Qty Received", "qty_received"), ("Short Qty", "short_qty"),
            ("Verified At", "verified_at"),
        ]),
        "pending_rqc": ("Pending RQC Report", _pending_rqc_rows, [
            ("SRV No", "srv_no"), ("Part No", "part_no"), ("Part Name", "part_name"), ("Vendor", "vendor_code"),
            ("Qty Received", "qty_received"), ("Forwarded At", "rqc_forwarded_at"),
        ]),
        "put_away": ("Put Away Report", _put_away_rows, [
            ("SRV No", "srv_no"), ("Part No", "part_no"), ("Part Name", "part_name"),
            ("Put Away Status", "put_away_status"), ("Rack", "rack"), ("Put Away At", "put_away_at"),
        ]),
        "rack_stock": ("Rack Stock Report", _rack_stock_rows, [
            ("Location", "location"), ("Rack No", "rack_no"), ("Part No", "part_no"), ("Part Name", "part_name"),
            ("Bin Capacity", "bin_capacity"), ("Bins Allocated", "bins_allocated"),
        ]),
        "live_stock": ("Live Stock Report", _live_stock_rows, [
            ("Part No", "part_no"), ("Part Name", "part_name"), ("UOM", "uom"),
            ("Qty On Hand", "qty_on_hand"), ("Source", "source"),
        ]),
        "supplier": ("Supplier Report", _supplier_rows, [
            ("Vendor Code", "vendor_code"), ("Supplier Name", "supplier_name"), ("Status", "status"),
            ("Total SRVs", "total_srvs"),
        ]),
        "inventory_summary": ("Inventory Summary", _inventory_summary_rows, [
            ("Fiscal Year", "fiscal_year"), ("Quarter", "quarter"), ("Total Parts Counted", "total_parts_counted"),
            ("Matched Parts", "matched_parts"), ("Variance Parts", "variance_parts"),
            ("Short Count", "short_count"), ("Excess Count", "excess_count"),
            ("Inventory Accuracy %", "inventory_accuracy_pct"), ("Physical Inventory Value", "physical_inventory_value"),
            ("ERP Value", "erp_value"), ("Gap Value", "gap_value"),
        ]),
        "inventory_variance": ("Inventory Variance Report", _inventory_variance_rows, [
            ("Fiscal Year", "fiscal_year"), ("Quarter", "quarter"), ("Part No", "part_no"), ("Part Name", "part_name"),
            ("Category", "category"), ("ERP Quantity", "erp_quantity"), ("Physical Quantity", "physical_quantity"),
            ("Gap Quantity", "gap_quantity"), ("Gap Value", "gap_value"), ("Status", "status"),
        ]),
        "inventory_accuracy": ("Inventory Accuracy Report", _inventory_accuracy_rows, [
            ("Fiscal Year", "fiscal_year"), ("Quarter", "quarter"), ("Total Parts Counted", "total_parts_counted"),
            ("Matched Parts", "matched_parts"), ("Inventory Accuracy %", "inventory_accuracy_pct"),
        ]),
        "fy_comparison": ("FY Comparison Report", _fy_comparison_rows, [
            ("Fiscal Year", "fiscal_year"), ("Total Parts", "total_parts"), ("Variance Parts", "variance_parts"),
            ("Inventory Accuracy %", "inventory_accuracy_pct"), ("Gap Value", "gap_value"),
        ]),
        "quarter_comparison": ("Quarter Comparison Report", _quarter_comparison_rows, [
            ("Fiscal Year", "fiscal_year"), ("Quarter", "quarter"), ("Total Parts", "total_parts"),
            ("Variance Parts", "variance_parts"), ("Inventory Accuracy %", "inventory_accuracy_pct"), ("Gap Value", "gap_value"),
        ]),
        "top_oldest_excess": ("Top 10 Oldest Excess Parts", _top_oldest_excess_rows, [
            ("Part No", "part_no"), ("Part Name", "part_name"), ("Category", "category"),
            ("Live Stock", "live_stock"), ("COV Days", "cov_days"),
            ("Excess Since", "excess_since"), ("Days In Excess", "days_in_excess"),
        ]),
    }

    def _resolve(self, report_type):
        entry = self.REPORTS.get(report_type)
        if not entry:
            raise BadRequestError(f"Unknown report type: {report_type}. Valid: {', '.join(self.REPORTS)}")
        return entry

    def export_excel(self, report_type):
        title, row_fn, columns = self._resolve(report_type)
        return build_export(columns, row_fn(self))

    def export_pdf(self, report_type):
        title, row_fn, columns = self._resolve(report_type)
        return title, build_pdf_table(title, columns, row_fn(self))

    def export_csv(self, report_type):
        title, row_fn, columns = self._resolve(report_type)
        return build_csv(columns, row_fn(self))

    # ---- per store (the Reports page) ----

    @staticmethod
    def _is_child_store(store_code):
        """True for the Child Parts Store; False for any other (spare) store.
        No store code is the Child Parts Store, as before stores existed."""
        if store_code in (None, DEFAULT_STORE_CODE):
            return True
        if Store.query.filter_by(code=store_code).first() is None:
            raise NotFoundError(f"Store '{store_code}' not found")
        return False

    def catalog(self, store_code):
        """The reports a store offers, in page order."""
        if self._is_child_store(store_code):
            reports = [(key, title, DESCRIPTIONS[key], False) for key, (title, _, _) in self.REPORTS.items()]
        else:
            reports = [(r.key, r.label, r.description, r.needs_dates) for r in self.spare.REPORTS]
        return [{"key": key, "label": label, "description": description, "needs_dates": dated,
                 "formats": list(FORMATS)} for key, label, description, dated in reports]

    def export(self, report_type, fmt, store_code=None, date_from=None, date_to=None):
        """(file, download name, mimetype) of one report of a store. A report
        the store does not offer, or an unknown format, is a 404."""
        if fmt not in FORMATS:
            raise NotFoundError(f"Unknown format '{fmt}'. Valid: {', '.join(FORMATS)}")
        ext, mime = FORMATS[fmt]
        if self._is_child_store(store_code):
            if report_type not in self.REPORTS:
                raise NotFoundError(f"There is no report '{report_type}' in this store")
            name = f"{self.REPORTS[report_type][0]} {plant_today():%d.%m.%Y}"
            if fmt == "excel":
                buf = self.export_excel(report_type)
            elif fmt == "csv":
                buf = self.export_csv(report_type)
            else:
                _, buf = self.export_pdf(report_type)
        else:
            report, win, rows = self.spare.build(store_code, report_type, date_from, date_to)
            if win is None:
                name = f"{report.label} {plant_today():%d.%m.%Y}"
            elif win.first == win.last:
                name = f"{report.label} {win.first:%d.%m.%Y}"
            else:
                name = f"{report.label} {win.first:%d.%m.%Y} to {win.last:%d.%m.%Y}"
            buf = _render(fmt, name, [(c, c) for c in report.columns], rows,
                          paint=report.paint, legend=report.legend)
        return buf, f"{_file_safe(name)}.{ext}", mime
