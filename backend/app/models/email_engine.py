"""Notification Engine tables — the durable mail queue, which is also the mail log.

Every outgoing mail (the reorder list, the window-time sheet, the SMTP test, a
rule digest, a manual alert, a reminder) is one `email_messages` row from the
moment it is asked for, whether or not it could be sent. The old
`mail_send_logs` table stays as it was: a once-a-day idempotency ledger the two
daily reports still check. It never held a failure, a retry or a forced
re-send, so it cannot be the log the Email screens read.

The SMTP password is never part of a row. `last_error` holds a reason code or
the mail server's own answer, already stripped of anything secret by the mailer.
"""
import json
from datetime import timezone

from app.extensions import db
from app.models.base import BaseModel

STATUS_QUEUED = "QUEUED"
STATUS_SENDING = "SENDING"
STATUS_SENT = "SENT"
STATUS_PARTIAL = "PARTIAL"      # delivered, but the server refused some recipients
STATUS_FAILED = "FAILED"
STATUS_CANCELLED = "CANCELLED"
STATUS_SKIPPED = "SKIPPED"      # never attempted: no recipient, attachment too large…
MAIL_STATUSES = (STATUS_QUEUED, STATUS_SENDING, STATUS_SENT, STATUS_PARTIAL,
                 STATUS_FAILED, STATUS_CANCELLED, STATUS_SKIPPED)

TRIGGER_MANUAL = "MANUAL"
TRIGGER_SCHEDULED = "SCHEDULED"
TRIGGER_RULE = "RULE"
TRIGGER_TEST = "TEST"
TRIGGERS = (TRIGGER_MANUAL, TRIGGER_SCHEDULED, TRIGGER_RULE, TRIGGER_TEST)

# One delivery attempt's result. DEFERRED = put off because the mail server
# settings were not usable; it does not count against max_attempts.
OUTCOME_SENT = "SENT"
OUTCOME_PARTIAL = "PARTIAL"
OUTCOME_FAILED = "FAILED"
OUTCOME_DEFERRED = "DEFERRED"


def _iso(value):
    """A stored timestamp as the zone-less UTC string the rest of the API sends
    (the frontend reads it with parseServerTime). SQLite hands DateTime back
    naive; a row not yet reloaded still carries the aware default."""
    if value is None:
        return None
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value.isoformat()


def _json_list(text):
    try:
        value = json.loads(text) if text else []
    except (ValueError, TypeError):
        return []
    return value if isinstance(value, list) else []


class EmailMessage(BaseModel):
    __tablename__ = "email_messages"

    mail_type = db.Column(db.String(40), nullable=False, index=True)
    rule_key = db.Column(db.String(60), nullable=True)      # the rule that produced it, if any
    store_code = db.Column(db.String(30), nullable=True)
    subject = db.Column(db.String(255), nullable=False, default="")
    body_text = db.Column(db.Text, nullable=False, default="")
    body_html = db.Column(db.Text, nullable=True)
    # JSON lists of addresses, kept apart so Bcc never leaks into a Cc column.
    to_addrs = db.Column(db.Text, nullable=False, default="[]")
    cc_addrs = db.Column(db.Text, nullable=False, default="[]")
    bcc_addrs = db.Column(db.Text, nullable=False, default="[]")
    # The sender name the caller asked for; NULL = the configured one at send time.
    from_display = db.Column(db.String(120), nullable=True)
    status = db.Column(db.String(12), nullable=False, default=STATUS_QUEUED, index=True)
    attempts = db.Column(db.Integer, nullable=False, default=0)
    max_attempts = db.Column(db.Integer, nullable=False, default=5)
    # Naive UTC, like every other timestamp here. NULL once the mail is at rest.
    next_attempt_at = db.Column(db.DateTime, nullable=True, index=True)
    last_error = db.Column(db.String(500), nullable=True)
    refused = db.Column(db.Text, nullable=True)             # JSON list, set on PARTIAL
    trigger = db.Column(db.String(12), nullable=False, default=TRIGGER_MANUAL)
    triggered_by = db.Column(db.String(60), nullable=True)  # username, "scheduler" or "machine"
    # Reserve-then-send: the unique index is what stops two triggers mailing the
    # same thing — the second insert fails before anything is sent.
    dedup_key = db.Column(db.String(120), nullable=True, unique=True)
    sent_at = db.Column(db.DateTime, nullable=True)

    # passive_deletes: the daily purge is one bulk DELETE and the database's own
    # ON DELETE CASCADE removes the children, instead of loading every blob first.
    attachments = db.relationship(
        "EmailAttachment", backref="message", cascade="all, delete-orphan",
        passive_deletes=True, order_by="EmailAttachment.id")
    attempt_rows = db.relationship(
        "EmailAttempt", backref="message", cascade="all, delete-orphan",
        passive_deletes=True, order_by="EmailAttempt.id")

    @property
    def to_list(self):
        return _json_list(self.to_addrs)

    @property
    def cc_list(self):
        return _json_list(self.cc_addrs)

    @property
    def bcc_list(self):
        return _json_list(self.bcc_addrs)

    def to_dict(self, detail=False):
        """The Message of the mail-engine API. `detail` adds the bodies and the
        attempt log — left out of list rows, which can be 200 to a page."""
        data = {
            "id": self.id, "mail_type": self.mail_type, "rule_key": self.rule_key,
            "store_code": self.store_code, "subject": self.subject,
            "to": self.to_list, "cc": self.cc_list, "bcc": self.bcc_list,
            "status": self.status, "attempts": self.attempts, "max_attempts": self.max_attempts,
            "next_attempt_at": _iso(self.next_attempt_at), "last_error": self.last_error,
            "refused": _json_list(self.refused),
            "trigger": self.trigger, "triggered_by": self.triggered_by,
            "created_at": _iso(self.created_at), "sent_at": _iso(self.sent_at),
            "attachments": [{"filename": a.filename, "size": a.size} for a in self.attachments],
        }
        if detail:
            data["body_text"] = self.body_text
            data["body_html"] = self.body_html
            data["attempt_log"] = [a.to_dict() for a in self.attempt_rows]
        return data

    def __repr__(self):
        return f"<EmailMessage {self.id} {self.mail_type} {self.status}>"


class EmailAttachment(BaseModel):
    """A file that goes with a mail, kept as bytes so a retry sends exactly what
    the first attempt would have (the window-time sheet is built in memory and
    would come out different if rebuilt later)."""
    __tablename__ = "email_attachments"

    message_id = db.Column(db.Integer, db.ForeignKey("email_messages.id", ondelete="CASCADE"),
                           nullable=False, index=True)
    filename = db.Column(db.String(200), nullable=False)
    mime = db.Column(db.String(100), nullable=False, default="application/octet-stream")
    size = db.Column(db.Integer, nullable=False, default=0)
    # Deferred: listing a mail's attachments (name + size) must not pull the bytes.
    content = db.deferred(db.Column(db.LargeBinary, nullable=False))

    def __repr__(self):
        return f"<EmailAttachment {self.filename} ({self.size} bytes) msg={self.message_id}>"


class EmailAttempt(BaseModel):
    """One line of a mail's delivery history."""
    __tablename__ = "email_attempts"

    message_id = db.Column(db.Integer, db.ForeignKey("email_messages.id", ondelete="CASCADE"),
                           nullable=False, index=True)
    attempt_no = db.Column(db.Integer, nullable=False)
    outcome = db.Column(db.String(12), nullable=False)
    error = db.Column(db.String(500), nullable=True)

    def to_dict(self):
        return {"attempt_no": self.attempt_no, "at": _iso(self.created_at),
                "outcome": self.outcome, "error": self.error}

    def __repr__(self):
        return f"<EmailAttempt msg={self.message_id} #{self.attempt_no} {self.outcome}>"


class NotificationState(BaseModel):
    """What the reminder / escalation run remembers about one thing it watches
    (e.g. "tracker:MAINTENANCE:excess"): since when, when it last mailed, and how
    far it has gone. The alerts themselves are computed fresh on every read, so
    without this row a reminder would repeat on every tick."""
    __tablename__ = "notification_state"

    key = db.Column(db.String(120), unique=True, nullable=False, index=True)
    first_seen_at = db.Column(db.DateTime, nullable=True)
    last_notified_at = db.Column(db.DateTime, nullable=True)
    level = db.Column(db.Integer, nullable=False, default=0)   # 0 none · 1 reminded · 2 escalated
    last_count = db.Column(db.Integer, nullable=False, default=0)

    def __repr__(self):
        return f"<NotificationState {self.key} level={self.level}>"
