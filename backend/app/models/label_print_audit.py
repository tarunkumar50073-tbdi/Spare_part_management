"""Barcode-label print / reprint audit — one row per print action.

Records who printed a part's label, how many copies, and (for a reprint) why.
Print history is a spec requirement and lets the store see reprints — a torn or
lost label is reprinted, and the reason is captured. ``printed_at`` is
``BaseModel.created_at`` (UTC stored, Asia/Kolkata displayed).

Only the barcode value (the Part No.) is stored, never the transient details a
label must NOT carry (price, min/max, stock, location, supplier).
"""
from app.extensions import db
from app.models.base import BaseModel


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

    part = db.relationship("Part")

    def __repr__(self):
        return f"<LabelPrintAudit part={self.part_id} x{self.copies} reprint={self.is_reprint}>"
