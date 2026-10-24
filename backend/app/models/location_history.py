"""Location-change trail for a spare part.

A spare has one fixed home on ``Part.location``; when it moves rack/shelf, the
old and new location are recorded here so the move is auditable rather than an
in-place overwrite. If ERP ever owns location, moves follow the ERP rule and are
not silently overwritten; while location is locally owned, a row is written here
on every confirmed move.
"""
from app.extensions import db
from app.models.base import BaseModel


class SpareLocationHistory(BaseModel):
    __tablename__ = "spare_location_history"

    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)
    old_location = db.Column(db.String(60), nullable=True)
    new_location = db.Column(db.String(60), nullable=True)
    reason = db.Column(db.String(255), nullable=True)
    # Optional quantity moved, when a location is quantity-based.
    qty = db.Column(db.Numeric(12, 2), nullable=True)
    moved_by = db.Column(db.String(60), nullable=True)

    part = db.relationship("Part")

    def __repr__(self):
        return f"<SpareLocationHistory part={self.part_id} {self.old_location}->{self.new_location}>"
