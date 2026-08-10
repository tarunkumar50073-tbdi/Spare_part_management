"""Barcode/QR scan log for the verification step — one row per scan attempt.
A scan can fail to match any pending line in the batch (WRONG_PART), so it
can't live as a column on SRV itself; this is what live verification
progress and wrong-part/excess detection are read from."""
from app.extensions import db
from app.models.base import BaseModel

SCAN_RESULTS = ["MATCHED", "WRONG_PART", "EXCESS"]


class SRVScanEvent(BaseModel):
    __tablename__ = "srv_scan_events"

    gate_entry_no = db.Column(db.String(30), nullable=False, index=True)
    barcode = db.Column(db.String(60), nullable=False)
    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=True)
    srv_id = db.Column(db.Integer, db.ForeignKey("srvs.id"), nullable=True, index=True)
    result = db.Column(db.String(12), nullable=False)

    part = db.relationship("Part")
    srv = db.relationship("SRV")

    __table_args__ = (
        db.CheckConstraint(f"result IN ({','.join(repr(r) for r in SCAN_RESULTS)})", name="ck_scan_event_result"),
    )

    def __repr__(self):
        return f"<SRVScanEvent {self.barcode} {self.result}>"
