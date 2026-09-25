"""Audit trail — one row per important action across the store process
(SRV generated, rack allocation, holding entry/transfer, FIFO warning,
rack change, QC approval, stock sync). `user` is always 'SYSTEM' (an
ERP-inbound/automated action) or 'STORE' (a store-operator action) — there
is no login module yet, so a free-text operator name would just produce
inconsistent audit data; this gets replaced with a real user id once auth
is built."""
from app.extensions import db
from app.models.base import BaseModel

AUDIT_USERS = ["SYSTEM", "STORE"]


class AuditLog(BaseModel):
    __tablename__ = "audit_logs"

    action = db.Column(db.String(40), nullable=False, index=True)
    entity_type = db.Column(db.String(30), nullable=False, index=True)
    entity_id = db.Column(db.Integer, nullable=True, index=True)
    user = db.Column(db.String(10), nullable=False, default="SYSTEM")

    old_location = db.Column(db.String(50), nullable=True)
    new_location = db.Column(db.String(50), nullable=True)
    quantity = db.Column(db.Numeric(12, 2), nullable=True)
    remarks = db.Column(db.String(255), nullable=True)

    __table_args__ = (
        db.CheckConstraint(f"user IN ({','.join(repr(u) for u in AUDIT_USERS)})", name="ck_audit_user"),
        db.Index("ix_audit_logs_created_at", "created_at"),   # newest-first paging
    )

    def __repr__(self):
        return f"<AuditLog {self.action} {self.entity_type}#{self.entity_id}>"
