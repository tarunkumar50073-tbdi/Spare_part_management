"""Notification Engine — the durable mail queue, its worker and its log.

Every outgoing mail becomes an `email_messages` row FIRST and is sent second, so
a mail that could not go out is still on record with its reason, is retried
with a backoff, and can be retried or cancelled by an admin. Before this, a
failed send left nothing behind but a console warning and the next try was a
day later.

Two ways in, one row either way:

- `submit(mode="queue")` — new mails (rule digests, manual alerts, reminders).
  Returns at once; the worker sends.
- `submit(mode="sync")` — the three senders that existed before the engine
  (reorder list, window-time sheet, SMTP test). The first attempt is made
  inline and the mailer's own result dict goes back to the caller untouched, so
  their response shapes and skip reasons are exactly what they were. A failed
  inline attempt stays in the queue and the worker finishes the job.

`mailer.send_email` remains the only transport and is always called through the
module attribute, so a test that monkeypatches it stubs the engine too. The
SMTP password is never read, stored or logged here.

Timestamps are naive UTC like the rest of the app; "today" and the day series
in `status()` are plant-clock days through the measured server offset.
"""
import importlib.util
import json
import logging
import threading
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from datetime import time as day_time

from flask import current_app, has_request_context
from marshmallow import ValidationError as AddressError
from marshmallow import validate
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.email_engine import (
    MAIL_STATUSES, OUTCOME_DEFERRED, OUTCOME_FAILED, STATUS_CANCELLED, STATUS_FAILED,
    STATUS_PARTIAL, STATUS_QUEUED, STATUS_SENDING, STATUS_SENT, STATUS_SKIPPED,
    TRIGGER_MANUAL, TRIGGER_TEST, TRIGGERS, EmailAttachment, EmailAttempt, EmailMessage,
)
from app.models.mail_send_log import MailSendLog
from app.services.consumption_analytics_service import _local_offset, _utc_naive
from app.utils import mailer
from app.utils.authz import current_user, is_machine
from app.utils.exceptions import BadRequestError, NotFoundError

logger = logging.getLogger("dxstore.email_engine")

ENGINE_SETTING_KEY = "mail_engine"
ENGINE_DEFAULTS = {"enabled": True, "poll_seconds": 60, "max_attempts": 5, "retention_days": 90}
# Allowed range of each number. Enforced on save AND on read, so a hand-edited
# row can never make the worker spin (poll_seconds 0) or purge yesterday's log.
SETTING_RANGES = {"poll_seconds": (15, 3600), "max_attempts": (1, 10), "retention_days": (7, 365)}

MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024     # per mail, all files together
# Wait after the 1st, 2nd, … failed attempt; the last value repeats.
BACKOFF_MINUTES = (1, 5, 15, 60, 360)
# A mail left in SENDING this long was abandoned (a send that outlives it is not
# plausible with the 20 s SMTP timeout), so the worker may take it again.
STALE_SENDING_MINUTES = 30
FIRST_TICK_SECONDS = 5                      # let the server finish booting first

# Trying again cannot fix these: the mail itself is wrong.
PERMANENT_REASONS = ("no_recipient", "invalid_header")
# Nothing was attempted because the mail server settings are not usable yet. The
# mail waits for an admin to fix them; no attempt is used up.
WAIT_REASONS = ("smtp_not_configured", "auth_requires_tls")
ENGINE_OFF = "mail_engine_disabled"
# What the log shows for the reasons the Email screens have no wording of their
# own for (the four in the contract are stored as their code).
REASON_TEXT = {
    "auth_requires_tls": "The mail server sign-in needs TLS or SSL — switch one on in Email Configuration",
    ENGINE_OFF: "The mail engine is switched off",
}
# The two once-a-day reports whose senders still keep `mail_send_logs`.
DAILY_REPORT_TYPES = ("reorder", "window_time")
# Rows the daily purge may drop. FAILED and PARTIAL stay: they need someone.
PURGEABLE = (STATUS_SENT, STATUS_SKIPPED, STATUS_CANCELLED)
# What a second trigger for an already-reserved daily report is told, by the
# state of the mail that holds the reservation.
DUPLICATE_REASON = {
    STATUS_QUEUED: "already_queued", STATUS_SENDING: "already_queued",
    STATUS_SENT: "already_sent_today", STATUS_PARTIAL: "already_sent_today",
}

# The same rule the recipient masters apply (marshmallow fields.Email), so an
# address those screens accept is never dropped here and the reverse.
_address_ok = validate.Email()


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _valid_address(value):
    if not isinstance(value, str):
        return None
    addr = value.strip()
    # CR/LF first: a line break in an address is a header-injection attempt.
    if not addr or "\n" in addr or "\r" in addr:
        return None
    try:
        _address_ok(addr)
    except AddressError:
        return None
    return addr


def normalise_recipients(to, cc=None, bcc=None):
    """(to, cc, bcc) cleaned for sending: trimmed, format-checked and each
    address kept once, whatever its letter case, in the most visible role it
    was given (To wins over Cc, Cc over Bcc). A mail with Cc but no To gets its
    first Cc as To, because a blank To header reads as malformed and raises the
    spam score; a Bcc is never promoted — that would unhide it."""
    seen, cleaned = set(), []
    for bucket in (to, cc, bcc):
        keep = []
        for raw in ([bucket] if isinstance(bucket, str) else bucket or []):
            addr = _valid_address(raw)
            if addr and addr.lower() not in seen:
                seen.add(addr.lower())
                keep.append(addr)
        cleaned.append(keep)
    to, cc, bcc = cleaned
    if not to and cc:
        to, cc = cc[:1], cc[1:]
    return to, cc, bcc


def _error_text(result):
    """What goes in last_error for a failed mailer result: the reason, or for a
    send that reached the server its own answer ("SMTPDataError: 554 …")."""
    reason = result.get("reason") or "send_failed"
    if reason != "send_failed":
        return REASON_TEXT.get(reason, reason)
    error, detail = result.get("error"), result.get("detail")
    text = f"{error}: {detail}" if error and detail else (error or detail or reason)
    return str(text)[:500]


def _report_ref(mail_type, dedup_key):
    """(report_key, report_date) of the `mail_send_logs` row a daily report mail
    stands for, read back out of its dedup key; None for any other mail."""
    if mail_type not in DAILY_REPORT_TYPES or not dedup_key:
        return None
    parts = dedup_key.split(":")
    if len(parts) < 2:
        return None
    try:
        return parts[0], date.fromisoformat(parts[1])
    except ValueError:
        return None


def _rules_module():
    """The rules / reminders module, or None while it has not been built. A
    module that is there but fails to import is NOT 'no rules' — that error goes
    up so it shows on the engine's health instead of the schedule going quiet."""
    try:
        from app.services import email_rules
    except ImportError:
        if importlib.util.find_spec("app.services.email_rules") is not None:
            raise
        return None
    return email_rules


class EmailEngine:
    # Class-level so the health survives across requests and the worker thread.
    _worker_started = False
    _thread = None
    _last_tick_at = None
    _last_error = None
    _consecutive_failures = 0
    _last_purge_day = None

    # ---- settings (app_settings key "mail_engine") ----

    @staticmethod
    def forced_off():
        """True on a server started with MAIL_ENGINE_FORCE_OFF=1. That is for a
        server running on a COPY of the plant's database (the TEST instance):
        the copy carries the real recipients, the switched-on rules and the
        queued mails, so the kill-switch there must not depend on what the
        copied settings say."""
        return bool(current_app.config.get("MAIL_ENGINE_FORCE_OFF"))

    @staticmethod
    def _saved_settings():
        saved = AppSetting.get_value(ENGINE_SETTING_KEY, {}) or {}
        out = dict(ENGINE_DEFAULTS)
        if isinstance(saved.get("enabled"), bool):
            out["enabled"] = saved["enabled"]
        for key, (low, high) in SETTING_RANGES.items():
            value = saved.get(key)
            if isinstance(value, int) and not isinstance(value, bool):
                out[key] = min(max(value, low), high)
        return out

    def settings(self):
        """The settings in effect: what is saved, with the kill-switch held
        off on a server that was started with mail forced off."""
        out = self._saved_settings()
        if self.forced_off():
            out["enabled"] = False
        return out

    def save_settings(self, data, user=None):
        """Merge the given settings over the saved ones and return the settings
        in effect. An unknown field or a value out of range is refused whole,
        so a typo cannot half-apply."""
        if not isinstance(data, dict) or not data:
            raise BadRequestError("Send at least one of: enabled, poll_seconds, max_attempts, retention_days")
        unknown = sorted(set(data) - set(ENGINE_DEFAULTS))
        if unknown:
            raise BadRequestError(f"Unknown mail engine setting: {', '.join(unknown)}")
        if "enabled" in data and not isinstance(data["enabled"], bool):
            raise BadRequestError("'enabled' must be true or false")
        for key, (low, high) in SETTING_RANGES.items():
            if key not in data:
                continue
            value = data[key]
            if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
                raise BadRequestError(f"'{key}' must be a whole number from {low} to {high}")
        # Over what is SAVED, not what is in effect: a forced-off server must
        # not write its "off" into the row.
        current = self._saved_settings()
        current.update(data)
        AppSetting.set_value(ENGINE_SETTING_KEY, current, user)
        return self.settings()

    # ---- submit ----

    @staticmethod
    def report_dedup_key(report_key, report_date, force=False):
        """The dedup key of a once-a-day report mail: "<report_key>:<YYYY-MM-DD>".

        It does two jobs. Unforced (the scheduler, an unattended trigger) it is
        the reservation — a second trigger for the same report and day finds it
        and sends nothing. And it is the link back to `mail_send_logs`: when the
        worker delivers a mail whose inline attempt had failed, it reads the
        report key and day out of it to write the log row the sender would have.
        A forced send (the button) must go out again every time, so it gets a
        unique tail: same link, no reservation."""
        key = f"{report_key}:{report_date.isoformat()}"
        return f"{key}:forced-{uuid.uuid4().hex[:12]}" if force else key

    @staticmethod
    def _actor():
        """Who asked for this mail, when the caller did not say: the signed-in
        user, "machine" for the X-API-Key caller, "scheduler" outside a request
        (the worker thread)."""
        if not has_request_context():
            return "scheduler"
        user = current_user()
        if user is not None:
            return user.username
        return "machine" if is_machine() else None

    @staticmethod
    def _clean_attachments(attachments):
        """[(filename, mime, bytes)] and the total size."""
        files, total = [], 0
        for att in attachments or []:
            content = bytes(att.get("content") or b"")
            total += len(content)
            files.append((str(att.get("filename") or "attachment")[:200],
                          str(att.get("mime") or "application/octet-stream")[:100], content))
        return files, total

    def submit(self, *, mail_type, subject, body, to, cc=None, bcc=None, attachments=None, html=None,
               from_display=None, trigger=TRIGGER_MANUAL, triggered_by=None, rule_key=None,
               store_code=None, dedup_key=None, mode="queue"):
        """Record a mail and queue it (`mode="queue"`, returns the message dict)
        or make the first attempt right now (`mode="sync"`, returns the mailer's
        result dict unchanged). A `dedup_key` already on a row means this mail
        was asked for before: no new row, nothing sent.

        Commits the session, like AppSetting.set_value does."""
        if mode not in ("queue", "sync"):
            raise ValueError(f"mode must be 'queue' or 'sync', not {mode!r}")
        if trigger not in TRIGGERS:
            raise ValueError(f"trigger must be one of {', '.join(TRIGGERS)}, not {trigger!r}")
        sync = mode == "sync"
        if dedup_key:
            existing = EmailMessage.query.filter_by(dedup_key=dedup_key).first()
            if existing is not None:
                return self._duplicate(existing, sync)

        settings = self.settings()
        to, cc, bcc = normalise_recipients(to, cc, bcc)
        files, total = self._clean_attachments(attachments)
        # A test mail answers "do the settings work NOW": one attempt, and it
        # never waits in the queue to turn up hours later.
        one_shot = trigger == TRIGGER_TEST
        engine_off = sync and not settings["enabled"]

        skip = None
        if not (to or cc or bcc):
            skip = "no_recipient"
        elif total > MAX_ATTACHMENT_BYTES:
            skip = "attachment_too_large"

        actor = triggered_by or self._actor()
        msg = EmailMessage(
            mail_type=mail_type, rule_key=rule_key, store_code=store_code,
            subject=(subject or "")[:255], body_text=body or "", body_html=html or None,
            to_addrs=json.dumps(to), cc_addrs=json.dumps(cc), bcc_addrs=json.dumps(bcc),
            from_display=str(from_display)[:120] if from_display else None,
            trigger=trigger, triggered_by=str(actor)[:60] if actor else None,
            dedup_key=dedup_key, attempts=0,
            max_attempts=1 if one_shot else settings["max_attempts"],
        )
        if skip:
            msg.status, msg.last_error = STATUS_SKIPPED, skip
        elif engine_off and one_shot:
            msg.status, msg.last_error = STATUS_SKIPPED, REASON_TEXT[ENGINE_OFF]
        elif engine_off:
            msg.status, msg.next_attempt_at, msg.last_error = STATUS_QUEUED, _now(), REASON_TEXT[ENGINE_OFF]
        elif sync:
            # SENDING from the first commit, so the worker cannot pick the row
            # up while the inline attempt below is still talking to the server.
            msg.status = STATUS_SENDING
        else:
            msg.status, msg.next_attempt_at = STATUS_QUEUED, _now()
        for filename, mime, content in files:
            # A mail that is too large is on record with its file names and
            # sizes, but the oversized bytes themselves are not kept.
            msg.attachments.append(EmailAttachment(
                filename=filename, mime=mime, size=len(content),
                content=b"" if skip == "attachment_too_large" else content))
        db.session.add(msg)
        try:
            db.session.commit()
        except IntegrityError:
            # Two triggers raced for the same dedup key and this one lost: the
            # unique index is the lock, the other mail is the one that goes.
            db.session.rollback()
            existing = EmailMessage.query.filter_by(dedup_key=dedup_key).first() if dedup_key else None
            if existing is None:
                raise
            return self._duplicate(existing, sync)

        if not sync:
            return msg.to_dict()
        if skip:
            return {"ok": False, "reason": skip}
        if engine_off:
            return {"ok": False, "reason": ENGINE_OFF}
        msg_id = msg.id
        result = self._send(self._mailer_kwargs(msg))
        self._record_outcome(db.session.get(EmailMessage, msg_id), result,
                             settings["poll_seconds"], by_worker=False)
        return result

    @staticmethod
    def _duplicate(existing, sync):
        if sync:
            return {"ok": False, "reason": DUPLICATE_REASON.get(existing.status, "already_tried_today")}
        return {**existing.to_dict(), "duplicate": True}

    # ---- sending ----

    @staticmethod
    def _mailer_kwargs(msg):
        """The keyword arguments of mailer.send_email for a stored mail — plain
        data, read before the SMTP call so no row is touched during it. `html`
        and `reply_to` are passed only when there is one, so a stub written
        against the mailer's older signature still fits."""
        kwargs = {
            "subject": msg.subject, "body": msg.body_text,
            "to": msg.to_list, "cc": msg.cc_list, "bcc": msg.bcc_list,
            "attachments": [{"filename": a.filename, "content": a.content, "mime": a.mime}
                            for a in msg.attachments],
            "from_display": msg.from_display,
        }
        if msg.body_html:
            kwargs["html"] = msg.body_html
        reply_to = EmailEngine._reply_to()
        if reply_to:
            kwargs["reply_to"] = reply_to
        return kwargs

    @staticmethod
    def _reply_to():
        """The Reply-To address saved on Email Templates — one for every mail,
        read at send time so a change applies to what is already queued — or
        None. Failing to read it costs the header, never the mail."""
        try:
            rules = _rules_module()
            return rules.identity()["reply_to"] if rules is not None else None
        except Exception:  # noqa: BLE001 — the mail still goes, with replies to its From address
            db.session.rollback()
            logger.exception("the Reply-To address could not be read")
            return None

    @staticmethod
    def _send(kwargs):
        """One attempt through the mailer. The mailer does not raise for an SMTP
        failure, but it builds the MIME message before its own try block, so an
        odd attachment or header still can — and a mail must never be left in
        SENDING because of that."""
        # Ends the read transaction the row was loaded in: nothing of this
        # session is open on the database for the (up to 20 s) SMTP call.
        db.session.commit()
        try:
            return mailer.send_email(**kwargs)
        except Exception as exc:  # noqa: BLE001 — becomes a failed attempt, never a crash
            logger.warning("mail attempt raised %s", type(exc).__name__)
            return {"ok": False, "reason": "send_failed", "error": type(exc).__name__}

    @staticmethod
    def _log_attempt(msg, outcome, error, attempt_no=None):
        db.session.add(EmailAttempt(message_id=msg.id, attempt_no=attempt_no or msg.attempts,
                                    outcome=outcome, error=error))

    def _hold(self, msg, error, poll_seconds):
        """Keep a mail waiting for usable mail server settings. Not an attempt:
        the counter stays, and the log gets one DEFERRED line per reason rather
        than one per tick while nobody fixes the settings."""
        if msg.trigger == TRIGGER_TEST:
            msg.status, msg.next_attempt_at = STATUS_SKIPPED, None
        else:
            msg.status = STATUS_QUEUED
            msg.next_attempt_at = _now() + timedelta(seconds=poll_seconds)
        if msg.last_error != error:
            self._log_attempt(msg, OUTCOME_DEFERRED, error, attempt_no=msg.attempts + 1)
        msg.last_error = error
        return "failed" if msg.status == STATUS_SKIPPED else "deferred"

    def _record_outcome(self, msg, result, poll_seconds, by_worker):
        """Write one attempt's result to the mail and its log, and commit.
        Returns "sent", "failed" (final) or "deferred" (back in the queue)."""
        if result.get("ok"):
            refused = [str(a) for a in (result.get("refused") or [])]
            msg.attempts += 1
            msg.status = STATUS_PARTIAL if refused else STATUS_SENT
            msg.refused = json.dumps(refused) if refused else None
            msg.sent_at, msg.next_attempt_at, msg.last_error = _now(), None, None
            self._log_attempt(msg, msg.status, None)
            db.session.commit()
            if by_worker:
                self._write_send_log(msg)
            return "sent"

        error = _error_text(result)
        if result.get("reason") in WAIT_REASONS:
            outcome = self._hold(msg, error, poll_seconds)
            db.session.commit()
            return outcome

        msg.attempts += 1
        final = (result.get("reason") in PERMANENT_REASONS or bool(result.get("permanent"))
                 or msg.attempts >= msg.max_attempts)
        msg.last_error = error
        if final:
            msg.status, msg.next_attempt_at = STATUS_FAILED, None
        else:
            wait = BACKOFF_MINUTES[min(msg.attempts, len(BACKOFF_MINUTES)) - 1]
            msg.status, msg.next_attempt_at = STATUS_QUEUED, _now() + timedelta(minutes=wait)
        self._log_attempt(msg, OUTCOME_FAILED, error)
        db.session.commit()
        return "failed" if final else "deferred"

    @staticmethod
    def _write_send_log(msg):
        """A daily report the worker delivered after its inline attempt had
        failed: write the `mail_send_logs` row its sender writes on an inline
        success. Without it the sender's own once-a-day check would find nothing
        and a later run would mail the same report again."""
        ref = _report_ref(msg.mail_type, msg.dedup_key)
        if ref is None:
            return
        report_key, report_date = ref
        try:
            db.session.add(MailSendLog(
                report_key=report_key, report_date=report_date, subject=msg.subject[:255],
                to_addrs=", ".join(msg.to_list)[:500],
                cc_addrs=", ".join(msg.cc_list + msg.bcc_list)[:500]))
            db.session.commit()
        except Exception:  # noqa: BLE001 — the mail already went; a row for that day already existing is fine
            db.session.rollback()

    @staticmethod
    def _superseded(msg):
        """True for a daily report mail that must not go out any more: since it
        was asked for, another mail has delivered the same report of the same
        day. That is the list a failed attempt left in the queue once "send
        now" got through, and all but the first of several mails held while the
        engine was off — sent as well, they would hand the department the same
        report twice, the second copy with an older list. A report asked for
        again AFTER a delivery is not superseded and goes. A superseded mail
        put back in the queue by hand is closed the same way: "send now" is
        how a report is mailed again, with today's list."""
        ref = _report_ref(msg.mail_type, msg.dedup_key)
        if ref is None:
            return False
        report_key, report_date = ref
        day_key = EmailEngine.report_dedup_key(report_key, report_date)
        return db.session.query(EmailMessage.id).filter(
            EmailMessage.id != msg.id,
            EmailMessage.mail_type == msg.mail_type,
            EmailMessage.status.in_((STATUS_SENT, STATUS_PARTIAL)),
            EmailMessage.sent_at > _utc_naive(msg.created_at),
            or_(EmailMessage.dedup_key == day_key,
                EmailMessage.dedup_key.startswith(f"{day_key}:forced-", autoescape=True)),
        ).first() is not None

    def process_due(self, limit=25):
        """The worker step: attempt every queued mail whose time has come.
        Returns {"processed", "sent", "failed", "deferred"} — sent includes
        PARTIAL, failed is final, deferred is back in the queue. A daily report
        that another mail has delivered in the meantime is not attempted: it
        is closed as CANCELLED, "already_sent_today"."""
        out = {"processed": 0, "sent": 0, "failed": 0, "deferred": 0}
        settings = self.settings()
        if not settings["enabled"]:
            return out
        poll = settings["poll_seconds"]
        due = (EmailMessage.query
               .filter(EmailMessage.status == STATUS_QUEUED, EmailMessage.next_attempt_at <= _now())
               .order_by(EmailMessage.next_attempt_at.asc(), EmailMessage.id.asc())
               .limit(limit).all())
        if not due:
            return out
        # Checked on every pass against the EFFECTIVE settings (the Settings
        # screen over .env), never once at boot — saving a mail server takes
        # effect on the next tick with no restart.
        if not mailer.smtp_is_configured():
            for msg in due:
                out[self._hold(msg, "smtp_not_configured", poll)] += 1
            db.session.commit()
            out["processed"] = len(due)
            return out

        for msg_id in [m.id for m in due]:
            # The kill-switch is read again for every mail: switched off while
            # this pass is under way, what has not been taken yet stays queued.
            if not self.settings()["enabled"]:
                break
            # The claim: only one caller's UPDATE matches while the row is still
            # QUEUED, so the worker and a "process now" click cannot both send it.
            claimed = (EmailMessage.query.filter_by(id=msg_id, status=STATUS_QUEUED)
                       .update({"status": STATUS_SENDING}, synchronize_session=False))
            db.session.commit()
            if not claimed:
                continue
            msg = db.session.get(EmailMessage, msg_id)
            if self._superseded(msg):
                msg.status, msg.next_attempt_at, msg.last_error = STATUS_CANCELLED, None, "already_sent_today"
                db.session.commit()
                continue
            result = self._send(self._mailer_kwargs(msg))
            out[self._record_outcome(db.session.get(EmailMessage, msg_id), result, poll, by_worker=True)] += 1
            out["processed"] += 1
        return out

    def requeue_stale_sending(self, older_than_minutes=None):
        """Put mails left in SENDING back in the queue: all of them at start-up
        (nothing can be mid-send in a process that has just started), and
        while running only those abandoned for longer than a send can take."""
        query = EmailMessage.query.filter(EmailMessage.status == STATUS_SENDING)
        if older_than_minutes is not None:
            query = query.filter(EmailMessage.updated_at < _now() - timedelta(minutes=older_than_minutes))
        count = query.update({"status": STATUS_QUEUED, "next_attempt_at": _now()}, synchronize_session=False)
        db.session.commit()
        return count

    # ---- admin actions ----

    @staticmethod
    def _get(message_id):
        msg = db.session.get(EmailMessage, message_id)
        if msg is None:
            raise NotFoundError(f"Mail {message_id} not found")
        return msg

    def get_message(self, message_id):
        return self._get(message_id).to_dict(detail=True)

    def retry(self, message_id):
        """Put a failed, cancelled or partly delivered mail back in the queue
        with a fresh attempt count. It goes to all its recipients again."""
        msg = self._get(message_id)
        if msg.status not in (STATUS_FAILED, STATUS_CANCELLED, STATUS_PARTIAL):
            raise BadRequestError(
                f"Only a failed, cancelled or partly delivered mail can be retried — this one is {msg.status}")
        msg.status, msg.attempts, msg.next_attempt_at = STATUS_QUEUED, 0, _now()
        msg.last_error, msg.refused, msg.sent_at = None, None, None
        db.session.commit()
        return msg.to_dict()

    def cancel(self, message_id):
        """Take a queued mail out of the queue, or dismiss a failed one so it
        no longer counts as a failure waiting for someone. Either way it is
        CANCELLED: the worker never takes it, the purge drops it with the
        other finished mails, and only `retry` puts it back in the queue."""
        msg = self._get(message_id)
        # Conditional, like the worker's claim: a mail the worker took a moment
        # ago is already SENDING and must not be marked cancelled under it.
        cancelled = (EmailMessage.query
                     .filter(EmailMessage.id == msg.id, EmailMessage.status.in_((STATUS_QUEUED, STATUS_FAILED)))
                     .update({"status": STATUS_CANCELLED, "next_attempt_at": None}, synchronize_session=False))
        db.session.commit()
        if not cancelled:
            raise BadRequestError(f"Only a queued or failed mail can be cancelled — this one is {msg.status}")
        return msg.to_dict()

    def list_messages(self, statuses=None, mail_type=None, q=None, page=1, per_page=50):
        """Mails newest first, as {"items", "meta"}. `statuses` is a list;
        `q` matches the subject or any address."""
        query = EmailMessage.query
        if statuses:
            bad = sorted(set(statuses) - set(MAIL_STATUSES))
            if bad:
                raise BadRequestError(f"Unknown status: {', '.join(bad)}")
            query = query.filter(EmailMessage.status.in_(statuses))
        if mail_type:
            query = query.filter(EmailMessage.mail_type == mail_type)
        if q:
            # The user's text is a literal: escape LIKE's own wildcards in it.
            like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            query = query.filter(or_(*(col.ilike(like, escape="\\") for col in (
                EmailMessage.subject, EmailMessage.to_addrs, EmailMessage.cc_addrs, EmailMessage.bcc_addrs))))
        page, per_page = max(page, 1), min(max(per_page, 1), 200)
        total = query.count()
        rows = (query.options(selectinload(EmailMessage.attachments))
                .order_by(EmailMessage.id.desc())
                .offset((page - 1) * per_page).limit(per_page).all())
        total_pages = (total + per_page - 1) // per_page
        return {
            "items": [m.to_dict() for m in rows],
            "meta": {"page": page, "per_page": per_page, "total": total, "total_pages": total_pages,
                     "has_prev": page > 1, "has_next": page < total_pages},
        }

    # ---- status (the Control Center) ----

    def status(self):
        # Imported here: settings_service sends its test mail through this module.
        from app.services.settings_service import SettingsService
        smtp = SettingsService().smtp_config()
        settings = self.settings()
        cls = EmailEngine
        now, offset = _now(), _local_offset()
        today = (now + offset).date()
        days = [today - timedelta(days=n) for n in range(6, -1, -1)]
        first_of_30 = today - timedelta(days=29)
        since = datetime.combine(first_of_30, day_time.min) - offset

        def local_day(ts):
            return (_utc_naive(ts) + offset).date()

        # A mail's sent / failed / skipped moment is never after its last
        # update, so "touched in the last 30 days" covers every row counted below.
        recent = (db.session.query(EmailMessage.mail_type, EmailMessage.status, EmailMessage.sent_at,
                                   EmailMessage.updated_at, EmailMessage.created_at)
                  .filter(EmailMessage.updated_at >= since).all())
        today_counts = {"sent": 0, "failed": 0, "skipped": 0}
        per_day = {d: {"sent": 0, "failed": 0} for d in days}
        per_type = {}
        for mail_type, status, sent_at, updated_at, created_at in recent:
            if status in (STATUS_SENT, STATUS_PARTIAL) and sent_at is not None:
                kind, day = "sent", local_day(sent_at)
            elif status == STATUS_FAILED:
                kind, day = "failed", local_day(updated_at)
            elif status == STATUS_SKIPPED:
                kind, day = "skipped", local_day(created_at)
            else:
                continue
            if day == today:
                today_counts[kind] += 1
            if kind == "skipped" or day < first_of_30:
                continue
            per_type.setdefault(mail_type, {"sent": 0, "failed": 0})[kind] += 1
            if day in per_day:
                per_day[day][kind] += 1

        by_status = dict(db.session.query(EmailMessage.status, func.count(EmailMessage.id))
                         .group_by(EmailMessage.status).all())
        oldest = (EmailMessage.query.filter_by(status=STATUS_QUEUED)
                  .order_by(EmailMessage.created_at.asc()).first())
        last_sent = (EmailMessage.query.filter(EmailMessage.sent_at.isnot(None))
                     .order_by(EmailMessage.sent_at.desc()).first())
        last_failure = (EmailMessage.query.filter_by(status=STATUS_FAILED)
                        .order_by(EmailMessage.updated_at.desc()).first())
        return {
            "smtp": {k: smtp[k] for k in ("configured", "host", "port", "from_email",
                                          "from_display", "password_in_env")},
            "engine": {
                "enabled": settings["enabled"],
                # Off because the server was started that way, not by the switch.
                "forced_off": self.forced_off(),
                "worker_running": bool(cls._thread is not None and cls._thread.is_alive()),
                "last_tick_at": cls._last_tick_at.isoformat() if cls._last_tick_at else None,
                "last_error": cls._last_error,
                "consecutive_failures": cls._consecutive_failures,
                "poll_seconds": settings["poll_seconds"],
                "max_attempts": settings["max_attempts"],
                "retention_days": settings["retention_days"],
            },
            "queue": {
                "queued": by_status.get(STATUS_QUEUED, 0), "sending": by_status.get(STATUS_SENDING, 0),
                "failed": by_status.get(STATUS_FAILED, 0),
                "oldest_queued_at": _utc_naive(oldest.created_at).isoformat() if oldest else None,
            },
            "today": today_counts,
            "last_7_days": [{"date": d.isoformat(), **per_day[d]} for d in days],
            "by_type_30d": [{"mail_type": t, **per_type[t]} for t in sorted(per_type)],
            "rules": self._rules_summary(),
            "last_sent": {"id": last_sent.id, "subject": last_sent.subject,
                          "sent_at": last_sent.sent_at.isoformat()} if last_sent else None,
            "last_failure": {"id": last_failure.id, "subject": last_failure.subject,
                             "at": _utc_naive(last_failure.updated_at).isoformat(),
                             "error": last_failure.last_error} if last_failure else None,
            "generated_at": now.isoformat(),
        }

    @staticmethod
    def _rules_summary():
        """The "rules" block of the status. A rules module that is missing or
        broken must not take the whole Control Center down with it."""
        try:
            rules = _rules_module()
            if rules is not None:
                return rules.rules_summary()
        except Exception:  # noqa: BLE001 — the status still has to render
            db.session.rollback()
            logger.exception("rules summary failed")
        return {"enabled": 0, "total": 0, "next": None}

    # ---- worker ----

    def purge_old(self, retention_days):
        """Drop sent, skipped and cancelled mails older than the retention —
        with their attachments and attempt lines (ON DELETE CASCADE)."""
        cutoff = _now() - timedelta(days=retention_days)
        count = (EmailMessage.query
                 .filter(EmailMessage.status.in_(PURGEABLE), EmailMessage.created_at < cutoff)
                 .delete(synchronize_session=False))
        db.session.commit()
        return count

    def _purge_if_due(self, retention_days):
        today = (_now() + _local_offset()).date()
        if EmailEngine._last_purge_day == today:
            return 0
        count = self.purge_old(retention_days)
        EmailEngine._last_purge_day = today
        return count

    @staticmethod
    def _step(name, fn, errors):
        """Run one part of a tick. Its failure is recorded and rolled back, and
        the parts after it still run — a broken rule must not stop the queue."""
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 — never let one step end the tick
            db.session.rollback()
            logger.exception("email-engine: %s failed", name)
            errors.append(f"{name}: {type(exc).__name__}: {exc}"[:240])
            return None

    def tick(self):
        """One pass of the worker: due rules, due reminders, the queue, and once
        a day the purge. Never raises. With the engine switched off it does
        nothing at all — no mail is generated, sent or removed."""
        cls = EmailEngine
        summary = {"enabled": True, "processed": 0, "sent": 0, "failed": 0, "deferred": 0,
                   "purged": 0, "errors": [], "poll_seconds": ENGINE_DEFAULTS["poll_seconds"]}
        errors = summary["errors"]
        settings = self._step("settings", self.settings, errors)
        if settings is not None:
            summary["enabled"] = settings["enabled"]
            summary["poll_seconds"] = settings["poll_seconds"]
            if settings["enabled"]:
                rules = self._step("rules module", _rules_module, errors)
                if rules is not None:
                    self._step("rules", lambda: rules.run_due_rules(self), errors)
                    self._step("reminders", lambda: rules.run_due_reminders(self), errors)
                self._step("stale mails", lambda: self.requeue_stale_sending(STALE_SENDING_MINUTES), errors)
                summary.update(self._step("queue", self.process_due, errors) or {})
                summary["purged"] = self._step(
                    "purge", lambda: self._purge_if_due(settings["retention_days"]), errors) or 0
        cls._last_tick_at = _now()
        if errors:
            cls._last_error = "; ".join(errors)[:500]
            cls._consecutive_failures += 1
        else:
            cls._last_error = None
            cls._consecutive_failures = 0
        return summary

    @classmethod
    def start_worker(cls, app):
        """Start the "email-engine" thread, once per process. It is NOT gated on
        SMTP being configured: the old mail threads checked that once at boot
        and then never ran when the server was set up later from the Settings
        screen. This one always runs and asks on every tick."""
        if cls._worker_started:
            return
        cls._worker_started = True
        try:
            with app.app_context():
                cls().requeue_stale_sending()
        except Exception:  # noqa: BLE001 — a failed clean-up must not stop the boot
            logger.exception("email-engine: could not requeue mails left in SENDING")

        def loop():
            delay = FIRST_TICK_SECONDS
            while True:
                time.sleep(delay)
                try:
                    with app.app_context():
                        delay = cls().tick()["poll_seconds"]
                except Exception:  # noqa: BLE001 — never let the worker thread die
                    logger.exception("email-engine tick crashed")
                    delay = ENGINE_DEFAULTS["poll_seconds"]

        cls._thread = threading.Thread(target=loop, name="email-engine", daemon=True)
        cls._thread.start()
