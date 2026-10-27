"""Spare receipts and packets — QR labels, packets and FIFO for the Spare Parts
Store (the store's spec of 27 Oct 2026: ERP gate entry -> physical verification
-> packet creation -> unique QR labels -> FIFO stock -> issue of whole packets).

A RECEIPT BATCH (SpareBatch — not the older SpareReceipt of spare_flow.py) is one batch of a part that came in: an ERP GRN line accepted by
quality and added to stock (ErpGrnPostingService), another receipt row of the
ledger, or — the store's pick, "loose rahe, chaho to packet bana sako" — an
OPENING batch made from stock already on the shelf. Its received_on (the GRN
date) is the FIFO key, never the day a label was printed. The supervisor
verifies it physically before any label is made.

A PACKET is what one QR label stands for: a packet of small parts (packet qty
chosen when it is made — never a fixed 20) or one individually tracked unit
(kind UNIT, qty 1). Making packets and printing labels never change stock:
stock came in once, with the receipt; a packet only says where part of it is.
Issuing a packet deducts its whole quantity, once.

On-hand stays the one figure in spare_stock. Packets AVAILABLE are part of it;
the rest is loose: loose = on hand - packed available, never below zero
(SpareStockService refuses a write that would make it so).
"""
from app.extensions import db
from app.models.base import BaseModel

RECEIPT_SOURCES = ("ERP_GRN", "RECEIPT", "OPENING")
VERIFY_STATES = ("PENDING", "VERIFIED", "MISMATCH")
PACKET_KINDS = ("PACKET", "UNIT")
PACKET_STATES = ("AVAILABLE", "ISSUED", "CANCELLED")


class SpareBatch(BaseModel):
    __tablename__ = "spare_batches"

    receipt_no = db.Column(db.String(30), nullable=False, unique=True, index=True)
    store_code = db.Column(db.String(30), nullable=False, index=True)
    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)
    # ERP_GRN (an accepted ERP GRN line), RECEIPT (another receipt row of the
    # ledger) or OPENING (stock already on the shelf, made into a batch).
    source = db.Column(db.String(12), nullable=False)
    # The RECEIPT ledger row that brought the stock in — one receipt per row, so
    # a re-read GRN or a second sync never makes a second batch. None for OPENING.
    ledger_id = db.Column(db.Integer, db.ForeignKey("spare_stock_ledger.id"), nullable=True, unique=True)
    # FIFO: the day it was received (the GRN date), then this row's id.
    received_on = db.Column(db.Date, nullable=False, index=True)
    qty = db.Column(db.Numeric(12, 2), nullable=False)
    uom = db.Column(db.String(10), nullable=True)
    grn_no = db.Column(db.String(60), nullable=True, index=True)
    gate_entry_no = db.Column(db.String(60), nullable=True, index=True)
    gate_entry_dt = db.Column(db.Date, nullable=True)
    invoice_no = db.Column(db.String(60), nullable=True)
    supplier_name = db.Column(db.String(160), nullable=True)
    ven_cd = db.Column(db.String(60), nullable=True)
    # Physical verification by the supervisor: PENDING -> VERIFIED (counted =
    # received) or MISMATCH (counted otherwise, with a remark). Labels only after.
    verify_status = db.Column(db.String(10), nullable=False, default="PENDING", index=True)
    verified_qty = db.Column(db.Numeric(12, 2), nullable=True)
    verified_by = db.Column(db.String(60), nullable=True)
    verified_at = db.Column(db.DateTime(timezone=True), nullable=True)
    verify_remarks = db.Column(db.String(255), nullable=True)
    created_by = db.Column(db.String(60), nullable=True)

    part = db.relationship("Part", lazy="joined")
    packets = db.relationship("SparePacket", back_populates="batch", lazy="select",
                              order_by="SparePacket.seq")

    def __repr__(self):
        return f"<SpareBatch {self.receipt_no} part={self.part_id} qty={self.qty}>"


class SparePacket(BaseModel):
    __tablename__ = "spare_packets"

    # What the QR carries ("SPK-" + 8 characters, made by the app — never typed).
    code = db.Column(db.String(24), nullable=False, unique=True, index=True)
    kind = db.Column(db.String(8), nullable=False)                    # PACKET | UNIT
    batch_id = db.Column(db.Integer, db.ForeignKey("spare_batches.id"), nullable=False, index=True)
    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)
    seq = db.Column(db.Integer, nullable=False)                       # 1, 2, 3 … within its receipt
    qty = db.Column(db.Numeric(12, 2), nullable=False)
    uom = db.Column(db.String(10), nullable=True)
    location = db.Column(db.String(60), nullable=True)                # the part's location when made
    status = db.Column(db.String(10), nullable=False, default="AVAILABLE", index=True)
    created_by = db.Column(db.String(60), nullable=True)
    # Issued: the whole packet, once, with the ISSUE ledger row it made.
    issued_at = db.Column(db.DateTime(timezone=True), nullable=True)
    issued_by = db.Column(db.String(60), nullable=True)
    issue_ledger_id = db.Column(db.Integer, db.ForeignKey("spare_stock_ledger.id"), nullable=True, index=True)
    department = db.Column(db.String(60), nullable=True)
    issued_to = db.Column(db.String(120), nullable=True)
    # Issued while an older receipt still had packets: why (FIFO exception).
    fifo_override_reason = db.Column(db.String(255), nullable=True)
    cancelled_at = db.Column(db.DateTime(timezone=True), nullable=True)
    cancelled_by = db.Column(db.String(60), nullable=True)
    cancel_reason = db.Column(db.String(255), nullable=True)
    print_count = db.Column(db.Integer, nullable=False, default=0)
    last_printed_at = db.Column(db.DateTime(timezone=True), nullable=True)

    batch = db.relationship("SpareBatch", back_populates="packets", lazy="joined")
    part = db.relationship("Part", lazy="joined")

    __table_args__ = (
        db.UniqueConstraint("batch_id", "seq", name="uq_spare_packets_batch_seq"),
        db.Index("ix_spare_packets_part_status", "part_id", "status"),
    )

    def __repr__(self):
        return f"<SparePacket {self.code} {self.kind} qty={self.qty} {self.status}>"
