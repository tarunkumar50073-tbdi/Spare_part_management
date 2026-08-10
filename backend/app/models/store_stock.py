"""Live part stock by store location, plus a movement ledger for traceability."""
from app.extensions import db
from app.models.base import BaseModel


class PartStock(BaseModel):
    __tablename__ = "part_stock"

    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)
    location = db.Column(db.String(20), nullable=False)  # RECEIVING_STORE / PART_STORE
    qty_on_hand = db.Column(db.Numeric(12, 2), nullable=False, default=0)

    part = db.relationship("Part")

    __table_args__ = (
        db.CheckConstraint("location IN ('RECEIVING_STORE','PART_STORE')", name="ck_part_stock_location"),
        db.UniqueConstraint("part_id", "location", name="uq_part_stock_part_location"),
    )

    def __repr__(self):
        return f"<PartStock part={self.part_id} {self.location} qty={self.qty_on_hand}>"


class StockLedger(BaseModel):
    __tablename__ = "stock_ledger"

    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)
    srv_id = db.Column(db.Integer, db.ForeignKey("srvs.id"), nullable=True, index=True)
    production_receipt_id = db.Column(db.Integer, db.ForeignKey("production_receipts.id"), nullable=True, index=True)
    location = db.Column(db.String(20), nullable=False)
    qty_delta = db.Column(db.Numeric(12, 2), nullable=False)  # positive = in, negative = out
    reason = db.Column(db.String(50), nullable=False)

    # BUY = tied to a purchased SRV, MAKE = tied to an in-house
    # ProductionReceipt. NULL for internal moves (TRANSFER_IN/OUT,
    # PRODUCTION_CONSUMPTION) that don't originate new stock — see
    # StoreDashboardService.get_source_breakdown(), which sums the
    # originating (SRV_STORED / PRODUCTION_RECEIPT) rows only, since this
    # is a cumulative-received split, not a live per-lot stock split.
    source_type = db.Column(db.String(4), nullable=True)

    # Stable external reference (ERP "Doc No#Tran Seq") for rows imported
    # from an ERP stock ledger or pushed later by the ERP API — the dedupe
    # key so re-importing the same file, or a later API push of the same
    # transaction, can't double-count. NULL for app-generated internal moves.
    ext_ref = db.Column(db.String(80), nullable=True, index=True)

    __table_args__ = (
        db.CheckConstraint("location IN ('RECEIVING_STORE','PART_STORE')", name="ck_stock_ledger_location"),
        db.CheckConstraint("source_type IS NULL OR source_type IN ('BUY','MAKE')", name="ck_stock_ledger_source_type"),
    )

    def __repr__(self):
        return f"<StockLedger part={self.part_id} {self.location} {self.qty_delta}>"
