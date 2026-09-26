"""QR traceability documents for the Spare Parts Store.

``spare_stock.qty_on_hand`` stays what ~30 readers already take it to mean:
STOCK AVAILABLE — issuable, on the rack. Material the store holds but may NOT
issue lives on its own documents here, never in that number:

* ``SpareReceipt``  — supplier material physically received, waiting for the
  supervisor's ERP GRN and the Maintenance / Tool Room quality clearance. Only
  the clearance adds the accepted qty to available (as a RECEIPT ledger row).
* ``SpareReturn``   — a part a department sent back against its ORIGINAL issue.
  It waits for the store inspection; only GOOD adds it back to available (as a
  RETURN ledger row). The rest is held (inspection required), damaged, scrapped
  or sent to a supplier for rework.
* ``SpareRgp``      — supplier rework (RGP OUT - REWORK). Always drawn from a
  return held in the store (there is no direct RGP); with the supplier it is not
  stock; the supplier return waits for the RGP GRN, which adds it back.

``SpareTransaction`` is the append-only journal behind the part history and the
audit trail (spec 21/23/24): one row per business event with previous / new
status, the bucket it moved from / to, and department / line / machine / die /
supplier / RGP no / GRN no / return reason. Rows are never updated or deleted —
a mistake is corrected by a CANCEL row, never by rewriting history.

The QR label carries only the Part No., so every document is keyed by part and
a scan lists the part's open documents; nothing dynamic is ever in the QR.
Validation of the status / type values lives in the services (no DB CHECK), so
a later value is a code change, not a SQLite table rebuild.
"""
from sqlalchemy import event

from app.extensions import db
from app.models.base import BaseModel

# ---- journal ----------------------------------------------------------------
# Spec 23 transaction types, plus INSTALLATION (the line / machine / die update
# after an issue, spec 11/12), RETURN_INSPECTION (spec 14) and CANCEL (a
# correction). There is deliberately NO DIRECT_RGP.
TXN_TYPES = (
    "RECEIVE", "GRN", "QUALITY_CLEARANCE", "ISSUE", "INSTALLATION",
    "RETURN_TO_STORE", "RETURN_INSPECTION", "RGP_OUT", "RGP_RETURN", "RGP_GRN",
    "STOCK_ADJUSTMENT", "CANCEL",
)

# Where a quantity sits. AVAILABLE is spare_stock.qty_on_hand; every other
# bucket is the sum of open documents. SUPPLIER / CONSUMED / SCRAPPED / REJECTED
# are the outside world (where material comes from or ends).
BUCKETS = (
    "SUPPLIER", "QUALITY_PENDING", "AVAILABLE", "ISSUED", "RETURN_PENDING",
    "RETURN_HOLD", "DAMAGED", "WITH_SUPPLIER", "RGP_GRN_PENDING",
    "SCRAPPED", "REJECTED", "CANCELLED",
)

# ---- receipts (spec 1 / 9) ----------------------------------------------------
# RECEIVED -> (supervisor records the ERP GRN) QUALITY_PENDING -> (Maintenance /
# Tool Room clearance) STOCK_AVAILABLE | REJECTED. CANCELLED only before a GRN.
RECEIPT_STATUSES = ("RECEIVED", "QUALITY_PENDING", "STOCK_AVAILABLE", "REJECTED", "CANCELLED")
RECEIPT_OPEN = ("RECEIVED", "QUALITY_PENDING")

# ---- returns (spec 13 / 14) ---------------------------------------------------
# Store inspection results.
INSPECTION_RESULTS = ("GOOD", "INSPECTION_REQUIRED", "DAMAGED", "SCRAP")
# Cached headline of a return from its quantity split (see SpareReturn).
RETURN_STATUSES = ("INSPECTION_PENDING", "RETURN_HOLD", "DAMAGED", "CLOSED")
RETURN_OPEN = ("INSPECTION_PENDING", "RETURN_HOLD", "DAMAGED")

# ---- RGP (spec 15-19) --------------------------------------------------------
RGP_STATUSES = ("WITH_SUPPLIER", "RGP_GRN_PENDING", "CLOSED", "CANCELLED")
RGP_OPEN = ("WITH_SUPPLIER", "RGP_GRN_PENDING")
# Where a supplier name came from — a vendor code is never typed or invented.
SUPPLIER_SOURCES = ("GATE_ENTRY", "ERP_GRN", "SUPPLIER_MASTER", "NAME_ONLY")


class SpareReceipt(BaseModel):
    """Supplier material received into the Spare Parts Store (spec 1 / 9).

    Printing a QR never touches this row: a label adds no stock, completes no
    GRN and clears no quality (spec 9)."""
    __tablename__ = "spare_receipts"

    receipt_no = db.Column(db.String(30), nullable=False, unique=True, index=True)  # RCV-YYYYMMDD-NNN
    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)
    store_code = db.Column(db.String(30), nullable=False, index=True)
    status = db.Column(db.String(20), nullable=False, default="RECEIVED", index=True)

    qty_received = db.Column(db.Numeric(12, 2), nullable=False)
    qty_accepted = db.Column(db.Numeric(12, 2), nullable=True)   # set at quality clearance
    qty_rejected = db.Column(db.Numeric(12, 2), nullable=True)

    # Supplier — an ERP vendor (gate entry / GRN) or the app supplier master.
    supplier_id = db.Column(db.Integer, db.ForeignKey("suppliers.id"), nullable=True)
    ven_cd = db.Column(db.String(30), nullable=True)
    ven_name = db.Column(db.String(160), nullable=True)
    supplier_source = db.Column(db.String(20), nullable=True)

    # Step 2 — the supervisor checks Part No + Quantity + Invoice.
    invoice_no = db.Column(db.String(60), nullable=True)
    invoice_date = db.Column(db.Date, nullable=True)
    check_result = db.Column(db.String(20), nullable=True)  # OK / SHORT / EXCESS / DAMAGED
    received_by = db.Column(db.String(60), nullable=True)
    remarks = db.Column(db.String(255), nullable=True)

    # Step 5 — the GRN the supervisor created in ERP (typed here; ERP stays read-only).
    grn_no = db.Column(db.String(40), nullable=True, index=True)
    grn_date = db.Column(db.Date, nullable=True)
    grn_recorded_by = db.Column(db.String(60), nullable=True)
    grn_recorded_at = db.Column(db.DateTime(timezone=True), nullable=True)
    # Step 6/7 — which department inspects it (Maintenance / Tool Room).
    quality_by = db.Column(db.String(40), nullable=True)

    # Step 8 — quality clearance.
    cleared_by = db.Column(db.String(60), nullable=True)
    cleared_at = db.Column(db.DateTime(timezone=True), nullable=True)
    quality_remarks = db.Column(db.String(255), nullable=True)
    # The RECEIPT ledger row that put the accepted qty into available stock.
    ledger_id = db.Column(db.Integer, db.ForeignKey("spare_stock_ledger.id"), nullable=True)

    # How the part was identified when it was received.
    scanned_code = db.Column(db.String(80), nullable=True)
    scan_source = db.Column(db.String(20), nullable=True)

    cancelled_by = db.Column(db.String(60), nullable=True)
    cancelled_at = db.Column(db.DateTime(timezone=True), nullable=True)
    cancel_reason = db.Column(db.String(255), nullable=True)

    part = db.relationship("Part")
    supplier = db.relationship("Supplier")

    __table_args__ = (
        db.Index("ix_spare_receipts_part_status", "part_id", "status"),
    )


class SpareReturn(BaseModel):
    """A part sent back to the store against its ORIGINAL issue (spec 13), and
    the store inspection that decides where it goes (spec 14).

    Quantity split — always qty = pending + hold + damaged + good + scrap + rgp:
      qty_pending  returned, not inspected yet (not available)
      qty_hold     inspected "Inspection Required" (not available)
      qty_damaged  inspected "Damaged" (not available; may go on RGP or scrap)
      qty_good     inspected "Good / Reusable" -> back in available stock
      qty_scrap    scrapped (disposal)
      qty_rgp      sent to a supplier for rework (see SpareRgp)
    """
    __tablename__ = "spare_returns"

    return_no = db.Column(db.String(40), nullable=False, unique=True, index=True)  # RET-YYYYMMDD-NNN
    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)
    store_code = db.Column(db.String(30), nullable=False, index=True)
    # The ISSUE ledger row this return is recorded against (never a free receipt).
    issue_id = db.Column(db.Integer, db.ForeignKey("spare_stock_ledger.id"), nullable=False, index=True)
    status = db.Column(db.String(20), nullable=False, default="INSPECTION_PENDING", index=True)

    qty = db.Column(db.Numeric(12, 2), nullable=False)
    qty_pending = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    qty_hold = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    qty_damaged = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    qty_good = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    qty_scrap = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    qty_rgp = db.Column(db.Numeric(12, 2), nullable=False, default=0)

    reason = db.Column(db.String(60), nullable=True)
    remarks = db.Column(db.String(255), nullable=True)
    returned_by = db.Column(db.String(80), nullable=True)   # person from the department
    received_by = db.Column(db.String(60), nullable=True)   # store user who took it back
    # Copied from the issue so the return reads on its own (spec 13 screen).
    department = db.Column(db.String(40), nullable=True)
    issued_to = db.Column(db.String(80), nullable=True)
    line_name = db.Column(db.String(60), nullable=True)
    line_no = db.Column(db.String(30), nullable=True)
    machine = db.Column(db.String(60), nullable=True)
    die_no = db.Column(db.String(60), nullable=True)

    last_inspected_by = db.Column(db.String(60), nullable=True)
    last_inspected_at = db.Column(db.DateTime(timezone=True), nullable=True)

    scanned_code = db.Column(db.String(80), nullable=True)
    scan_source = db.Column(db.String(20), nullable=True)

    part = db.relationship("Part")
    issue = db.relationship("SpareStockLedger", foreign_keys=[issue_id])

    __table_args__ = (
        db.Index("ix_spare_returns_part_status", "part_id", "status"),
    )

    # Bucket name -> column, for the moves the return / RGP services make.
    BUCKET_COLUMNS = {
        "RETURN_PENDING": "qty_pending", "RETURN_HOLD": "qty_hold", "DAMAGED": "qty_damaged",
        "AVAILABLE": "qty_good", "SCRAPPED": "qty_scrap", "WITH_SUPPLIER": "qty_rgp",
    }

    def q(self, column):
        return float(getattr(self, column) or 0)

    def refresh_status(self):
        """Headline from the quantity split (the one rule every service uses)."""
        if self.q("qty_pending") > 0:
            self.status = "INSPECTION_PENDING"
        elif self.q("qty_hold") > 0:
            self.status = "RETURN_HOLD"
        elif self.q("qty_damaged") > 0:
            self.status = "DAMAGED"
        else:
            self.status = "CLOSED"
        return self.status


class SpareRgp(BaseModel):
    """Supplier rework under an RGP (Returnable Gate Pass) — spec 15-19.

    Drawn only from a return held in the store (source_return_id), never from
    fresh stock: there is no direct RGP. While with the supplier the quantity is
    not stock; the supplier return waits for the RGP GRN (recorded here with the
    GRN no the supervisor created in ERP), which adds it back to available.
    Quantities: with supplier = qty_out - qty_returned; RGP GRN pending =
    qty_returned - qty_grn."""
    __tablename__ = "spare_rgps"

    rgp_no = db.Column(db.String(30), nullable=False, unique=True, index=True)  # RGP-YYYY-NNNNN
    erp_challan_no = db.Column(db.String(40), nullable=True, index=True)   # the ERP RGP challan, if typed
    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)
    store_code = db.Column(db.String(30), nullable=False, index=True)
    source_return_id = db.Column(db.Integer, db.ForeignKey("spare_returns.id"), nullable=False, index=True)
    source_bucket = db.Column(db.String(20), nullable=True)   # RETURN_HOLD / DAMAGED
    status = db.Column(db.String(20), nullable=False, default="WITH_SUPPLIER", index=True)

    supplier_id = db.Column(db.Integer, db.ForeignKey("suppliers.id"), nullable=True)
    ven_cd = db.Column(db.String(30), nullable=True)
    ven_name = db.Column(db.String(160), nullable=False)
    supplier_source = db.Column(db.String(20), nullable=True)

    qty_out = db.Column(db.Numeric(12, 2), nullable=False)
    qty_returned = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    qty_grn = db.Column(db.Numeric(12, 2), nullable=False, default=0)

    rework_reason = db.Column(db.String(120), nullable=False)
    remarks = db.Column(db.String(255), nullable=True)
    rgp_date = db.Column(db.Date, nullable=False)
    expected_return_date = db.Column(db.Date, nullable=True)
    out_by = db.Column(db.String(60), nullable=True)

    supplier_returned_at = db.Column(db.DateTime(timezone=True), nullable=True)
    supplier_returned_by = db.Column(db.String(60), nullable=True)

    grn_no = db.Column(db.String(40), nullable=True, index=True)
    grn_date = db.Column(db.Date, nullable=True)
    grn_at = db.Column(db.DateTime(timezone=True), nullable=True)
    grn_by = db.Column(db.String(60), nullable=True)

    cancelled_by = db.Column(db.String(60), nullable=True)
    cancelled_at = db.Column(db.DateTime(timezone=True), nullable=True)
    cancel_reason = db.Column(db.String(255), nullable=True)

    part = db.relationship("Part")
    supplier = db.relationship("Supplier")
    source_return = db.relationship("SpareReturn")

    __table_args__ = (
        db.Index("ix_spare_rgps_part_status", "part_id", "status"),
    )

    @property
    def qty_with_supplier(self):
        if self.status == "CANCELLED":
            return 0.0
        return round(float(self.qty_out or 0) - float(self.qty_returned or 0), 2)

    @property
    def qty_grn_pending(self):
        if self.status == "CANCELLED":
            return 0.0
        return round(float(self.qty_returned or 0) - float(self.qty_grn or 0), 2)

    def refresh_status(self):
        """CLOSED once everything sent is back in stock; RGP_GRN_PENDING while a
        supplier return waits for its GRN; otherwise WITH_SUPPLIER. CANCELLED is
        terminal and never recomputed."""
        if self.status == "CANCELLED":
            return self.status
        if float(self.qty_grn or 0) >= float(self.qty_out or 0):
            self.status = "CLOSED"
        elif self.qty_grn_pending > 0:
            self.status = "RGP_GRN_PENDING"
        else:
            self.status = "WITH_SUPPLIER"
        return self.status


class SpareTransaction(BaseModel):
    """Append-only journal: one row per business event on a spare (spec 21/23/24).

    Never updated, never deleted. ``ledger_id`` points at the spare_stock_ledger
    row when the event changed AVAILABLE stock (quality clearance, issue, GOOD
    inspection, RGP GRN); status-only events (GRN, RGP return, ...) have none."""
    __tablename__ = "spare_transactions"

    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)
    store_code = db.Column(db.String(30), nullable=True, index=True)
    txn_type = db.Column(db.String(24), nullable=False, index=True)
    qty = db.Column(db.Numeric(12, 2), nullable=True)

    prev_status = db.Column(db.String(30), nullable=True)
    new_status = db.Column(db.String(30), nullable=True)
    from_bucket = db.Column(db.String(20), nullable=True)
    to_bucket = db.Column(db.String(20), nullable=True)

    # Documents this event belongs to.
    receipt_id = db.Column(db.Integer, db.ForeignKey("spare_receipts.id"), nullable=True, index=True)
    return_id = db.Column(db.Integer, db.ForeignKey("spare_returns.id"), nullable=True, index=True)
    rgp_id = db.Column(db.Integer, db.ForeignKey("spare_rgps.id"), nullable=True, index=True)
    issue_id = db.Column(db.Integer, db.ForeignKey("spare_stock_ledger.id"), nullable=True, index=True)
    ledger_id = db.Column(db.Integer, db.ForeignKey("spare_stock_ledger.id"), nullable=True, index=True)

    # Spec 24 audit fields.
    department = db.Column(db.String(40), nullable=True)
    issued_to = db.Column(db.String(80), nullable=True)
    employee_id = db.Column(db.Integer, db.ForeignKey("employees.id"), nullable=True, index=True)
    issued_to_mobile = db.Column(db.String(10), nullable=True)
    issued_to_code = db.Column(db.String(30), nullable=True)
    line_name = db.Column(db.String(60), nullable=True)
    line_no = db.Column(db.String(30), nullable=True)
    machine = db.Column(db.String(60), nullable=True)
    die_no = db.Column(db.String(60), nullable=True)
    supplier_name = db.Column(db.String(160), nullable=True)
    ven_cd = db.Column(db.String(30), nullable=True)
    rgp_no = db.Column(db.String(30), nullable=True)
    grn_no = db.Column(db.String(40), nullable=True)
    invoice_no = db.Column(db.String(60), nullable=True)
    return_reason = db.Column(db.String(60), nullable=True)
    inspection_result = db.Column(db.String(24), nullable=True)
    remarks = db.Column(db.String(255), nullable=True)

    # How the operator reached the part (spec 24: QR scan date/time + user).
    scanned_code = db.Column(db.String(80), nullable=True)
    scan_source = db.Column(db.String(20), nullable=True)
    created_by = db.Column(db.String(60), nullable=True)

    part = db.relationship("Part")

    __table_args__ = (
        db.Index("ix_spare_transactions_part_created", "part_id", "created_at"),
    )


class AppendOnlyError(RuntimeError):
    """Raised on any attempt to change or remove a journal row."""


@event.listens_for(SpareTransaction, "before_update")
def _journal_no_update(mapper, connection, target):
    raise AppendOnlyError("spare_transactions is append-only; record a CANCEL instead")


@event.listens_for(SpareTransaction, "before_delete")
def _journal_no_delete(mapper, connection, target):
    raise AppendOnlyError("spare_transactions is append-only; record a CANCEL instead")
