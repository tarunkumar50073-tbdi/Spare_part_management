"""Reports module — SRV, Verification, Pending RQC, Put Away, Rack Stock,
Live Stock and Supplier reports, each exportable as Excel (reusing
excel_io.build_export) or PDF (reusing utils/pdf_io.build_pdf_table) from
the same (columns, rows) pair."""
from sqlalchemy import func
from app.extensions import db
from app.models.srv import SRV
from app.models.rack_bin import RackBin
from app.repositories.srv_repository import SRVRepository
from app.repositories.rack_bin_repository import RackBinRepository
from app.repositories.supplier_repository import SupplierRepository
from app.services.store_stock_service import StoreStockService
from app.services.quarterly_inventory_service import QuarterlyInventoryService
from app.services.live_stock_service import LiveStockService
from app.utils.excel_io import build_export, build_csv
from app.utils.pdf_io import build_pdf_table
from app.utils.exceptions import BadRequestError


class ReportService:
    def __init__(self):
        self.srv_repo = SRVRepository()
        self.rack_bin_repo = RackBinRepository()
        self.supplier_repo = SupplierRepository()
        self.store_stock_service = StoreStockService()
        self.qty_inv_service = QuarterlyInventoryService()
        self.live_stock_service = LiveStockService()

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
