"""Store-operator notifications — fired by RackAlertService and the SRV
workflow (QC approval, FIFO risk, rack-full redirection). Stay ACTIVE until
the underlying condition is actually resolved (e.g. a holding entry fully
transferred), not just viewed — see NotificationService.resolve."""
from app.extensions import db
from app.models.base import BaseModel

NOTIFICATION_TYPES = [
    "QC_APPROVED", "RACK_SPACE_AVAILABLE", "HOLDING_TRANSFER_PENDING",
    "FIFO_VIOLATION_RISK", "ASSIGNED_RACK_FULL",
]
NOTIFICATION_STATUSES = ["ACTIVE", "RESOLVED"]


class Notification(BaseModel):
    __tablename__ = "notifications"

    type = db.Column(db.String(30), nullable=False, index=True)
    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=True)
    holding_entry_id = db.Column(db.Integer, db.ForeignKey("holding_entries.id"), nullable=True)
    message = db.Column(db.String(255), nullable=False)
    status = db.Column(db.String(10), nullable=False, default="ACTIVE", index=True)
    resolved_at = db.Column(db.DateTime(timezone=True), nullable=True)

    part = db.relationship("Part")
    holding_entry = db.relationship("HoldingEntry")

    __table_args__ = (
        db.CheckConstraint(f"type IN ({','.join(repr(t) for t in NOTIFICATION_TYPES)})", name="ck_notification_type"),
        db.CheckConstraint(f"status IN ({','.join(repr(s) for s in NOTIFICATION_STATUSES)})", name="ck_notification_status"),
    )

    def __repr__(self):
        return f"<Notification {self.type} {self.status}>"
