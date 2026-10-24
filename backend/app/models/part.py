"""Part (material) master model — drives SRV routing and stock thresholds."""
from app.extensions import db
from app.models.base import BaseModel

CATEGORIES = ["BOP", "Import", "Maintenance/Tool Room", "Consumable", "In-Parts"]


class Part(BaseModel):
    __tablename__ = "parts"

    part_no = db.Column(db.String(30), unique=True, nullable=False, index=True)
    part_name = db.Column(db.String(150), nullable=False)
    uom = db.Column(db.String(10), nullable=False, default="PCS")

    # Barcode/QR value scanned at verification — falls back to part_no at
    # scan-match time when blank, so parts without a distinct barcode label
    # still scan correctly off their part number.
    barcode = db.Column(db.String(60), unique=True, nullable=True, index=True)

    # Default Material Routing target (DOL = Store Location direct,
    # OTHER = RQC Inspection (BOP), TOOL_ROOM = forwarded to the tool
    # room / maintenance department) — overridable per SRV at the routing step.
    part_type = db.Column(db.String(10), nullable=False, default="OTHER")

    min_stock_level = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    max_stock_level = db.Column(db.Numeric(12, 2), nullable=True)
    # The reorder point — order when stock reaches this, between min and max.
    # Nullable: a part may have no reorder trigger set.
    reorder_level = db.Column(db.Numeric(12, 2), nullable=True)
    is_active = db.Column(db.Boolean, nullable=False, default=True)
    # Not required any more / discontinued (the store, 22 Oct 2026: Tool Room
    # parts with no minimum "future me required nhi h ya discontinue ho chuke
    # h"). Unlike inactive, the part and its stock stay in every list and in the
    # stock value — the material is still on the shelf — but its status is
    # "Discontinued": never Out of Stock / Below Minimum / Reorder, never in a
    # reorder mail, never counted as missing a min / max / reorder level.
    discontinued = db.Column(db.Boolean, nullable=False, default=False)

    # COV (Cover Days) planning — Short/Excess is judged against these.
    # target_cov_days_min default 1 matches "Coverage < 1 Day = Short";
    # target_cov_days_max falls back to COVService.DEFAULT_EXCESS_COV_DAYS
    # (5) when unset, matching "1-5 Days = Normal".
    target_cov_days_min = db.Column(db.Numeric(6, 2), nullable=False, default=1)
    target_cov_days_max = db.Column(db.Numeric(6, 2), nullable=True)
    bin_capacity = db.Column(db.Numeric(12, 2), nullable=True)

    # Which store this part physically belongs to, and which area within it.
    # A different axis from `category` below: category says what kind of part
    # it is, store says where it lives. Overloading category with both is why
    # a maintenance spare had nowhere to record that it is also a Consumable.
    store_code = db.Column(db.String(30), db.ForeignKey("stores.code"), nullable=True, index=True)
    section_id = db.Column(db.Integer, db.ForeignKey("sections.id"), nullable=True, index=True)

    # Where the part sits, as the spares sheets record it ("R4-S1-B1 (1)").
    # Deliberately on the part rather than as RackBin rows: a spare has one
    # fixed home, not a shared rack with a capacity to plan against, and
    # putting 485 press-shop bins into RackBin would silently move the Child
    # Parts dashboard's rack-utilisation figures.
    # rework_location is the second shelf a part goes to when it is pulled for
    # rework — real for about a fifth of the press-shop list.
    location = db.Column(db.String(60), nullable=True)
    rework_location = db.Column(db.String(60), nullable=True)

    # Sourcing classification (BOP/Import/Maintenance-Tool Room/Consumable/
    # In-Parts) — a different axis from part_type (routing target);
    # Excel-uploadable via Part Master. sub_category is free text nested
    # under category (e.g. category=BOP, sub_category=SOB/Seat Parts/...).
    category = db.Column(db.String(30), nullable=True)
    sub_category = db.Column(db.String(50), nullable=True)
    # Free-text technical specification of the part (e.g. "SMPS 230VAC O/P
    # DC12VDC 3A"). Shown on the drawer and searchable; Excel-uploadable.
    specification = db.Column(db.String(255), nullable=True)
    # The part's model no. as its maker prints it (e.g. "XVC1B3HK") — a column
    # of the Part Master list since 21 Oct 2026; searchable, Excel-uploadable.
    model_no = db.Column(db.String(60), nullable=True)
    # The part's one photo: a file in the part-images folder, never the DB. A
    # new photo gets a new name, so the URL carrying it is never served stale
    # from a browser cache (services/part_image_service.py).
    image_file = db.Column(db.String(80), nullable=True)

    new_part_no = db.Column(db.String(30), nullable=True)
    old_part_no = db.Column(db.String(30), nullable=True)
    package_standard = db.Column(db.Numeric(12, 2), nullable=True)  # qty per pack
    supplier_id = db.Column(db.Integer, db.ForeignKey("suppliers.id"), nullable=True)

    # Coverage Day inputs (see COVService) — both Excel-uploaded for now,
    # ERP API push later, same swap-later pattern as everywhere else.
    daily_consumption = db.Column(db.Numeric(12, 2), nullable=True)
    unit_price = db.Column(db.Numeric(12, 2), nullable=True)  # for Quarterly Inventory gap value

    # Rack / coverage planning fields from the BOP bin-stock sheet
    # ("NEW BOP PART SHEET"), Excel-uploaded per the child part master.
    no_of_row = db.Column(db.Numeric(10, 2), nullable=True)
    no_of_pallet = db.Column(db.Numeric(10, 2), nullable=True)
    store_rack_capacity = db.Column(db.Numeric(14, 2), nullable=True)      # bin qty per store rack
    total_store_rack_qty = db.Column(db.Numeric(14, 2), nullable=True)     # capacity * rows
    monthly_peak_schedule_qty = db.Column(db.Numeric(14, 2), nullable=True)
    reck_covg_days = db.Column(db.Numeric(10, 2), nullable=True)           # rack coverage = total rack qty / per-day peak

    # Set/cleared by COVService.refresh_since_tracking() whenever a Daily
    # Stock Count submission changes this part's status — powers "Short
    # Since"/"Excess Since"/"Days In Excess" without a scheduled job.
    short_since = db.Column(db.DateTime(timezone=True), nullable=True)
    excess_since = db.Column(db.DateTime(timezone=True), nullable=True)

    supplier = db.relationship("Supplier")
    store = db.relationship("Store")
    section = db.relationship("Section")

    __table_args__ = (
        db.CheckConstraint("part_type IN ('DOL','OTHER','TOOL_ROOM')", name="ck_part_type"),
        db.CheckConstraint(f"category IS NULL OR category IN ({','.join(repr(c) for c in CATEGORIES)})", name="ck_part_category"),
        # Every stock list filters (store_code, is_active) and sorts by part_no.
        db.Index("ix_parts_store_active_no", "store_code", "is_active", "part_no"),
    )

    def __repr__(self):
        return f"<Part {self.part_no} {self.part_name}>"
