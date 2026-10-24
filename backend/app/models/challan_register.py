"""Urgent Challan Register — material that came in against a supplier's
delivery challan before its PO was approved or its original invoice arrived
(the store's spec, 21 Oct 2026: "Sometimes urgent spare parts are required
before the Purchase Order (PO) has been approved ... the supplier sends the
material against a delivery challan and provides the original invoice later").
It replaces the manual gate register for these challans.

A REGISTER, NEVER STOCK. Nothing here writes spare_stock or its ledger. The one
way a part's stock goes up stays the ERP GRN after quality clearance
(services/erp_grn_posting_service.py: an ERP GRN line with accepted qty posts
a RECEIPT once per part and GRN). A challan only points at that GRN line, so
the same material can never be counted twice because both a challan and an
invoice exist.

    challan_register           one row per supplier challan line (one part)
    challan_register_links     the original invoice(s) for it, each with the
                               GRN that followed — a challan may be invoiced in
                               parts, and one invoice may cover several challans
    challan_register_history   every change, oldest first; nothing is deleted

Duplicates are refused three ways: an active (not Cancelled) line is unique on
supplier + challan no. + part (a partial delivery comes on its own challan no.,
so it is its own line); a form's request_id is unique, so a repeated submit
returns the first record instead of a second one; and a GRN — its GRN no. and
Part No. in the ERP GRN register — can be linked to one challan only.

The ERP sync rewrites the whole GRN register on every run, so a register line's
id changes each time: a link names its GRN by GRN no. + Part No. (+ vendor) and
finds the lines again by them — never by a foreign key, which would also stop
the sync from rewriting the register.
"""
from sqlalchemy import text

from app.extensions import db
from app.models.base import BaseModel

CHALLAN_STATUSES = ("Pending Invoice", "Invoice Received", "GRN Pending", "GRN Completed", "Cancelled")
OPEN_STATUSES = ("Pending Invoice", "Invoice Received", "GRN Pending")
PO_STATUSES = ("Pending Approval", "Approved", "Not Applicable")
URGENCY_REASONS = ("Production Critical", "Breakdown", "Other")
INVOICE_STATUSES = ("Pending", "Received")
QUALITY_STATUSES = ("Pending", "OK", "Rejected")


class ChallanRegister(BaseModel):
    __tablename__ = "challan_register"

    # CHL-YYYYMMDD-NNN, the store's own reference for the line.
    challan_id = db.Column(db.String(30), nullable=False, unique=True, index=True)
    store_code = db.Column(db.String(30), nullable=False, index=True)

    challan_no = db.Column(db.String(60), nullable=False, index=True)
    # challan_no upper-cased, spaces dropped: what "the same challan" is compared on.
    challan_key = db.Column(db.String(60), nullable=False)
    challan_date = db.Column(db.Date, nullable=False)
    receipt_date = db.Column(db.Date, nullable=False, index=True)
    # The gate register entry the material came in on, when it has one.
    gate_entry_no = db.Column(db.String(60), nullable=True)

    # Supplier as every receipt / RGP screen picks it: an ERP vendor of this part
    # (ven_cd), the supplier master (supplier_id) or a name only — never a typed code.
    supplier_id = db.Column(db.Integer, db.ForeignKey("suppliers.id"), nullable=True, index=True)
    ven_cd = db.Column(db.String(60), nullable=True, index=True)
    supplier_name = db.Column(db.String(160), nullable=False)
    supplier_source = db.Column(db.String(20), nullable=False)
    # VEN:<code> / SUP:<id> / NAME:<NAME> — one key per supplier, for the duplicate check.
    supplier_key = db.Column(db.String(180), nullable=False, index=True)

    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)
    part_no = db.Column(db.String(60), nullable=False, index=True)
    part_description = db.Column(db.String(255), nullable=True)
    challan_qty = db.Column(db.Numeric(12, 2), nullable=False)
    unit_of_measure = db.Column(db.String(20), nullable=True)

    po_reference = db.Column(db.String(60), nullable=True)
    po_status = db.Column(db.String(20), nullable=False, index=True)
    urgency_reason = db.Column(db.String(30), nullable=False)

    # Summaries of the links (challan_register_links), kept on the line so the
    # register filters and sorts on them: the invoice no.(s), the latest invoice
    # date, how much is invoiced, the GRN no.(s) and the quality result.
    invoice_no = db.Column(db.String(255), nullable=True)
    invoice_date = db.Column(db.Date, nullable=True)
    invoiced_qty = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    invoice_status = db.Column(db.String(20), nullable=False, default="Pending", index=True)
    grn_reference = db.Column(db.String(255), nullable=True)
    quality_status = db.Column(db.String(20), nullable=False, default="Pending", index=True)
    status = db.Column(db.String(20), nullable=False, default="Pending Invoice", index=True)
    completed_at = db.Column(db.DateTime(timezone=True), nullable=True)

    remarks = db.Column(db.String(255), nullable=True)
    cancel_reason = db.Column(db.String(255), nullable=True)
    cancelled_by = db.Column(db.String(60), nullable=True)
    cancelled_at = db.Column(db.DateTime(timezone=True), nullable=True)
    created_by = db.Column(db.String(60), nullable=False)
    # The entry form's own id: a repeated submit finds the first record.
    request_id = db.Column(db.String(64), nullable=True, unique=True)

    links = db.relationship("ChallanLink", backref="challan", lazy="select",
                            order_by="ChallanLink.id", cascade="all, delete-orphan")
    history = db.relationship("ChallanHistory", backref="challan", lazy="select",
                              order_by="ChallanHistory.id", cascade="all, delete-orphan")

    __table_args__ = (
        # One ACTIVE line per supplier + challan no. + part; cancelled lines stay
        # for the audit and do not block a fresh entry.
        db.Index("uq_challan_register_active_line", "store_code", "supplier_key", "challan_key", "part_id",
                 unique=True, sqlite_where=text("status != 'Cancelled'"),
                 postgresql_where=text("status != 'Cancelled'")),
        db.Index("ix_challan_register_store_status", "store_code", "status"),
    )

    def __repr__(self):
        return f"<ChallanRegister {self.challan_id} {self.challan_no} {self.part_no}>"


class ChallanLink(BaseModel):
    """One original invoice against a challan line, and the GRN that followed it."""
    __tablename__ = "challan_register_links"

    challan_ref = db.Column(db.Integer, db.ForeignKey("challan_register.id"), nullable=False, index=True)
    invoice_no = db.Column(db.String(60), nullable=False, index=True)
    invoice_key = db.Column(db.String(60), nullable=False)
    invoice_date = db.Column(db.Date, nullable=False)
    invoice_qty = db.Column(db.Numeric(12, 2), nullable=False)
    linked_by = db.Column(db.String(60), nullable=False)
    request_id = db.Column(db.String(64), nullable=True, unique=True)

    # The GRN: its no. (grn_key, spacing and case aside) and the Part No.
    # (grn_item) — what its lines in the ERP GRN register are found by, read
    # from them when ERP has them, else typed until they arrive.
    grn_reference = db.Column(db.String(60), nullable=True, index=True)
    grn_key = db.Column(db.String(60), nullable=True)
    grn_item = db.Column(db.String(60), nullable=True)
    grn_date = db.Column(db.Date, nullable=True)
    # The register line last read — a hint only: the sync renumbers the lines.
    receiving_register_id = db.Column(db.Integer, nullable=True)
    grn_receipt_qty = db.Column(db.Numeric(12, 2), nullable=True)
    grn_accepted_qty = db.Column(db.Numeric(12, 2), nullable=True)
    grn_rejected_qty = db.Column(db.Numeric(12, 2), nullable=True)
    quality_status = db.Column(db.String(20), nullable=False, default="Pending")
    grn_linked_by = db.Column(db.String(60), nullable=True)
    grn_linked_at = db.Column(db.DateTime(timezone=True), nullable=True)

    __table_args__ = (
        # The same invoice is linked to a challan line once.
        db.Index("uq_challan_register_links_invoice", "challan_ref", "invoice_key", unique=True),
        # A GRN (its no. + Part No.) is linked to one challan line only; a
        # cancelled line gives it up (its grn_key is cleared, the no. kept).
        db.Index("uq_challan_register_links_grn", "grn_key", "grn_item", unique=True,
                 sqlite_where=text("grn_key IS NOT NULL"), postgresql_where=text("grn_key IS NOT NULL")),
    )


class ChallanHistory(BaseModel):
    """What happened to a challan line, when and by whom — never edited."""
    __tablename__ = "challan_register_history"

    challan_ref = db.Column(db.Integer, db.ForeignKey("challan_register.id"), nullable=False, index=True)
    action = db.Column(db.String(30), nullable=False)
    from_status = db.Column(db.String(20), nullable=True)
    to_status = db.Column(db.String(20), nullable=True)
    details = db.Column(db.Text, nullable=True)            # JSON
    by = db.Column(db.String(60), nullable=False)
