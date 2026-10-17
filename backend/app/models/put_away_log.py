"""Put-away confirmation log for the spare store.

On the Put-away Check screen a store supervisor scans a part's lot tag and then
the bin's location QR; when the two match, "Confirm Put Away" records — here —
that the material was physically shelved at that location: one row per
confirmation, with the lot quantity, who did it, and when.

This is a record of the physical placement only. It does NOT move stock (the
part already carries its location), and the ERP update follows later.
"""
from app.extensions import db
from app.models.base import BaseModel


class PutAwayLog(BaseModel):
    __tablename__ = "put_away_log"

    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)
    # Denormalised so the record reads on its own even if the part is later edited.
    part_no = db.Column(db.String(60), nullable=True)
    # The part's assigned (recorded) location, and what was actually scanned — on
    # a confirmed put-away they match (the screen only offers Confirm on a match).
    assigned_location = db.Column(db.String(40), nullable=True)
    scanned_location = db.Column(db.String(40), nullable=True)
    # From the scanned lot tag, when it was a lot tag: the gate entry no and the
    # lot quantity summed for this part on that gate entry.
    gate_entry_no = db.Column(db.String(60), nullable=True)
    qty = db.Column(db.Numeric(14, 2), nullable=True)
    # Store scope the part belongs to (denormalised like other spare rows).
    section_id = db.Column(db.Integer, nullable=True, index=True)
    store_code = db.Column(db.String(30), nullable=True, index=True)
    # Who confirmed it (username; None for a machine caller) and when.
    put_by = db.Column(db.String(60), nullable=True)
    confirmed_at = db.Column(db.DateTime(timezone=True), nullable=True)

    part = db.relationship("Part")

    def __repr__(self):
        return f"<PutAwayLog part={self.part_no} @ {self.assigned_location} by {self.put_by}>"
