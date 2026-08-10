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
# ADJUSTMENT is a correction to that; RECEIPT and ISSUE are written by the
# issue/receipt flow that comes next.
TXN_TYPES = ("OPENING", "RECEIPT", "ISSUE", "ADJUSTMENT")


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

    part = db.relationship("Part")

    __table_args__ = (
        db.CheckConstraint(
            f"txn_type IN ({','.join(repr(t) for t in TXN_TYPES)})",
            name="ck_spare_stock_ledger_txn_type",
        ),
    )

    def __repr__(self):
        return f"<SpareStockLedger part={self.part_id} {self.txn_type} {self.qty_delta}>"
