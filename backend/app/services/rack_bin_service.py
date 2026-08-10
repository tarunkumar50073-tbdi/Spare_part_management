"""Rack/Bin master business logic. `bins_allocated` is entered by the user
(actual physical bins on the rack) — there is no COV/forecast-based sizing
norm any more (BOM Master/SCM Forecast were removed, so there's no peak
daily requirement to size against)."""
from app.extensions import db
from app.models.rack_bin import RackBin
from app.repositories.rack_bin_repository import RackBinRepository
from app.repositories.part_repository import PartRepository
from app.services.audit_log_service import AuditLogService
from app.services.live_stock_service import LiveStockService
from app.utils.exceptions import NotFoundError, BadRequestError
from app.utils.excel_io import bulk_import, build_template, build_export, to_number, to_text

FIELD_ALIASES = {
    "location": {"location"},
    "rack_no": {"rackno", "rack"},
    "part_no": {"partno", "partnumber"},
    "bin_capacity": {"bincapacity", "capacity"},
    "bins_allocated": {"binsallocated", "bins"},
}
REQUIRED_FIELDS = ["location", "rack_no", "part_no", "bin_capacity"]

TEMPLATE_COLUMNS = ["Location", "Rack No", "Part No", "Bin Capacity", "Bins Allocated"]

EXPORT_COLUMNS = [
    ("Location", "location"), ("Rack No", "rack_no"), ("Part No", "part_no"), ("Part Name", "part_name"),
    ("Bin Capacity", "bin_capacity"), ("Bins Allocated", "bins_allocated"),
]


class RackBinService:
    def __init__(self):
        self.repo = RackBinRepository()
        self.part_repo = PartRepository()
        self.audit_log_service = AuditLogService()

    def list_all(self):
        return [self._enrich(r) for r in self.repo.list_all()]

    def get(self, rack_bin_id):
        row = self.repo.get_by_id(rack_bin_id)
        if not row:
            raise NotFoundError(f"Rack/Bin entry {rack_bin_id} not found")
        return row

    def create(self, data):
        part = self.part_repo.get_by_part_no(data["part_no"])
        if not part:
            raise BadRequestError(f"Unknown part no: {data['part_no']}")
        row = self.repo.create(
            location=data["location"], rack_no=data["rack_no"], part_id=part.id,
            bin_capacity=data["bin_capacity"],
            bins_allocated=data.get("bins_allocated", 0),
        )
        LiveStockService.invalidate_rows_cache()
        return self._enrich(row)

    def update(self, rack_bin_id, data):
        row = self.get(rack_bin_id)
        if "is_blocked" in data and data["is_blocked"] != row.is_blocked:
            self.audit_log_service.log(
                "RACK_CHANGE", "RACK_BIN", row.id, user="STORE",
                remarks=f"{row.location}/{row.rack_no} {'blocked' if data['is_blocked'] else 'unblocked'}",
            )
        row = self.repo.update(row, **data)
        # rack_no shown on Live Stock rows depends on rack/part assignment.
        LiveStockService.invalidate_rows_cache()
        return self._enrich(row)

    def delete(self, rack_bin_id):
        row = self.get(rack_bin_id)
        self.repo.delete(row)
        LiveStockService.invalidate_rows_cache()

    def bulk_import_excel(self, file_stream):
        def row_processor(raw_row):
            location = to_text(raw_row.get("location"))
            rack_no = to_text(raw_row.get("rack_no"))
            part_no = to_text(raw_row.get("part_no"))
            if not location or not rack_no or not part_no:
                raise ValueError("Location, Rack No and Part No are required")

            part = self.part_repo.get_by_part_no(part_no)
            if not part:
                raise ValueError(f"Unknown Part No: {part_no}")

            bin_capacity = to_number(raw_row.get("bin_capacity"))
            if not bin_capacity:
                raise ValueError("Bin Capacity is required")

            db.session.add(RackBin(
                location=location, rack_no=rack_no, part_id=part.id,
                bin_capacity=bin_capacity,
                bins_allocated=int(to_number(raw_row.get("bins_allocated"), 0)),
            ))

        report = bulk_import(file_stream, FIELD_ALIASES, REQUIRED_FIELDS, row_processor)
        LiveStockService.invalidate_rows_cache()
        return report

    @staticmethod
    def build_template():
        return build_template(TEMPLATE_COLUMNS)

    def export_all(self):
        rows = []
        for r in self.repo.list_all():
            rows.append({
                "location": r.location, "rack_no": r.rack_no, "part_no": r.part.part_no,
                "part_name": r.part.part_name, "bin_capacity": float(r.bin_capacity or 0),
                "bins_allocated": r.bins_allocated,
            })
        return build_export(EXPORT_COLUMNS, rows)

    def adjust_occupancy(self, rack_bin_id, bins_delta):
        """DX-side-only occupancy counter — never derived from ERP's stock
        number. Clamped to [0, bins_allocated] since callers pass whole
        bin deltas computed from a specific action (put-away, holding
        transfer, consumption release)."""
        row = self.get(rack_bin_id)
        new_val = max(0, min(row.bins_allocated, row.bins_occupied + bins_delta))
        return self.repo.update(row, bins_occupied=new_val)

    def get_utilization_pct(self):
        """Rack Utilization KPI/chart — bins_occupied as a % of bins_allocated,
        averaged across racks that actually have bins allocated. Physical
        fill rate, not a demand-forecast norm (there's no forecast data)."""
        rows = [r for r in self.list_all() if r["bins_allocated"]]
        if not rows:
            return None
        pct = [min(r["bins_occupied"] / r["bins_allocated"], 1) * 100 for r in rows]
        return round(sum(pct) / len(pct), 1)

    def _enrich(self, row):
        d = row.to_dict()
        d["part_no"] = row.part.part_no
        d["part_name"] = row.part.part_name

        # Real-time occupancy — capacity/occupied/available/status.
        d["available_bins"] = max(row.bins_allocated - row.bins_occupied, 0)
        if row.is_blocked:
            d["rack_status"] = "Blocked"
        elif row.bins_occupied <= 0:
            d["rack_status"] = "Empty"
        elif d["available_bins"] <= 0:
            d["rack_status"] = "Full"
        else:
            d["rack_status"] = "Partial"
        return d
