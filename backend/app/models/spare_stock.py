"""On-hand quantity for spares, plus the movement ledger behind it.

Deliberately its own pair of tables rather than a widening of PartStock /
StockLedger. Those two are built around the child-part receiving flow: their
location CHECK admits only RECEIVING_STORE and PART_STORE, and StockLedger
carries srv_id, production_receipt_id, source_type (BUY/MAKE) and ext_ref for
ERP dedupe — none of which a maintenance spare has. Widening the constraint
would also have made every existing query that reads PartStock store-aware,
and those queries feed the Child Parts dashboard; that is exactly how loading
the spares list once turned "Total Active Parts" from 253 into 738.

A spare has one number: how many are on the shelf. There is no receiving-store
half to move it from, so there is no location column here at all.
"""
from app.extensions import db
from app.models.base import BaseModel

# Why a quantity changed. OPENING is the first load from a physical count;
# ADJUSTMENT is a correction to that; RECEIPT adds new stock; ISSUE draws it to
# a department/machine; RETURN brings a returnable tool/die back to the shelf.
TXN_TYPES = ("OPENING", "RECEIPT", "ISSUE", "RETURN", "ADJUSTMENT")

# Two-stage issue lifecycle: the store issues to a department + person (Stage 1,
# no machine known yet), then the user who fits the part confirms the line +
# machine + installation by re-scanning (Stage 2).
ISSUE_STATUSES = (
    "ISSUED_BY_STORE", "PENDING_USER_CONFIRMATION", "PARTIALLY_USED",
    "INSTALLED", "RETURNED", "CANCELLED",
)
# Spare receiving lifecycle — deliberately no RQC and no Pending-Put-Away.
RECEIVE_STATUSES = (
    "PHYSICALLY_RECEIVED", "PENDING_SRV_GRN", "PENDING_DEPARTMENT_CLEARANCE",
    "ERP_STOCK_UPDATED", "IMMEDIATELY_ISSUED", "MOVED_TO_STORE_LOCATION",
    "REJECTED_OR_HOLD",
)
# Physical-check result the store supervisor records against the invoice.
CHECK_RESULTS = ("OK", "SHORT", "EXCESS", "DAMAGED")


class SpareStock(BaseModel):
    __tablename__ = "spare_stock"

    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, unique=True, index=True)

    # Maintained on every movement rather than summed from the ledger on read.
    # A spares store is read far more often than it moves — every dashboard
    # load would otherwise aggregate the whole ledger to draw one KPI.
    qty_on_hand = db.Column(db.Numeric(12, 2), nullable=False, default=0)

    # When a human last physically counted this shelf, as distinct from when
    # the row was last written — an issue changes the quantity without anyone
    # having recounted anything.
    last_counted_at = db.Column(db.DateTime(timezone=True), nullable=True)

    part = db.relationship("Part")

    def __repr__(self):
        return f"<SpareStock part={self.part_id} qty={self.qty_on_hand}>"


class SpareStockLedger(BaseModel):
    __tablename__ = "spare_stock_ledger"

    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)
    qty_delta = db.Column(db.Numeric(12, 2), nullable=False)  # positive = in, negative = out

    # The resulting balance, stored rather than recomputed: it is what makes a
    # single row explain itself months later without replaying everything
    # before it.
    balance_after = db.Column(db.Numeric(12, 2), nullable=False)

    txn_type = db.Column(db.String(20), nullable=False, index=True)
    reference = db.Column(db.String(80), nullable=True)  # GRN/invoice/work order
    remarks = db.Column(db.String(255), nullable=True)
    created_by = db.Column(db.String(60), nullable=True)

    # Which shop-floor department drew the part — set on ISSUE so consumption
    # can be split (Press Shop / Maintenance / Tool Room). NULL for opening,
    # receipt and adjustment rows, which have no consuming department.
    department = db.Column(db.String(40), nullable=True, index=True)

    # Which machine the part was fitted on — set on ISSUE, typed by the person
    # drawing it (a sensor/cylinder can go on any machine, so it can't be
    # derived from the part). Feeds machine-wise consumption. NULL otherwise.
    machine = db.Column(db.String(60), nullable=True, index=True)

    # Returnable tooling (a die/tool expected back), set on ISSUE. The issue
    # stays "outstanding" until a RETURN row points back to it.
    returnable = db.Column(db.Boolean, nullable=False, default=False)

    # On a RETURN row: the ISSUE ledger row it closes out.
    return_of_id = db.Column(db.Integer, db.ForeignKey("spare_stock_ledger.id"), nullable=True, index=True)

    # When this movement was pushed to ERP. NULL = pending — it waits here until
    # the ERP endpoint is live and a sync runs. Once ERP_API_BASE_URL is set,
    # syncing the backlog fills these in; nothing is lost while ERP is offline.
    erp_pushed_at = db.Column(db.DateTime(timezone=True), nullable=True, index=True)

    # ---- two-stage issue (Stage 1 store -> Stage 2 user at the line) ----
    # Stage 1: which person the store handed the part to. Set on ISSUE.
    issued_to = db.Column(db.String(80), nullable=True)
    # Lifecycle status of an ISSUE (ISSUE_STATUSES) or RECEIPT (RECEIVE_STATUSES)
    # row. NULL on legacy rows and on OPENING/RETURN/ADJUSTMENT. Validated in the
    # service, not by a DB CHECK (it holds two disjoint sets by txn_type, and an
    # ALTER-added column can't carry the same CHECK a fresh create_all would).
    status = db.Column(db.String(30), nullable=True, index=True)
    # Stage 2: where the user actually fitted the part — production line + machine.
    line_name = db.Column(db.String(60), nullable=True)   # e.g. Seat Slider / Recliner
    line_no = db.Column(db.String(30), nullable=True)
    actual_qty = db.Column(db.Numeric(12, 2), nullable=True)  # actually used (Stage 2)
    confirmed_by = db.Column(db.String(60), nullable=True)
    confirmed_at = db.Column(db.DateTime(timezone=True), nullable=True)

    # ---- structured receiving (RECEIPT rows) ----
    supplier_id = db.Column(db.Integer, db.ForeignKey("suppliers.id"), nullable=True)
    invoice_no = db.Column(db.String(60), nullable=True)
    invoice_date = db.Column(db.Date, nullable=True)
    check_result = db.Column(db.String(20), nullable=True)  # OK / SHORT / EXCESS / DAMAGED

    part = db.relationship("Part")
    supplier = db.relationship("Supplier")

    __table_args__ = (
        db.CheckConstraint(
            f"txn_type IN ({','.join(repr(t) for t in TXN_TYPES)})",
            name="ck_spare_stock_ledger_txn_type",
        ),
    )

    def __repr__(self):
        return f"<SpareStockLedger part={self.part_id} {self.txn_type} {self.qty_delta}>"
