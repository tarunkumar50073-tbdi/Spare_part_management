"""Report Recipient master — who each auto-mailed report goes to (To / Cc).

Generic by report_key; today only 'window_time' (the daily supplier window-time
sheet) uses it. A table, not a code constant, so the store changes who gets the
mail without a developer — same reasoning as the Department master.
"""
from app.extensions import db
from app.models.base import BaseModel

ROLES = ("TO", "CC")

# Seeded on first boot from the store's existing daily mail (the Outlook
# screenshot): To pintu sharma; Cc Ashok yadav, Suneel Kumar, Tarun Kumar.
# Every e-mail starts BLANK — the row exists before the address is known and an
# admin fills it on the Report Recipients screen; the mailer skips until the To
# address is set, so nothing sends prematurely.
SEED_REPORT_RECIPIENTS = [
    {"report_key": "window_time", "name": "pintu sharma", "role": "TO", "sort_order": 1},
    {"report_key": "window_time", "name": "Ashok yadav", "role": "CC", "sort_order": 2},
    {"report_key": "window_time", "name": "Suneel Kumar", "role": "CC", "sort_order": 3},
    {"report_key": "window_time", "name": "Tarun Kumar", "role": "CC", "sort_order": 4},
]


class ReportRecipient(BaseModel):
    __tablename__ = "report_recipients"

    report_key = db.Column(db.String(40), nullable=False, index=True)
    name = db.Column(db.String(120), nullable=False)
    # Blank until an admin fills it; the mailer skips a row with no address.
    email = db.Column(db.String(255), nullable=True)
    role = db.Column(db.String(2), nullable=False, default="TO")
    sort_order = db.Column(db.Integer, nullable=False, default=100)
    is_active = db.Column(db.Boolean, nullable=False, default=True)

    __table_args__ = (
        db.CheckConstraint("role IN ('TO','CC')", name="ck_report_recipient_role"),
    )

    def to_dict(self):
        return {
            "id": self.id, "report_key": self.report_key, "name": self.name,
            "email": self.email, "role": self.role,
            "sort_order": self.sort_order, "is_active": self.is_active,
        }

    def __repr__(self):
        return f"<ReportRecipient {self.report_key}:{self.role} {self.name}>"
