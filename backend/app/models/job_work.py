"""ERP RGP lines and their link to a job work return (the store's spec of 27 Oct
2026: "Part Return, Job Work Return & Pending RGP Integration").

A job work return (SpareReturn, return_type JOB_WORK_RETURN) is a part a user
brings back worn or damaged for repair. The store does NOT make the RGP here —
another store employee makes it in ERP ([[rgp-is-erp-owned]]). The app reads
ERP's returnable gate passes (termsdb.challan_register, challan_type
"Returnable Gate Pass (RGP)" — the store chose that type only), keeps them as
ErpRgpLine, and a store person links the right RGP line to the return.

The two stay separate records joined by RgpReturnLink: one return has at most
one RGP line, and one RGP line belongs to at most one return (the unique
constraints), so the same RGP can never be booked to two returns.
"""
from app.extensions import db
from app.models.base import BaseModel


class ErpRgpLine(BaseModel):
    """One item line of an ERP RGP challan, as last read. Keyed by challan no. +
    item code (unique in ERP; ERP's own row id is not relied on). Read only:
    the app never creates, edits, approves or cancels an RGP."""
    __tablename__ = "erp_rgp_lines"

    challan_no = db.Column(db.String(40), nullable=False, index=True)
    item_cd = db.Column(db.String(40), nullable=False, index=True)
    challan_date = db.Column(db.Date, nullable=True, index=True)
    challan_type = db.Column(db.String(40), nullable=True)
    party_cd = db.Column(db.String(40), nullable=True)
    party_name = db.Column(db.String(160), nullable=True)
    item_desc = db.Column(db.String(255), nullable=True)
    uom = db.Column(db.String(20), nullable=True)
    qty = db.Column(db.Numeric(12, 2), nullable=True)
    # ERP's status as read: HOLD (made, not gone out), EXITED, CANCEL.
    status = db.Column(db.String(20), nullable=True, index=True)
    target_date = db.Column(db.Date, nullable=True)
    gate_exit_no = db.Column(db.String(40), nullable=True)
    doc_no = db.Column(db.String(60), nullable=True)
    erp_id = db.Column(db.Integer, nullable=True)
    synced_at = db.Column(db.DateTime(timezone=True), nullable=True)

    __table_args__ = (db.UniqueConstraint("challan_no", "item_cd", name="uq_erp_rgp_lines_challan_item"),)


class RgpReturnLink(BaseModel):
    """A job work return linked to the ERP RGP line that took it out — saved
    by a store person (never guessed by the app)."""
    __tablename__ = "rgp_return_links"

    return_id = db.Column(db.Integer, db.ForeignKey("spare_returns.id"), nullable=False, unique=True)
    rgp_line_id = db.Column(db.Integer, db.ForeignKey("erp_rgp_lines.id"), nullable=False, unique=True)
    linked_by = db.Column(db.String(60), nullable=True)

    rgp = db.relationship("ErpRgpLine")
