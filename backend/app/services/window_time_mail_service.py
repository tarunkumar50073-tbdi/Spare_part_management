"""Window-time daily auto-mail — builds the current month's 'VEHICLE WINDOW
TIME' sheet and e-mails it to the report recipients, replicating the store's
existing daily mail:

    From    : TBDI_store  (MAIL_FROM_DISPLAY)
    To / Cc : the Report Recipient master (report_key='window_time')
    Subject : SUPPLIER WINDOW TIME ON DATED DD.MM.YYYY
    Attach  : Supplier Wise Window Timing.xlsx
    Body    : Dear Sir, / Please find attached supplier window time sheet. / a dashed rule / Note: This is a system-generated mail.

Ships inert: with SMTP unset or no recipient address it returns a reason and
never raises. Durable idempotency (MailSendLog unique on report_key+report_date)
means the daily scheduler and a Windows-Task-Scheduler POST cannot double-send;
the 'Email now' button passes force=True to override.

The scheduler clones the ERP-ledger inbox poller (one guarded, reloader-safe
daemon thread). Server clock is assumed to be the plant wall clock
(Asia/Kolkata, no DST) — the same assumption supplier_window_schedule_service
documents.
"""
import logging
import threading
import time
from datetime import datetime, timedelta

from app.extensions import db
from app.models.mail_send_log import MailSendLog
from app.repositories.report_recipient_repository import ReportRecipientRepository
from app.repositories.supplier_window_schedule_repository import SHIFT_START
from app.services.email_engine import EmailEngine
from app.services.supplier_window_schedule_service import SupplierWindowScheduleService
from app.utils import mailer

logger = logging.getLogger("dxstore.window_time_mail")

REPORT_KEY = "window_time"
ATTACHMENT_NAME = "Supplier Wise Window Timing.xlsx"
_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


class WindowTimeMailService:
    _scheduler_started = False
    _lock = threading.Lock()

    def __init__(self):
        self.recipients = ReportRecipientRepository()
        self.windows = SupplierWindowScheduleService()

    @staticmethod
    def _wording(reported):
        """(subject, body) as Email Templates has them. The built-in text there
        is the Subject and Body in the note at the top of this file, word for
        word, so nothing changes until an admin saves another."""
        # Imported here: email_rules runs this service for its window-time rule.
        from app.services.email_rules import mail_wording
        words = mail_wording("window_time", date=reported)
        return words["subject"], f"{words['intro']}\n\n{words['footer']}"

    @staticmethod
    def _reported_date(at=None):
        """The operational day the mail is 'dated'. The plant day runs past
        midnight and the store mails early morning for the day just closed, so
        before the shift start (08:30) the reported day is yesterday, else today.
        `at` is the plant-clock moment the mail belongs to (default: now)."""
        at = at or datetime.now()
        return at.date() if at.time() >= SHIFT_START else at.date() - timedelta(days=1)

    def send_current_month(self, force=False, at=None):
        """Build + e-mail the current month's window-time sheet. force=True (the
        'Email now' button) always sends; force=False (scheduler / Task
        Scheduler) sends at most once per reported day. `at` dates the mail as
        of that plant-clock moment instead of now: a 07:00 rule that is caught
        up after the shift start still mails the sheet 07:00 would have, and
        leaves today's for tomorrow morning. Returns
        {status:'sent'|'skipped', reason?, to, cc, report_date}. Never raises."""
        reported = self._reported_date(at)
        result = {"report_date": reported.isoformat(), "to": [], "cc": []}

        if not mailer.smtp_is_configured():
            return {**result, "status": "skipped", "reason": "smtp_not_configured"}

        to, cc = self.recipients.recipients_for(REPORT_KEY)
        result["to"], result["cc"] = to, cc
        if not to:
            return {**result, "status": "skipped", "reason": "no_recipient_email"}

        if not force and MailSendLog.query.filter_by(report_key=REPORT_KEY, report_date=reported).first():
            return {**result, "status": "skipped", "reason": "already_sent_today"}

        try:
            buf, _, _ = self.windows.window_time_workbook(reported.year, reported.month)
            content = buf.getvalue()
        except Exception as exc:  # noqa: BLE001 — a report-build failure must not 500 the caller
            logger.exception("window-time workbook build failed")
            return {**result, "status": "skipped", "reason": "report_build_failed", "error": type(exc).__name__}

        subject, body = self._wording(reported)
        # Through the mail engine: same result dict as the mailer's, and the
        # mail is on record — a failed attempt is retried from the queue.
        sent = EmailEngine().submit(
            mail_type="window_time", subject=subject, body=body, to=to, cc=cc,
            attachments=[{"filename": ATTACHMENT_NAME, "content": content, "mime": _XLSX_MIME}],
            trigger="MANUAL" if force else "SCHEDULED",
            dedup_key=EmailEngine.report_dedup_key(REPORT_KEY, reported, force), mode="sync",
        )
        if not sent.get("ok"):
            return {**result, "status": "skipped", "reason": sent.get("reason", "send_failed")}

        # Record the send (durable idempotency + audit). Unique on
        # report_key+report_date — a race just makes the second insert a no-op we
        # swallow; the mail already went out either way.
        try:
            db.session.add(MailSendLog(report_key=REPORT_KEY, report_date=reported,
                                       to_addrs=", ".join(to), cc_addrs=", ".join(cc), subject=subject))
            db.session.commit()
        except Exception:  # noqa: BLE001
            db.session.rollback()
        return {**result, "status": "sent", "subject": subject}

    def status(self):
        # Imported here: email_rules runs this service for its window-time rule.
        from app.services.email_rules import rule_settings
        last = MailSendLog.query.filter_by(report_key=REPORT_KEY).order_by(MailSendLog.id.desc()).first()
        to, cc = self.recipients.recipients_for(REPORT_KEY)
        # The schedule is the notification rule's now (the .env flags are only
        # its default until an admin saves it).
        rule, _ = rule_settings("window_time_daily")
        return {
            "smtp_configured": mailer.smtp_is_configured(),
            "enabled": rule["enabled"],
            "hour": rule["hour"],
            "to": to, "cc": cc,
            "last_sent": last.to_dict() if last else None,
        }

    # ---- daily scheduler (clone of the ERP-ledger inbox poller) ----
    def start_scheduler(self, app):
        """Start the once-a-day mail thread. No-op unless WINDOW_TIME_MAIL_ENABLED
        is true AND SMTP is configured, and only once per process."""
        enabled = bool(app.config.get("WINDOW_TIME_MAIL_ENABLED"))
        configured = bool(app.config.get("SMTP_HOST"))
        if not enabled or not configured or WindowTimeMailService._scheduler_started:
            return
        WindowTimeMailService._scheduler_started = True
        hour = int(app.config.get("WINDOW_TIME_MAIL_HOUR", 7))

        def loop():
            while True:
                time.sleep(self._seconds_until(hour))
                try:
                    with app.app_context():
                        self.send_current_month(force=False)  # durable log makes this safe to re-enter
                except Exception:  # noqa: BLE001 — never let the thread die
                    logger.exception("window-time daily mail failed")

        threading.Thread(target=loop, name="window-time-mailer", daemon=True).start()

    @staticmethod
    def _seconds_until(hour):
        """Seconds from now to the next HH:00 (local clock). Always > 0 so the
        loop sleeps before the first send rather than firing at boot."""
        now = datetime.now()
        target = now.replace(hour=hour, minute=0, second=0, microsecond=0)
        if target <= now:
            target += timedelta(days=1)
        return max(1, int((target - now).total_seconds()))
