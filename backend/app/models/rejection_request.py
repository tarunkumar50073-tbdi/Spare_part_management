"""Rejection Mail — the one mail the store sends RQC to punch a rejection in
ERP (the store, 22 Oct 2026: "jab koi material reject hota h to hum us invoice
ki grn srv finished me bnwakar rqc wale ko mail karte h ki isko system me punch
kar do"; and "rejection request only 1 mail k liye h baaki kuch nhi" — the mail
only, nothing to follow afterwards).

Two kinds, by where the GRN stands:
    SRV   the usual one — the GRN is made in SRV finished and RQC punches an
          SRV rejection on it;
    LINE  the GRN was already made as a store entry (the material is in
          stock) and the user rejected it later — RQC punches a line rejection.

Each mail made is kept — its details, so it can be opened again — and nothing
here moves stock or sends mail: the app drafts it, the store sends it.

    rejection_requests          one row per mail (one GRN line, one part)
    rejection_request_history   when it was made / opened, and by whom

The table was first made with columns for a status workflow (mailed / punched /
dispatched / cancelled — built the same day, then dropped on the store's word);
they stay in the table, unused and empty. `status` is still filled ("Requested")
because the table holds it NOT NULL.

Spare Parts Store only for now ("abhi sirf spare store ke liye"); consumable
items sit in the same store.
"""
from app.extensions import db
from app.models.base import BaseModel

REJECTION_KINDS = ("SRV", "LINE")
KIND_LABELS = {"SRV": "SRV Rejection", "LINE": "Line Rejection"}


class RejectionRequest(BaseModel):
    __tablename__ = "rejection_requests"

    # REJ-YYYYMMDD-NNN, the store's own reference.
    request_no = db.Column(db.String(30), nullable=False, unique=True, index=True)
    store_code = db.Column(db.String(30), nullable=False, index=True)
    kind = db.Column(db.String(10), nullable=False, index=True)
    status = db.Column(db.String(20), nullable=False, default="Requested", index=True)

    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)
    item_cd = db.Column(db.String(60), nullable=False, index=True)
    item_desc = db.Column(db.String(255), nullable=True)
    uom = db.Column(db.String(20), nullable=True)
    hsn = db.Column(db.String(20), nullable=True)

    ven_cd = db.Column(db.String(60), nullable=True)
    ven_name = db.Column(db.String(160), nullable=False)
    challan_no = db.Column(db.String(60), nullable=True)
    challan_date = db.Column(db.Date, nullable=True)
    po_no = db.Column(db.String(60), nullable=True)
    po_date = db.Column(db.Date, nullable=True)
    grn_no = db.Column(db.String(60), nullable=True, index=True)
    grn_date = db.Column(db.Date, nullable=True)
    gate_entry_no = db.Column(db.String(60), nullable=True)
    grn_key = db.Column(db.String(60), nullable=True, index=True)
    # The GRN register line it was made from — a hint only: the ERP sync
    # renumbers the register's rows.
    receiving_register_id = db.Column(db.Integer, nullable=True)
    received_qty = db.Column(db.Numeric(14, 2), nullable=True)

    qty = db.Column(db.Numeric(14, 2), nullable=False)
    remark = db.Column(db.String(255), nullable=False)
    created_by = db.Column(db.String(60), nullable=False)
    # The form's own id: a repeated submit finds the first mail.
    request_id = db.Column(db.String(64), nullable=True, unique=True)

    history = db.relationship("RejectionHistory", backref="request", lazy="select",
                              order_by="RejectionHistory.id", cascade="all, delete-orphan")

    __table_args__ = (
        db.Index("ix_rejection_requests_store_status", "store_code", "status"),
    )


class RejectionHistory(BaseModel):
    """When a mail was made and opened, and by whom — never edited."""
    __tablename__ = "rejection_request_history"

    request_ref = db.Column(db.Integer, db.ForeignKey("rejection_requests.id"), nullable=False, index=True)
    action = db.Column(db.String(30), nullable=False)
    from_status = db.Column(db.String(20), nullable=True)
    to_status = db.Column(db.String(20), nullable=True)
    details = db.Column(db.Text, nullable=True)            # JSON
    by = db.Column(db.String(60), nullable=False)
