"""Audit + idempotency log for auto-mailed reports.

One row per successful send. The unique (report_key, report_date) means the
daily scheduler and a Windows-Task-Scheduler trigger cannot both mail the same
report for the same day twice — send_current_month(force=False) skips when a row
already exists — and it doubles as a visible history of what went out.
"""
from app.extensions import db
from app.models.base import BaseModel


class MailSendLog(BaseModel):
    __tablename__ = "mail_send_logs"

    report_key = db.Column(db.String(40), nullable=False, index=True)
    report_date = db.Column(db.Date, nullable=False, index=True)
    to_addrs = db.Column(db.String(500), nullable=True)
    cc_addrs = db.Column(db.String(500), nullable=True)
    subject = db.Column(db.String(255), nullable=True)

    __table_args__ = (
        db.UniqueConstraint("report_key", "report_date", name="uq_mail_send_report_date"),
    )

    def to_dict(self):
        return {
            "id": self.id, "report_key": self.report_key,
            "report_date": self.report_date.isoformat() if self.report_date else None,
            "to_addrs": self.to_addrs, "cc_addrs": self.cc_addrs, "subject": self.subject,
            "sent_at": self.created_at.isoformat() if self.created_at else None,
        }

    def __repr__(self):
        return f"<MailSendLog {self.report_key} {self.report_date}>"
