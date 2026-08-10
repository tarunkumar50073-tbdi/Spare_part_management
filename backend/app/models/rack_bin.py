"""Rack/Bin master — Main Store location (e.g. A1, A2) + rack, with
`bins_allocated` as the actual physical bin count on the rack.

`bins_occupied` is a separate, DX-side-only running counter of how many of
those allocated bins are actually full right now — it is never derived
from ERP's stock number (ERP doesn't know which rack material sits in).
It only changes via explicit DX actions: Put Away
(SRVService.put_away_confirm), Holding-to-Rack transfer
(HoldingService.transfer_to_rack), and Production consumption freeing
space back up (SRVService.confirm_consumption) — see
RackBinService.adjust_occupancy(). `available_bins`/`rack_status`
(Empty/Partial/Full/Blocked) are derived at read time in
RackBinService._enrich(), not stored, so they can never go stale."""
from app.extensions import db
from app.models.base import BaseModel

# The store's designated slow-moving/non-moving overflow area — any part
# racked here is Dead Stock (confirmed by the user: present and future
# non-moving stock all goes to Mezzanine). Used to exclude these parts from
# "critical for today's production" / Short Parts surfaces, since they're
# deliberately parked away, not part of active production flow.
DEAD_STOCK_LOCATION = "MEZZANINE"


class RackBin(BaseModel):
    __tablename__ = "rack_bins"

    location = db.Column(db.String(20), nullable=False, index=True)
    rack_no = db.Column(db.String(20), nullable=False)
    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)
    bin_capacity = db.Column(db.Numeric(12, 2), nullable=False)
    bins_allocated = db.Column(db.Integer, nullable=False, default=0)
    bins_occupied = db.Column(db.Integer, nullable=False, default=0)
    is_blocked = db.Column(db.Boolean, nullable=False, default=False)

    part = db.relationship("Part")

    __table_args__ = (
        db.UniqueConstraint("location", "rack_no", "part_id", name="uq_rack_bin_location_rack_part"),
    )

    def __repr__(self):
        return f"<RackBin {self.location}/{self.rack_no} part={self.part_id} occupied={self.bins_occupied}/{self.bins_allocated}>"
