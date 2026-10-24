"""Barcode-label print / reprint audit — one row per print action.

Records who printed a part's label, how many copies, and (for a reprint) why.
Print history is a spec requirement and lets the store see reprints — a torn or
lost label is reprinted, and the reason is captured. ``printed_at`` is
``BaseModel.created_at`` (UTC stored, Asia/Kolkata displayed).

The QR / barcode encodes ONLY the Part No. The printed label shows Part No.,
description and the rack location as text (spec 3) — never price, rate,
supplier, min / max / reorder or ERP quantity. The location printed is kept here
because it is a snapshot: a later move makes the printed one stale.

A row is written only after the operator confirms the label actually came out
of the printer (the browser cannot know), so the history is what was printed,
not what was attempted.

Labels printed for material that arrived on an ERP gate entry (the lot tags,
until they were taken out on 17 Oct 2026) carry that gate entry no. in
``reference``; the part's timeline still names it.
"""
from app.extensions import db
from app.models.base import BaseModel

# How the part was identified when its label was printed (spec 8). REPRINT is
# the explicit reprint action (needs a reason); PART_MASTER / STORE_STOCK are
# the master-data screens that print outside the scan flow; GATE_ENTRY is a
# batch printed for an ERP gate entry's items (reference = the gate entry no.) —
# the lot tags, printed until the store had them taken out on 17 Oct 2026
# (paper waste); nothing writes it now, and its rows stay as history.
PRINT_SOURCES = (
    "SUPPLIER_BARCODE", "ERP_SEARCH", "MANUAL_ENTRY", "QR_SCAN", "REPRINT",
    "PART_MASTER", "STORE_STOCK", "GATE_ENTRY",
)


class LabelPrintAudit(BaseModel):
    __tablename__ = "label_print_audit"

    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)

    # The value encoded on the printed label (the internal Part No.).
    barcode_value = db.Column(db.String(80), nullable=False)

    copies = db.Column(db.Integer, nullable=False, default=1)
    printed_by = db.Column(db.String(60), nullable=True)

    # A reprint (label torn/lost/faded) vs the first print. Reason is required
    # by the service for a reprint, optional for a first print.
    is_reprint = db.Column(db.Boolean, nullable=False, default=False)
    reason = db.Column(db.String(255), nullable=True)

    # Spec 8: how the part was identified, which printer, what was printed.
    source = db.Column(db.String(20), nullable=True)
    printer_name = db.Column(db.String(80), nullable=True)
    symbology = db.Column(db.String(10), nullable=True)
    location_printed = db.Column(db.String(40), nullable=True)

    # The document the label was printed for — the ERP gate entry no. for a
    # GATE_ENTRY print; NULL for a print from the part itself.
    reference = db.Column(db.String(60), nullable=True)

    part = db.relationship("Part")

    def __repr__(self):
        return f"<LabelPrintAudit part={self.part_id} x{self.copies} reprint={self.is_reprint}>"
