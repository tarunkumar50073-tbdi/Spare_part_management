"""Seed script: populates baseline reference + demo data for local/dev use.

Run with:  python seed.py
"""
from datetime import datetime, timezone, date, timedelta
from app import create_app
from app.extensions import db
from app.models.supplier import Supplier
from app.models.part import Part
from app.models.finished_good import FinishedGood
from app.models.bom import BOM
from app.models.forecast import CustomerForecast
from app.models.stock_count import DailyStockCount
from app.models.rack_bin import RackBin
from app.services.srv_service import SRVService

app = create_app()

SUPPLIERS = [
    {"vendor_code": "VEN001", "supplier_name": "Sundaram Auto Components", "status": "Active"},
    {"vendor_code": "VEN002", "supplier_name": "Bharat Forge Industries", "status": "Active"},
    {"vendor_code": "VEN003", "supplier_name": "Lucas TVS Pvt Ltd", "status": "Active"},
    {"vendor_code": "VEN004", "supplier_name": "Minda Corporation", "status": "Active"},
]

PARTS = [
    {"part_no": "P-1001", "part_name": "Wiring Harness A", "uom": "PCS", "part_type": "OTHER",
     "min_stock_level": 100, "max_stock_level": 1000, "target_cov_days_min": 2, "target_cov_days_max": 6},
    {"part_no": "P-1002", "part_name": "Seat Foam Pad", "uom": "PCS", "part_type": "DOL",
     "min_stock_level": 50, "max_stock_level": 500, "target_cov_days_min": 1, "target_cov_days_max": 5},
    {"part_no": "P-1003", "part_name": "Door Trim Panel", "uom": "PCS", "part_type": "OTHER",
     "min_stock_level": 80, "max_stock_level": 600, "target_cov_days_min": 1, "target_cov_days_max": 4},
    {"part_no": "P-1004", "part_name": "Headrest Cover", "uom": "PCS", "part_type": "DOL",
     "min_stock_level": 60, "max_stock_level": 400},
    {"part_no": "P-1005", "part_name": "Air Filter Element", "uom": "PCS", "part_type": "OTHER",
     "min_stock_level": 40, "max_stock_level": 300},
    {"part_no": "P-1006", "part_name": "Calibration Gauge Set", "uom": "PCS", "part_type": "TOOL_ROOM",
     "min_stock_level": 10, "max_stock_level": 100},
]

FINISHED_GOODS = [
    {"fg_no": "FG-001", "fg_name": "Sedan Model X"},
    {"fg_no": "FG-002", "fg_name": "SUV Model Y"},
]

# (fg_no, part_no, qty_per_unit)
BOM_LINES = [
    ("FG-001", "P-1001", 2),
    ("FG-001", "P-1002", 1),
    ("FG-002", "P-1001", 1),
    ("FG-002", "P-1003", 1),
]

# (fg_no, base_daily_qty, peak_day_offset, peak_qty) over a 180-day (6-month) horizon
FORECAST_PATTERNS = [
    ("FG-001", 40, 45, 90),
    ("FG-002", 25, 60, 70),
]

# part_no -> today's physical count
STOCK_COUNTS = {"P-1001": 250, "P-1002": 300, "P-1003": 350, "P-1004": 480, "P-1005": 90}

# (location, rack_no, part_no, bin_capacity, bins_allocated)
RACK_BINS = [
    ("A1", "R1", "P-1001", 100, 5),
    ("A1", "R2", "P-1002", 50, 6),
    ("A2", "R1", "P-1003", 60, 4),
]

# (vendor_code, part_no, qty_invoiced, qty_received, target_stage)
# target_stage drives how far seed_srvs() walks each demo SRV through the
# workflow, so the app boots with examples at several different stages.
DEMO_SRVS = [
    ("VEN001", "P-1001", 150, 150, "CONSUMED"),
    ("VEN002", "P-1002", 300, 300, "TRANSFERRED"),
    ("VEN001", "P-1003", 200, 150, "INSPECTION_PENDING"),
    ("VEN003", "P-1004", 500, None, "PENDING_UNLOAD"),
    ("VEN002", "P-1005", 250, 250, "RETURNED_TO_SUPPLIER"),
    ("VEN004", "P-1001", 400, None, "UNLOADED"),
    ("VEN003", "P-1006", 20, 20, "INSPECTION_PENDING"),
]


def seed_suppliers():
    for s in SUPPLIERS:
        if not Supplier.query.filter_by(vendor_code=s["vendor_code"]).first():
            db.session.add(Supplier(**s))
    db.session.commit()


def seed_parts():
    for p in PARTS:
        if not Part.query.filter_by(part_no=p["part_no"]).first():
            db.session.add(Part(**p))
    db.session.commit()


def seed_srvs():
    service = SRVService()
    now = datetime.now(timezone.utc)
    for vendor_code, part_no, qty_invoiced, qty_received, target_stage in DEMO_SRVS:
        part = Part.query.filter_by(part_no=part_no).first()
        already_seeded = service.repo.model.query.filter_by(
            vendor_code=vendor_code, part_id=part.id
        ).first()
        if already_seeded:
            continue

        # qc_required mirrors the part's own classification for demo variety
        # only — in the real flow this always comes from ERP, never from
        # the part's DOL/OTHER/TOOL_ROOM type.
        qc_required = part.part_type != "DOL"

        srvs = service.ingest_gate_entry({
            "vendor_code": vendor_code,
            "invoice_no": f"INV-{vendor_code}-{part_no}",
            "gate_entry_time": now,
            "lines": [{"part_no": part_no, "qty_invoiced": qty_invoiced, "qc_required": qc_required}],
        })
        srv = srvs[0]
        if target_stage == "PENDING_UNLOAD":
            continue

        srv = service.unload(srv.id)
        if target_stage == "UNLOADED":
            continue

        srv = service.verify(srv.id, qty_received)
        # ERP mints the SRV number — seed script stands in for that inbound push.
        srv_no = f"SRV{now.strftime('%y%m%d')}-{srv.id:04d}"
        srv = service.create_srv(srv.id, srv_no)  # auto-routes (qc_required) and starts put-away in one call
        if target_stage == "INSPECTION_PENDING":
            continue

        if srv.status == "INSPECTION_PENDING":
            if target_stage == "RETURNED_TO_SUPPLIER":
                service.inspect(srv.id, "Rejected", rejection_reason="Damaged packaging")
                continue
            srv = service.inspect(srv.id, "Approved")
        # Transfer to Part Store is chained automatically as soon as
        # material reaches STORED (see SRVService._receive_into_store) —
        # srv.status is already TRANSFERRED by this point, no separate call.
        if target_stage in ("STORED", "TRANSFERRED"):
            continue

        if target_stage == "CONSUMED":
            service.confirm_consumption(srv.id)  # single ERP Production Punch call — no manual supply step


def seed_finished_goods():
    for fg in FINISHED_GOODS:
        if not FinishedGood.query.filter_by(fg_no=fg["fg_no"]).first():
            db.session.add(FinishedGood(**fg))
    db.session.commit()


def seed_bom():
    for fg_no, part_no, qty_per_unit in BOM_LINES:
        fg = FinishedGood.query.filter_by(fg_no=fg_no).first()
        part = Part.query.filter_by(part_no=part_no).first()
        if not BOM.query.filter_by(finished_good_id=fg.id, child_part_id=part.id).first():
            db.session.add(BOM(finished_good_id=fg.id, child_part_id=part.id, qty_per_unit=qty_per_unit))
    db.session.commit()


def seed_forecast():
    if CustomerForecast.query.first():
        return
    today = date.today()
    for fg_no, base_qty, peak_day_offset, peak_qty in FORECAST_PATTERNS:
        fg = FinishedGood.query.filter_by(fg_no=fg_no).first()
        for i in range(180):
            d = today + timedelta(days=i)
            qty = peak_qty if i == peak_day_offset else base_qty
            db.session.add(CustomerForecast(finished_good_id=fg.id, forecast_date=d, qty=qty, source="EXCEL"))
    db.session.commit()


def seed_stock_counts():
    if DailyStockCount.query.first():
        return
    today = date.today()
    for part_no, qty in STOCK_COUNTS.items():
        part = Part.query.filter_by(part_no=part_no).first()
        db.session.add(DailyStockCount(part_id=part.id, count_date=today, counted_qty=qty))
    db.session.commit()


def seed_rack_bins():
    if RackBin.query.first():
        return
    for location, rack_no, part_no, bin_capacity, bins_allocated in RACK_BINS:
        part = Part.query.filter_by(part_no=part_no).first()
        db.session.add(RackBin(
            location=location, rack_no=rack_no, part_id=part.id,
            bin_capacity=bin_capacity, bins_allocated=bins_allocated,
        ))
    db.session.commit()


def run():
    with app.app_context():
        seed_suppliers()
        seed_parts()
        seed_srvs()
        seed_finished_goods()
        seed_bom()
        seed_forecast()
        seed_stock_counts()
        seed_rack_bins()
        print("Seed data inserted successfully.")


if __name__ == "__main__":
    run()
