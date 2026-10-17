"""Notification Engine: the durable mail queue, its retries, its log and its API.

No test here can send a real mail. An autouse fixture replaces
`mailer.send_email` with a stub that fails the test if a case forgot to install
its own, and the transport-level cases swap `smtplib.SMTP` for a fake.

The test database is shared by the whole pytest session, so every assertion is
on rows this file created (by id, or by a subject unique to the case) and never
on a table total. The same fixture parks mails other cases left in the queue,
puts back the two app settings touched here, and restores the engine's
class-level health state.
"""
import io
import smtplib
import threading
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.department import Department
from app.models.department_recipient import DepartmentRecipient
from app.models.email_engine import EmailAttachment, EmailAttempt, EmailMessage
from app.models.mail_send_log import MailSendLog
from app.models.user import User
from app.services import email_engine
from app.services.email_engine import EmailEngine, normalise_recipients
from app.utils import mailer, rate_limit
from app.utils.exceptions import BadRequestError, NotFoundError, ValidationError

# The real transport, taken before any stub goes in — only ever called below
# with smtplib.SMTP replaced by a fake.
_REAL_SEND = mailer.send_email
_ABSENT = object()
_BASE = "/api/v1/mail-engine"

_TRANSIENT = {"ok": False, "reason": "send_failed", "error": "SMTPServerDisconnected",
              "detail": "Connection unexpectedly closed"}
_PERMANENT = {"ok": False, "reason": "send_failed", "error": "SMTPAuthenticationError",
              "detail": "535 5.7.8 Username and Password not accepted", "permanent": True}


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _ok(kw):
    return {"ok": True, "to": kw["to"], "cc": kw["cc"], "bcc": kw["bcc"]}


class Sender:
    """A stand-in for mailer.send_email: records every call (keyword arguments
    only, like the real callers use) and answers from a script of results; the
    last one repeats."""

    def __init__(self, *results):
        self.results = list(results) or [_ok]
        self.calls = []

    def __call__(self, **kw):
        self.calls.append(kw)
        result = self.results.pop(0) if len(self.results) > 1 else self.results[0]
        return result(kw) if callable(result) else result


def _unpatched_send(**kw):
    raise AssertionError("this test reached mailer.send_email without stubbing it")


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    saved = {key: AppSetting.get_value(key, _ABSENT) for key in ("mail_engine", "smtp")}
    # Mails other cases left waiting would be picked up by this case's
    # process_due and sent through its stub — park them first.
    EmailMessage.query.filter(EmailMessage.status.in_(["QUEUED", "SENDING"])).update(
        {"status": "CANCELLED", "next_attempt_at": None}, synchronize_session=False)
    db.session.commit()
    monkeypatch.setattr(mailer, "send_email", _unpatched_send)
    monkeypatch.setattr(mailer, "smtp_is_configured", lambda: True)
    for attr in ("_worker_started", "_thread", "_last_tick_at", "_last_error",
                 "_consecutive_failures", "_last_purge_day"):
        monkeypatch.setattr(EmailEngine, attr, getattr(EmailEngine, attr))
    try:
        yield
    finally:
        db.session.rollback()
        for key, value in saved.items():
            if value is _ABSENT:
                AppSetting.query.filter_by(key=key).delete()
                db.session.commit()
            else:
                AppSetting.set_value(key, value)


@pytest.fixture()
def engine():
    return EmailEngine()


@pytest.fixture()
def send(monkeypatch):
    """Install a Sender as mailer.send_email; call it again with a script of
    results to change what the next sends answer."""
    def install(*results):
        sender = Sender(*results)
        monkeypatch.setattr(mailer, "send_email", sender)
        return sender
    return install


@pytest.fixture()
def client(app):
    return app.test_client()


_seq = {"n": 0}


def _subject(tag):
    return f"engine-test {tag} {uuid.uuid4().hex[:10]}"


def _user(role="ADMIN"):
    _seq["n"] += 1
    user = User(username=f"mailuser{_seq['n']}_{uuid.uuid4().hex[:6]}", role=role, is_active=True)
    user.set_password("pw")
    db.session.add(user)
    db.session.commit()
    return user


def _as(client, user):
    with client.session_transaction() as sess:
        sess["user_id"] = user.id
    return client


def _queue(engine, tag="mail", **kw):
    kw.setdefault("mail_type", "manual_alert")
    kw.setdefault("subject", _subject(tag))
    kw.setdefault("body", "Body text")
    kw.setdefault("to", ["one@example.com"])
    return engine.submit(**kw)


def _row(message_id):
    db.session.expire_all()
    return db.session.get(EmailMessage, message_id)


def _make_due(message_id):
    """Bring a backed-off mail's next attempt forward to now."""
    EmailMessage.query.filter_by(id=message_id).update(
        {"next_attempt_at": _now() - timedelta(seconds=1)}, synchronize_session=False)
    db.session.commit()


def _wait_seconds(message_id):
    return (_row(message_id).next_attempt_at - _now()).total_seconds()


def _attempts(message_id):
    return [(a.attempt_no, a.outcome, a.error) for a in
            EmailAttempt.query.filter_by(message_id=message_id).order_by(EmailAttempt.id).all()]


# ---- the queue ----

def test_queued_mail_is_sent_by_the_worker(engine, send):
    sender = send()
    queued = _queue(engine, cc=["two@example.com"], html="<p>Body</p>", rule_key="critical_digest",
                    store_code="MAINTENANCE", trigger="RULE")
    assert queued["status"] == "QUEUED" and queued["attempts"] == 0 and queued["max_attempts"] == 5
    assert queued["trigger"] == "RULE" and queued["triggered_by"] == "scheduler"   # no request, no user
    assert queued["next_attempt_at"] is not None and queued["sent_at"] is None
    assert sender.calls == []                                # queue mode never sends inline

    assert engine.process_due() == {"processed": 1, "sent": 1, "failed": 0, "deferred": 0}
    sent = _row(queued["id"])
    assert sent.status == "SENT" and sent.attempts == 1 and sent.sent_at is not None
    assert sent.next_attempt_at is None and sent.last_error is None
    assert _attempts(sent.id) == [(1, "SENT", None)]
    call = sender.calls[0]
    assert call["subject"] == queued["subject"] and call["body"] == "Body text"
    assert call["to"] == ["one@example.com"] and call["cc"] == ["two@example.com"] and call["bcc"] == []
    assert call["html"] == "<p>Body</p>"
    # A second pass finds nothing left to do.
    assert engine.process_due()["processed"] == 0 and len(sender.calls) == 1


def test_plain_mail_is_sent_without_the_html_argument(engine, send):
    sender = send()
    _queue(engine)
    engine.process_due()
    assert "html" not in sender.calls[0]      # a stub with the mailer's older signature still fits


def test_transient_failure_backs_off_then_fails_at_max_attempts(engine, send):
    sender = send(_TRANSIENT)
    mid = _queue(engine)["id"]
    for attempt, minutes in enumerate((1, 5, 15, 60), start=1):
        assert engine.process_due() == {"processed": 1, "sent": 0, "failed": 0, "deferred": 1}
        row = _row(mid)
        assert row.status == "QUEUED" and row.attempts == attempt
        assert row.last_error == "SMTPServerDisconnected: Connection unexpectedly closed"
        assert minutes * 60 - 10 < _wait_seconds(mid) <= minutes * 60
        # Not due yet: the worker leaves it alone until the backoff has passed.
        assert engine.process_due()["processed"] == 0
        _make_due(mid)
    assert engine.process_due() == {"processed": 1, "sent": 0, "failed": 1, "deferred": 0}
    row = _row(mid)
    assert row.status == "FAILED" and row.attempts == 5 and row.next_attempt_at is None
    assert [(n, outcome) for n, outcome, _ in _attempts(mid)] == [(n, "FAILED") for n in range(1, 6)]
    assert len(sender.calls) == 5


def test_max_attempts_setting_applies_to_new_mails(engine, send):
    send(_TRANSIENT)
    engine.save_settings({"max_attempts": 1})
    mid = _queue(engine)["id"]
    assert engine.process_due()["failed"] == 1
    assert _row(mid).status == "FAILED" and _row(mid).max_attempts == 1


@pytest.mark.parametrize("result,error", [
    (_PERMANENT, "SMTPAuthenticationError: 535 5.7.8 Username and Password not accepted"),
    ({"ok": False, "reason": "invalid_header"}, "invalid_header"),
    ({"ok": False, "reason": "no_recipient"}, "no_recipient"),
])
def test_permanent_error_fails_at_once(engine, send, result, error):
    send(result)
    mid = _queue(engine)["id"]
    assert engine.process_due() == {"processed": 1, "sent": 0, "failed": 1, "deferred": 0}
    row = _row(mid)
    assert row.status == "FAILED" and row.attempts == 1 and row.last_error == error
    assert _attempts(mid) == [(1, "FAILED", error)]


def test_unconfigured_smtp_keeps_the_mail_queued_and_uses_no_attempt(engine, send, monkeypatch):
    monkeypatch.setattr(mailer, "smtp_is_configured", lambda: False)
    mid = _queue(engine)["id"]            # the guard stub stays in: nothing may be sent
    assert engine.process_due() == {"processed": 1, "sent": 0, "failed": 0, "deferred": 1}
    row = _row(mid)
    assert row.status == "QUEUED" and row.attempts == 0 and row.last_error == "smtp_not_configured"
    assert 40 < _wait_seconds(mid) <= 60          # the poll interval, not a backoff step
    assert _attempts(mid) == [(1, "DEFERRED", "smtp_not_configured")]

    # Still not configured a tick later: it waits on, and the log does not grow a line per tick.
    _make_due(mid)
    assert engine.process_due()["deferred"] == 1
    assert _row(mid).attempts == 0 and len(_attempts(mid)) == 1

    # Configured from the Settings screen: the very next pass sends it — no restart.
    monkeypatch.setattr(mailer, "smtp_is_configured", lambda: True)
    send()
    _make_due(mid)
    assert engine.process_due()["sent"] == 1
    assert _row(mid).status == "SENT" and _row(mid).attempts == 1 and _row(mid).last_error is None


def test_sign_in_without_tls_waits_like_an_unconfigured_server(engine, send):
    send({"ok": False, "reason": "auth_requires_tls"})
    mid = _queue(engine)["id"]
    assert engine.process_due()["deferred"] == 1
    row = _row(mid)
    assert row.status == "QUEUED" and row.attempts == 0 and "TLS or SSL" in row.last_error


def test_refused_recipients_make_the_mail_partial(engine, send):
    send(lambda kw: {**_ok(kw), "refused": ["gone@example.com"]})
    mid = _queue(engine, to=["one@example.com", "gone@example.com"])["id"]
    assert engine.process_due() == {"processed": 1, "sent": 1, "failed": 0, "deferred": 0}
    data = engine.get_message(mid)
    assert data["status"] == "PARTIAL" and data["refused"] == ["gone@example.com"]
    assert data["sent_at"] is not None and data["attempt_log"][0]["outcome"] == "PARTIAL"


def test_a_mailer_that_raises_becomes_a_failed_attempt(engine, monkeypatch):
    def boom(**kw):
        raise RuntimeError("could not build the message")
    monkeypatch.setattr(mailer, "send_email", boom)
    mid = _queue(engine)["id"]
    assert engine.process_due()["deferred"] == 1          # never left stuck in SENDING
    assert _row(mid).status == "QUEUED" and _row(mid).last_error == "RuntimeError"


# ---- recipients ----

def test_recipients_are_cleaned_and_kept_once_in_their_most_visible_role():
    to, cc, bcc = normalise_recipients(
        ["  Asha@example.com ", "asha@EXAMPLE.com", "not-an-address", "x@example.com\nBcc: evil@example.com", None],
        ["ASHA@example.com", "copy@example.com", ""],
        ["Copy@example.com", "hidden@example.com"])
    assert (to, cc, bcc) == (["Asha@example.com"], ["copy@example.com"], ["hidden@example.com"])
    # No To but a Cc: the first Cc becomes the To. A Bcc is never promoted.
    assert normalise_recipients([], ["a@example.com", "b@example.com"]) == (["a@example.com"], ["b@example.com"], [])
    assert normalise_recipients(None, None, ["hidden@example.com"]) == ([], [], ["hidden@example.com"])
    assert normalise_recipients("solo@example.com") == (["solo@example.com"], [], [])


def test_submit_stores_the_cleaned_recipients(engine):
    data = _queue(engine, to=["a@example.com", "A@example.com", "broken"], cc=["a@example.com", "c@example.com"])
    assert data["to"] == ["a@example.com"] and data["cc"] == ["c@example.com"] and data["bcc"] == []


def test_mail_without_a_valid_recipient_is_skipped_never_sent(engine):
    data = _queue(engine, to=["broken", "  "], cc=[None])
    assert data["status"] == "SKIPPED" and data["last_error"] == "no_recipient"
    assert data["next_attempt_at"] is None
    assert engine.process_due()["processed"] == 0          # the guard stub would fail the test
    assert _row(data["id"]).status == "SKIPPED"


# ---- dedup ----

def test_dedup_key_returns_the_existing_mail(engine):
    key = f"critical_digest:test-{uuid.uuid4().hex}"
    first = _queue(engine, dedup_key=key)
    second = _queue(engine, dedup_key=key, subject=_subject("other"))
    assert "duplicate" not in first
    assert second["duplicate"] is True and second["id"] == first["id"]
    assert second["subject"] == first["subject"]
    assert EmailMessage.query.filter_by(dedup_key=key).count() == 1


def test_losing_the_race_for_a_dedup_key_sends_nothing(engine, monkeypatch):
    """Two triggers pass the 'not there yet' check together; the unique index
    lets only one insert through and the loser is handed the winner's mail."""
    key = f"critical_digest:race-{uuid.uuid4().hex}"
    winner = _queue(engine, dedup_key=key)
    real_duplicate = EmailEngine._duplicate
    seen = []

    class NothingThereYet:
        @staticmethod
        def filter_by(**kw):
            seen.append(kw)
            return type("Q", (), {"first": staticmethod(lambda: None)})

    # Only the first look-up (the pre-check) is blinded; the one after the
    # failed insert reads the real table.
    original_query = EmailMessage.query

    class Blinded:
        def __get__(self, obj, owner):
            return NothingThereYet if not seen else original_query

    monkeypatch.setattr(EmailMessage, "query", Blinded())
    loser = _queue(engine, dedup_key=key)
    monkeypatch.undo()
    assert seen == [{"dedup_key": key}]
    assert loser["duplicate"] is True and loser["id"] == winner["id"]
    assert EmailMessage.query.filter_by(dedup_key=key).count() == 1
    assert real_duplicate is EmailEngine._duplicate


# ---- retry / cancel ----

_REFUSED = "Only a queued or failed mail can be cancelled — this one is {}"


def test_retry_and_cancel_rules(engine, send):
    send(_PERMANENT)
    failed = _queue(engine)["id"]
    engine.process_due()
    assert _row(failed).status == "FAILED"

    retried = engine.retry(failed)
    assert retried["status"] == "QUEUED" and retried["attempts"] == 0
    assert retried["last_error"] is None and retried["next_attempt_at"] is not None
    with pytest.raises(BadRequestError):
        engine.retry(failed)                      # already queued

    cancelled = engine.cancel(failed)
    assert cancelled["status"] == "CANCELLED" and cancelled["next_attempt_at"] is None
    with pytest.raises(BadRequestError):
        engine.cancel(failed)                     # it is cancelled already
    assert engine.process_due()["processed"] == 0   # a cancelled mail is not sent
    assert engine.retry(failed)["status"] == "QUEUED"   # …until someone retries it

    send()
    engine.process_due()
    assert _row(failed).status == "SENT"
    with pytest.raises(BadRequestError):
        engine.retry(failed)                      # a sent mail is not sent again
    with pytest.raises(BadRequestError):
        engine.cancel(failed)
    skipped = _queue(engine, to=[])["id"]
    with pytest.raises(BadRequestError):
        engine.retry(skipped)
    with pytest.raises(NotFoundError):
        engine.retry(987654321)
    with pytest.raises(NotFoundError):
        engine.cancel(987654321)


def test_a_failed_mail_can_be_dismissed_and_nothing_sends_it_by_itself(engine, send, monkeypatch):
    send(_PERMANENT)
    failed = _queue(engine)["id"]
    engine.process_due()
    before = engine.status()
    assert _row(failed).status == "FAILED" and before["last_failure"]["id"] == failed

    dismissed = engine.cancel(failed)
    assert (dismissed["status"], dismissed["next_attempt_at"], dismissed["attempts"]) == ("CANCELLED", None, 1)
    assert dismissed["last_error"].startswith("SMTPAuthenticationError")     # why it failed stays on record
    # The Control Center no longer counts it as a failure waiting for someone.
    after = engine.status()
    assert after["queue"]["failed"] == before["queue"]["failed"] - 1
    assert after["today"]["failed"] == before["today"]["failed"] - 1
    assert (after["last_failure"] or {}).get("id") != failed
    with pytest.raises(BadRequestError, match=_REFUSED.format("CANCELLED")):
        engine.cancel(failed)

    # Not the queue, not the clean-up of mails left in SENDING, not a whole tick.
    sender = send()
    monkeypatch.setattr(email_engine, "_rules_module", lambda: None)
    assert engine.process_due()["processed"] == 0
    engine.requeue_stale_sending()
    assert engine.tick()["processed"] == 0
    assert sender.calls == [] and _row(failed).status == "CANCELLED" and len(_attempts(failed)) == 1
    # Only an administrator's Retry puts it back in the queue — and it can be taken out again.
    assert engine.retry(failed)["status"] == "QUEUED"
    assert engine.cancel(failed)["status"] == "CANCELLED"

    # Like every other finished mail, it goes with the retention purge.
    EmailMessage.query.filter_by(id=failed).update({"created_at": _now() - timedelta(days=100)},
                                                   synchronize_session=False)
    db.session.commit()
    assert engine.purge_old(90) >= 1
    assert _row(failed) is None and EmailAttempt.query.filter_by(message_id=failed).count() == 0


@pytest.mark.parametrize("status", ["SENDING", "SENT", "PARTIAL", "SKIPPED"])
def test_a_mail_that_is_being_sent_or_is_finished_cannot_be_cancelled(engine, status):
    mid = _queue(engine)["id"]
    # SENDING is a mail the worker claimed a moment ago: it must not be cancelled under it.
    EmailMessage.query.filter_by(id=mid).update({"status": status}, synchronize_session=False)
    db.session.commit()
    with pytest.raises(BadRequestError, match=_REFUSED.format(status)):
        engine.cancel(mid)
    assert _row(mid).status == status


@pytest.mark.parametrize("status", ["QUEUED", "FAILED"])
def test_cancel_leaves_a_mail_the_worker_took_in_the_same_moment(engine, monkeypatch, status):
    """The mail was still queued (or failed, and then retried) when the cancel
    looked at it, and the worker claimed it before the cancel was written: the
    cancel must find that out and leave the mail to the worker."""
    mid = _queue(engine)["id"]
    EmailMessage.query.filter_by(id=mid).update({"status": status}, synchronize_session=False)
    db.session.commit()
    get = EmailEngine._get

    def claimed_meanwhile(message_id):
        msg = get(message_id)
        assert msg.status == status
        EmailMessage.query.filter_by(id=message_id).update({"status": "SENDING"}, synchronize_session=False)
        return msg
    monkeypatch.setattr(EmailEngine, "_get", staticmethod(claimed_meanwhile))
    with pytest.raises(BadRequestError, match=_REFUSED.format("SENDING")):
        engine.cancel(mid)
    assert _row(mid).status == "SENDING"


def test_partial_mail_can_be_retried(engine, send):
    send(lambda kw: {**_ok(kw), "refused": ["gone@example.com"]})
    mid = _queue(engine, to=["one@example.com", "gone@example.com"])["id"]
    engine.process_due()
    retried = engine.retry(mid)
    assert retried["status"] == "QUEUED" and retried["refused"] == [] and retried["sent_at"] is None


# ---- kill-switch and settings ----

def test_kill_switch_holds_everything(engine, send):
    sender = send()
    engine.save_settings({"enabled": False})
    queued = _queue(engine)["id"]
    assert engine.process_due() == {"processed": 0, "sent": 0, "failed": 0, "deferred": 0}
    assert engine.tick()["enabled"] is False
    # A sender that used to mail inline is told why nothing went, and its mail waits too.
    subject = _subject("sync-off")
    result = engine.submit(mail_type="reorder", subject=subject, body="b", to=["one@example.com"], mode="sync")
    assert result == {"ok": False, "reason": "mail_engine_disabled"}
    held = EmailMessage.query.filter_by(subject=subject).one()
    assert held.status == "QUEUED" and held.attempts == 0 and "switched off" in held.last_error
    assert sender.calls == [] and _row(queued).status == "QUEUED"

    engine.save_settings({"enabled": True})
    assert engine.process_due()["sent"] == 2
    assert _row(queued).status == "SENT" and _row(held.id).status == "SENT" and _row(held.id).last_error is None


def test_switching_the_engine_off_stops_a_queue_pass_that_is_under_way(engine, send, monkeypatch):
    """The switch is read again for every mail of a pass: the one already with
    the mail server still goes, the ones not yet taken stay in the queue."""
    queued = [_queue(engine, tag=f"pass-{n}")["id"] for n in range(3)]
    handed_over = []

    def switched_off_meanwhile(**kw):
        handed_over.append(kw["subject"])
        engine.save_settings({"enabled": False})      # an admin, while the first mail is with the mail server
        return _ok(kw)
    monkeypatch.setattr(mailer, "send_email", switched_off_meanwhile)
    assert engine.process_due() == {"processed": 1, "sent": 1, "failed": 0, "deferred": 0}
    assert [_row(mid).status for mid in queued] == ["SENT", "QUEUED", "QUEUED"] and len(handed_over) == 1

    # Nothing is lost: switched on again, the next pass sends the rest.
    sender = send()
    engine.save_settings({"enabled": True})
    assert engine.process_due()["sent"] == 2 and len(sender.calls) == 2
    assert [_row(mid).status for mid in queued] == ["SENT"] * 3


def test_settings_defaults_validation_and_clamping(engine):
    AppSetting.query.filter_by(key="mail_engine").delete()
    db.session.commit()
    assert engine.settings() == {"enabled": True, "poll_seconds": 60, "max_attempts": 5, "retention_days": 90}
    saved = engine.save_settings({"poll_seconds": 30, "retention_days": 30}, "tester")
    assert saved == {"enabled": True, "poll_seconds": 30, "max_attempts": 5, "retention_days": 30}
    assert AppSetting.query.filter_by(key="mail_engine").one().updated_by == "tester"
    for bad in ({}, None, {"poll_seconds": 14}, {"poll_seconds": 3601}, {"max_attempts": 0}, {"max_attempts": 11},
                {"retention_days": 6}, {"retention_days": 366}, {"enabled": "yes"}, {"poll_seconds": True},
                {"poll_seconds": "60"}, {"smtp_password": "x"}):
        with pytest.raises(BadRequestError):
            engine.save_settings(bad)
    assert engine.settings() == saved                 # a refused save changed nothing
    # A row edited by hand cannot make the worker spin or purge yesterday's log.
    AppSetting.set_value("mail_engine", {"enabled": "no", "poll_seconds": 0, "max_attempts": 99, "retention_days": 1})
    assert engine.settings() == {"enabled": True, "poll_seconds": 15, "max_attempts": 10, "retention_days": 7}


def test_a_server_started_with_mail_forced_off_sends_nothing_whatever_is_saved(app, client, engine, send, monkeypatch):
    """MAIL_ENGINE_FORCE_OFF: for a server that runs on a copy of the plant's
    data (the TEST instance), where the copy brings the real recipients, the
    enabled rules and the queued mails with it."""
    from app.services.settings_service import SettingsService
    sender = send()
    engine.save_settings({"enabled": True, "poll_seconds": 60})
    queued = _queue(engine)["id"]
    assert engine.status()["engine"]["forced_off"] is False
    monkeypatch.setitem(app.config, "MAIL_ENGINE_FORCE_OFF", True)

    assert engine.settings()["enabled"] is False
    status = engine.status()["engine"]
    assert (status["enabled"], status["forced_off"]) == (False, True)
    assert engine.process_due() == {"processed": 0, "sent": 0, "failed": 0, "deferred": 0}
    assert engine.tick()["enabled"] is False
    # The screens of such a server cannot mail anyone either.
    assert engine.submit(mail_type="reorder", subject=_subject("forced-off"), body="b", to=["one@example.com"],
                         mode="sync") == {"ok": False, "reason": "mail_engine_disabled"}
    assert SettingsService().send_test_mail("probe@example.com", "asha") == {
        "ok": False, "reason": "mail_engine_disabled"}
    # Switching it on from the screen does not get past the server's own setting…
    resp = _as(client, _user()).put(_BASE + "/settings", json={"enabled": True, "poll_seconds": 30})
    assert resp.status_code == 200 and resp.get_json()["data"]["enabled"] is False
    assert "forced off" in resp.get_json()["message"]
    assert sender.calls == [] and _row(queued).status == "QUEUED"

    # …and what was saved is kept as it was typed, for a server that is not forced off.
    monkeypatch.setitem(app.config, "MAIL_ENGINE_FORCE_OFF", False)
    assert engine.settings() == {"enabled": True, "poll_seconds": 30, "max_attempts": 5, "retention_days": 90}


# ---- sync mode (the three senders that existed before the engine) ----

def test_sync_returns_the_mailer_result_unchanged_and_records_the_row(engine, send):
    answer = {"ok": True, "to": ["one@example.com"], "cc": []}      # no 'bcc' key, like the older stubs
    sender = send(answer)
    subject = _subject("sync")
    result = engine.submit(mail_type="window_time", subject=subject, body="Sheet attached",
                           to=["one@example.com"], trigger="SCHEDULED", triggered_by="scheduler", mode="sync")
    assert result is answer
    assert list(sender.calls[0]) == ["subject", "body", "to", "cc", "bcc", "attachments", "from_display"]
    row = EmailMessage.query.filter_by(subject=subject).one()
    assert row.status == "SENT" and row.attempts == 1 and row.sent_at is not None
    assert row.mail_type == "window_time" and row.trigger == "SCHEDULED" and row.triggered_by == "scheduler"
    assert _attempts(row.id) == [(1, "SENT", None)]
    assert engine.process_due()["processed"] == 0          # nothing left for the worker


def test_sync_skips_are_told_in_the_mailers_own_shape(engine):
    assert engine.submit(mail_type="reorder", subject=_subject("none"), body="b", to=["broken"],
                         mode="sync") == {"ok": False, "reason": "no_recipient"}


def test_sync_failure_is_delivered_by_the_worker_which_writes_the_send_log(engine, send):
    report_key = f"reorder_{9_000_000 + uuid.uuid4().int % 900_000}"
    day = date(2001, 1, 2)
    key = EmailEngine.report_dedup_key(report_key, day)
    assert key == f"{report_key}:2001-01-02"
    subject = _subject("late")
    failure = {"ok": False, "reason": "send_failed", "error": "TimeoutError"}
    sender = send(failure)
    try:
        result = engine.submit(mail_type="reorder", subject=subject, body="list", to=["one@example.com"],
                               cc=["two@example.com"], bcc=["three@example.com"], trigger="SCHEDULED",
                               dedup_key=key, mode="sync")
        assert result is failure                     # the sender sees exactly what the mailer said
        row = EmailMessage.query.filter_by(dedup_key=key).one()
        assert row.status == "QUEUED" and row.attempts == 1 and row.last_error == "TimeoutError"
        assert MailSendLog.query.filter_by(report_key=report_key).count() == 0

        # The same unattended trigger again that day: the reservation holds, nothing is sent twice.
        again = engine.submit(mail_type="reorder", subject=subject, body="list", to=["one@example.com"],
                              trigger="SCHEDULED", dedup_key=key, mode="sync")
        assert again == {"ok": False, "reason": "already_queued"} and len(sender.calls) == 1

        send()
        _make_due(row.id)
        assert engine.process_due()["sent"] == 1
        assert _row(row.id).status == "SENT" and _row(row.id).attempts == 2
        log = MailSendLog.query.filter_by(report_key=report_key).one()
        assert log.report_date == day and log.subject == subject
        assert log.to_addrs == "one@example.com" and log.cc_addrs == "two@example.com, three@example.com"
        assert engine.submit(mail_type="reorder", subject=subject, body="list", to=["one@example.com"],
                             dedup_key=key, mode="sync") == {"ok": False, "reason": "already_sent_today"}
    finally:
        MailSendLog.query.filter_by(report_key=report_key).delete()
        db.session.commit()


def test_forced_report_mail_always_goes_but_still_links_to_the_send_log(engine, send):
    report_key = f"reorder_{9_000_000 + uuid.uuid4().int % 900_000}"
    day = date(2001, 1, 3)
    first = EmailEngine.report_dedup_key(report_key, day, force=True)
    second = EmailEngine.report_dedup_key(report_key, day, force=True)
    assert first != second and first.startswith(f"{report_key}:2001-01-03:forced-")
    sender = send({"ok": False, "reason": "send_failed", "error": "TimeoutError"})
    try:
        for key in (first, second):                  # the button twice: two attempts, no reservation
            engine.submit(mail_type="reorder", subject=_subject("forced"), body="list",
                          to=["one@example.com"], dedup_key=key, mode="sync")
        assert len(sender.calls) == 2
        send()
        rows = EmailMessage.query.filter(EmailMessage.dedup_key.in_([first, second])).order_by(EmailMessage.id).all()
        for row in rows:
            _make_due(row.id)
        # Both waited for the worker. It delivers the report once — the second
        # mail is the same list again — and logs the day.
        assert engine.process_due()["sent"] == 1
        assert [_row(row.id).status for row in rows] == ["SENT", "CANCELLED"]
        assert MailSendLog.query.filter_by(report_key=report_key, report_date=day).count() == 1
    finally:
        MailSendLog.query.filter_by(report_key=report_key).delete()
        db.session.commit()


# ---- a daily report still in the queue when the same report has gone out ----

_TIMEOUT = {"ok": False, "reason": "send_failed", "error": "TimeoutError"}


@pytest.fixture()
def report_key():
    """A reorder report key no department has; its send-log rows are removed afterwards."""
    key = f"reorder_{9_000_000 + uuid.uuid4().int % 900_000}"
    try:
        yield key
    finally:
        db.session.rollback()
        MailSendLog.query.filter_by(report_key=key).delete()
        db.session.commit()


def _report_mail(engine, report_key, day, force, mail_type="reorder"):
    """One daily report through the sync seam, the way its sender submits it.
    Returns (the mailer's answer, the mail's row)."""
    key = EmailEngine.report_dedup_key(report_key, day, force)
    result = engine.submit(mail_type=mail_type, subject=_subject("report"), body="list", to=["one@example.com"],
                           trigger="MANUAL" if force else "SCHEDULED", dedup_key=key, mode="sync")
    return result, EmailMessage.query.filter_by(dedup_key=key).one()


@pytest.mark.parametrize("mail_type", ["reorder", "window_time"])
def test_failed_scheduled_report_is_not_sent_again_after_send_now_delivered_it(engine, send, report_key, mail_type):
    # The window-time sheet's key is the report's own name; its day here is one no other case mails.
    report_key = "window_time" if mail_type == "window_time" else report_key
    day = date(2001, 2, 1)
    failing = send(_TIMEOUT)
    result, stale = _report_mail(engine, report_key, day, False, mail_type)  # the server is down at the rule time
    assert result is _TIMEOUT and stale.status == "QUEUED"
    working = send()
    assert _report_mail(engine, report_key, day, True, mail_type)[0]["ok"] is True       # the admin presses Send now
    # The worker's retry must not hand the department the same list a second time.
    _make_due(stale.id)
    assert engine.process_due() == {"processed": 0, "sent": 0, "failed": 0, "deferred": 0}
    row = _row(stale.id)
    assert (row.status, row.last_error, row.next_attempt_at) == ("CANCELLED", "already_sent_today", None)
    assert len(failing.calls) == 1 and len(working.calls) == 1
    # Retried by hand it is closed the same way, never mailed.
    engine.retry(stale.id)
    assert engine.process_due()["sent"] == 0 and _row(stale.id).status == "CANCELLED"
    assert len(working.calls) == 1


def test_send_now_pressed_again_after_a_timeout_mails_the_report_once(engine, send, report_key):
    day = date(2001, 2, 2)
    send(_TIMEOUT)
    _, stale = _report_mail(engine, report_key, day, force=True)             # the first click times out
    working = send()
    assert _report_mail(engine, report_key, day, force=True)[0]["ok"] is True      # the second one goes
    _make_due(stale.id)
    assert engine.process_due()["sent"] == 0
    assert _row(stale.id).status == "CANCELLED" and len(working.calls) == 1


def test_send_now_pressed_three_times_with_the_engine_off_releases_one_mail(engine, send, report_key):
    day = date(2001, 2, 3)
    sender = send()
    engine.save_settings({"enabled": False})
    held = []
    for _ in range(3):
        result, row = _report_mail(engine, report_key, day, force=True)
        assert result == {"ok": False, "reason": "mail_engine_disabled"} and row.status == "QUEUED"
        held.append(row.id)
    assert sender.calls == []
    engine.save_settings({"enabled": True})
    assert engine.process_due() == {"processed": 1, "sent": 1, "failed": 0, "deferred": 0}
    assert [_row(mid).status for mid in held] == ["SENT", "CANCELLED", "CANCELLED"]
    assert len(sender.calls) == 1
    assert MailSendLog.query.filter_by(report_key=report_key, report_date=day).count() == 1


def test_report_asked_for_again_after_it_went_is_still_delivered_by_the_worker(engine, send, report_key):
    day = date(2001, 2, 4)
    send()
    assert _report_mail(engine, report_key, day, force=False)[0]["ok"] is True     # the morning's mail went
    send(_TIMEOUT)
    _, late = _report_mail(engine, report_key, day, force=True)              # Send now later that day: times out
    working = send()
    _make_due(late.id)
    assert engine.process_due()["sent"] == 1
    assert _row(late.id).status == "SENT" and len(working.calls) == 1


def test_other_mails_are_never_held_back_by_an_earlier_one_of_their_kind(engine, send):
    sender = send()
    token = uuid.uuid4().hex[:8]
    for n in (1, 2):                     # not a daily report: both go, whatever their keys look like
        _queue(engine, mail_type="critical_digest", dedup_key=f"critical_digest:2001-02-05:forced-{token}{n}")
    assert engine.process_due()["sent"] == 2 and len(sender.calls) == 2


def test_inline_success_leaves_the_send_log_to_the_sender(engine, send):
    report_key = f"reorder_{9_000_000 + uuid.uuid4().int % 900_000}"
    send()
    engine.submit(mail_type="reorder", subject=_subject("inline"), body="list", to=["one@example.com"],
                  dedup_key=EmailEngine.report_dedup_key(report_key, date(2001, 1, 4)), mode="sync")
    assert MailSendLog.query.filter_by(report_key=report_key).count() == 0


def test_worker_writes_no_send_log_for_other_mails(engine, send):
    send()
    marker = f"critical_digest:2001-01-05-{uuid.uuid4().hex[:8]}"
    _queue(engine, mail_type="critical_digest", dedup_key=marker)
    engine.process_due()
    assert MailSendLog.query.filter_by(report_key="critical_digest").count() == 0


# ---- the SMTP test mail and the reorder mail through the seam ----

def test_smtp_test_mail_is_logged_and_never_waits_in_the_queue(engine, send, client):
    from app.services.settings_service import SettingsService
    sender = send()
    assert SettingsService().send_test_mail(" probe@example.com ", "asha")["ok"] is True
    row = EmailMessage.query.filter_by(mail_type="smtp_test").order_by(EmailMessage.id.desc()).first()
    assert row.status == "SENT" and row.trigger == "TEST" and row.triggered_by == "asha"
    assert row.max_attempts == 1 and row.to_list == ["probe@example.com"]
    assert sender.calls[0]["subject"] == "TBDI Digital SMP — test mail"

    # A failed test is final at once — it must not turn up hours later.
    send(_TRANSIENT)
    assert SettingsService().send_test_mail("probe@example.com", "asha") == _TRANSIENT
    row = EmailMessage.query.filter_by(mail_type="smtp_test").order_by(EmailMessage.id.desc()).first()
    assert row.status == "FAILED" and row.attempts == 1
    # …and with no mail server set up it is skipped, not parked.
    send({"ok": False, "reason": "smtp_not_configured"})
    assert SettingsService().send_test_mail("probe@example.com", "asha") == {"ok": False, "reason": "smtp_not_configured"}
    row = EmailMessage.query.filter_by(mail_type="smtp_test").order_by(EmailMessage.id.desc()).first()
    assert row.status == "SKIPPED" and row.attempts == 0 and row.last_error == "smtp_not_configured"
    assert engine.process_due()["processed"] == 0

    # Through the existing endpoint the response is what it always was, and the log knows who asked.
    send()
    admin = _user()
    resp = _as(client, admin).post("/api/v1/admin/smtp-test", json={"to": "probe@example.com"})
    assert resp.status_code == 200 and resp.get_json()["message"] == "Test mail sent"
    assert resp.get_json()["data"] == {"ok": True, "to": ["probe@example.com"], "cc": [], "bcc": []}
    row = EmailMessage.query.filter_by(mail_type="smtp_test").order_by(EmailMessage.id.desc()).first()
    assert row.triggered_by == admin.username


def test_machine_caller_is_recorded_as_machine(app, send, monkeypatch):
    """The Windows Task Scheduler job: it POSTs the window-time trigger with the
    shared key and no session. From the key alone "force" is ignored, so the
    key can never mail the sheet a second time the same day."""
    from datetime import date as _date
    from app.repositories.report_recipient_repository import ReportRecipientRepository
    from app.services.supplier_window_schedule_service import SupplierWindowScheduleService
    from app.services.window_time_mail_service import WindowTimeMailService
    send()
    # A reported day of this test's own, so the once-a-day guard starts free.
    monkeypatch.setattr(WindowTimeMailService, "_reported_date", staticmethod(lambda at=None: _date(2031, 3, 5)))
    address = f"machine.{uuid.uuid4().hex[:8]}@example.com"
    monkeypatch.setattr(ReportRecipientRepository, "recipients_for", lambda self, report_key: ([address], []))
    monkeypatch.setattr(SupplierWindowScheduleService, "window_time_workbook",
                        lambda self, year, month: (io.BytesIO(b"sheet"), "application/octet-stream", "xlsx"))
    logged = [row.id for row in MailSendLog.query.filter_by(report_key="window_time").all()]
    fresh = app.test_client()                         # no session: the shared key is the only credential
    try:
        resp = fresh.post("/api/v1/supplier-window-schedules/email-report", json={"force": True},
                          headers={"X-API-Key": app.config["API_KEY"]})
        assert resp.status_code == 200 and resp.get_json()["data"]["status"] == "sent"
        row = EmailMessage.query.filter(EmailMessage.to_addrs.like(f"%{address}%")).one()
        assert row.mail_type == "window_time" and row.triggered_by == "machine"
        assert row.trigger == "SCHEDULED"                 # not forced, although the body asked for it
        again = fresh.post("/api/v1/supplier-window-schedules/email-report", json={"force": True},
                           headers={"X-API-Key": app.config["API_KEY"]})
        assert (again.get_json()["data"]["status"], again.get_json()["data"]["reason"]) == (
            "skipped", "already_sent_today")
        assert EmailMessage.query.filter(EmailMessage.to_addrs.like(f"%{address}%")).count() == 1
    finally:
        # test_window_time_mail counts this table: leave it as it was found.
        MailSendLog.query.filter(MailSendLog.report_key == "window_time",
                                 MailSendLog.id.notin_(logged)).delete(synchronize_session=False)
        db.session.commit()


def test_reorder_mail_goes_through_the_engine_with_its_result_shape_intact(engine, send, monkeypatch):
    from app.services.reorder_mail_service import ReorderMailService
    sender = send()
    dept = Department(name=f"Mail Seam {uuid.uuid4().hex[:8]}", notify_reorder=True, is_active=True)
    db.session.add(dept)
    db.session.flush()
    db.session.add_all([
        DepartmentRecipient(department_id=dept.id, name="Asha", email="asha@example.com", role="TO"),
        DepartmentRecipient(department_id=dept.id, name="Ravi", email="ravi@example.com", role="CC"),
        DepartmentRecipient(department_id=dept.id, name="Hidden", email="hidden@example.com", role="BCC"),
    ])
    db.session.commit()
    dept_id, dept_name, key = dept.id, dept.name, f"reorder_{dept.id}"
    rows = [{"part_no": "P-1", "part_name": "Bearing", "status": "Reorder", "qty_on_hand": 1,
             "min_stock_level": 2, "reorder_level": 3, "max_stock_level": 9, "location": "R1-S1-B1"}]
    monkeypatch.setattr(ReorderMailService, "_reorder_rows", lambda self, section_ids: rows)
    try:
        out = ReorderMailService().send_now(force=True)
        entry = next(d for d in out["departments"] if d["department"] == dept_name)
        assert entry == {"department": dept_name, "status": "sent", "parts": 1, "to": 1, "cc": 1, "bcc": 1}
        assert out["status"] == "ok" and out["total_sent"] >= 1
        mine = [c for c in sender.calls if dept_name in c["subject"]]
        assert len(mine) == 1 and mine[0]["to"] == ["asha@example.com"] and mine[0]["bcc"] == ["hidden@example.com"]
        row = EmailMessage.query.filter(EmailMessage.dedup_key.like(f"{key}:%")).one()
        assert row.mail_type == "reorder" and row.status == "SENT" and row.trigger == "MANUAL"
        assert row.store_code == "MAINTENANCE" and ":forced-" in row.dedup_key
        # The sender still writes its own once-a-day row, and its own check still answers the next unforced run.
        assert MailSendLog.query.filter_by(report_key=key, report_date=date.today()).count() == 1
        again = ReorderMailService().send_now(force=False)
        entry = next(d for d in again["departments"] if d["department"] == dept_name)
        assert entry == {"department": dept_name, "status": "skipped", "reason": "already_sent_today"}
        assert len([c for c in sender.calls if dept_name in c["subject"]]) == 1
    finally:
        db.session.rollback()
        MailSendLog.query.filter_by(report_key=key).delete()
        DepartmentRecipient.query.filter_by(department_id=dept_id).delete()
        Department.query.filter_by(id=dept_id).delete()
        db.session.commit()


# ---- attachments ----

def test_attachments_are_stored_and_sent_as_they_were(engine, send):
    sender = send()
    payload = bytes(range(256)) * 8
    data = _queue(engine, attachments=[{"filename": "sheet.xlsx", "content": payload,
                                        "mime": "application/vnd.ms-excel"}])
    assert data["attachments"] == [{"filename": "sheet.xlsx", "size": len(payload)}]
    stored = EmailAttachment.query.filter_by(message_id=data["id"]).one()
    assert stored.content == payload and stored.mime == "application/vnd.ms-excel"
    engine.process_due()
    assert sender.calls[0]["attachments"] == [
        {"filename": "sheet.xlsx", "content": payload, "mime": "application/vnd.ms-excel"}]


def test_attachments_over_the_cap_skip_the_mail(engine, monkeypatch):
    assert email_engine.MAX_ATTACHMENT_BYTES == 10 * 1024 * 1024
    monkeypatch.setattr(email_engine, "MAX_ATTACHMENT_BYTES", 1000)       # the rule, without 10 MB of test data
    files = [{"filename": "a.bin", "content": b"a" * 600}, {"filename": "b.bin", "content": b"b" * 401}]
    data = _queue(engine, attachments=files)
    assert data["status"] == "SKIPPED" and data["last_error"] == "attachment_too_large"
    assert data["attachments"] == [{"filename": "a.bin", "size": 600}, {"filename": "b.bin", "size": 401}]
    # On record by name and size; the oversized bytes themselves are not kept.
    assert all(a.content == b"" for a in EmailAttachment.query.filter_by(message_id=data["id"]).all())
    assert engine.submit(mail_type="window_time", subject=_subject("big"), body="b", to=["one@example.com"],
                         attachments=files, mode="sync") == {"ok": False, "reason": "attachment_too_large"}
    # Exactly at the cap is still fine.
    assert _queue(engine, attachments=[{"filename": "ok.bin", "content": b"c" * 1000}])["status"] == "QUEUED"


# ---- the worker tick ----

def test_tick_survives_a_failing_rule_and_still_drains_the_queue(engine, send, monkeypatch):
    send()
    ran = []

    class Rules:
        @staticmethod
        def run_due_rules(eng):
            raise RuntimeError("rule blew up")

        @staticmethod
        def run_due_reminders(eng):
            ran.append(eng)

    monkeypatch.setattr(email_engine, "_rules_module", lambda: Rules)
    monkeypatch.setattr(EmailEngine, "_consecutive_failures", 0)
    mid = _queue(engine)["id"]
    summary = engine.tick()
    assert ran == [engine]                               # the reminders still ran…
    assert _row(mid).status == "SENT" and summary["sent"] == 1     # …and so did the queue
    assert summary["errors"] == ["rules: RuntimeError: rule blew up"]
    assert EmailEngine._last_error == "rules: RuntimeError: rule blew up"
    assert EmailEngine._consecutive_failures == 1 and EmailEngine._last_tick_at is not None

    monkeypatch.setattr(email_engine, "_rules_module", lambda: None)   # the module not built yet
    clean = engine.tick()
    assert clean["errors"] == [] and clean["poll_seconds"] == engine.settings()["poll_seconds"]
    assert EmailEngine._last_error is None and EmailEngine._consecutive_failures == 0


def test_tick_reports_a_rules_module_that_fails_to_load(engine, monkeypatch):
    def broken():
        raise ImportError("cannot import name 'gone' from 'app.services.email_rules'")
    monkeypatch.setattr(email_engine, "_rules_module", broken)
    summary = engine.tick()
    assert summary["errors"] and summary["errors"][0].startswith("rules module: ImportError")
    assert engine.status()["rules"] == {"enabled": 0, "total": 0, "next": None}     # the status still renders


def test_mails_left_in_sending_go_back_to_the_queue(engine, send):
    send()
    crashed = _queue(engine)["id"]
    EmailMessage.query.filter_by(id=crashed).update({"status": "SENDING"}, synchronize_session=False)
    db.session.commit()
    # While running, only a mail abandoned for longer than a send can take is taken back…
    engine.requeue_stale_sending(older_than_minutes=30)
    assert _row(crashed).status == "SENDING"
    # …at start-up, every one of them.
    assert engine.requeue_stale_sending() >= 1
    assert _row(crashed).status == "QUEUED"
    engine.process_due()
    assert _row(crashed).status == "SENT"


def test_purge_drops_only_old_finished_mails(engine, send):
    send()
    old_sent = _queue(engine, attachments=[{"filename": "old.txt", "content": b"old"}])["id"]
    recent_sent = _queue(engine)["id"]
    engine.process_due()
    send(_PERMANENT)
    old_failed = _queue(engine)["id"]
    engine.process_due()
    long_ago = _now() - timedelta(days=100)
    EmailMessage.query.filter(EmailMessage.id.in_([old_sent, old_failed])).update(
        {"created_at": long_ago}, synchronize_session=False)
    db.session.commit()

    assert engine.purge_old(90) >= 1
    assert _row(old_sent) is None
    assert EmailAttachment.query.filter_by(message_id=old_sent).count() == 0     # children go with it
    assert EmailAttempt.query.filter_by(message_id=old_sent).count() == 0
    assert _row(recent_sent).status == "SENT"
    assert _row(old_failed).status == "FAILED"              # a failure stays until someone deals with it


def test_worker_does_not_start_under_the_reloader_guard_but_does_under_waitress(app, monkeypatch):
    from app import _start_email_engine
    started = []
    monkeypatch.setattr(EmailEngine, "start_worker", classmethod(lambda cls, a: started.append(a)))
    monkeypatch.delenv("WERKZEUG_RUN_MAIN", raising=False)
    monkeypatch.delenv("DX_NO_RELOADER", raising=False)
    assert app.debug
    _start_email_engine(app)
    assert started == []                                  # pytest, and the reloader parent
    assert "email-engine" not in {t.name for t in threading.enumerate()}
    monkeypatch.setenv("DX_NO_RELOADER", "1")             # what serve.py sets
    _start_email_engine(app)
    monkeypatch.delenv("DX_NO_RELOADER")
    monkeypatch.setenv("WERKZEUG_RUN_MAIN", "true")       # the reloader's serving child
    _start_email_engine(app)
    assert started == [app, app]


def test_start_worker_starts_one_thread_and_requeues_first(app, engine, monkeypatch):
    crashed = _queue(engine)["id"]
    EmailMessage.query.filter_by(id=crashed).update({"status": "SENDING"}, synchronize_session=False)
    db.session.commit()
    made = []

    class FakeThread:
        def __init__(self, target, name, daemon):
            made.append((name, daemon))

        def start(self):
            pass

        def is_alive(self):
            return True

    monkeypatch.setattr(email_engine.threading, "Thread", FakeThread)
    monkeypatch.setattr(EmailEngine, "_worker_started", False)
    EmailEngine.start_worker(app)
    EmailEngine.start_worker(app)                         # a second call is a no-op
    assert made == [("email-engine", True)]
    assert _row(crashed).status == "QUEUED"
    assert engine.status()["engine"]["worker_running"] is True


# ---- status ----

def test_status_shape_and_counts(engine, send):
    before = engine.status()
    send()
    sent = _queue(engine, mail_type="critical_digest")["id"]
    engine.process_due()
    send(_PERMANENT)
    failed = _queue(engine, mail_type="critical_digest")["id"]
    engine.process_due()
    _queue(engine, to=[])                                  # skipped
    waiting = _queue(engine)["id"]
    EmailMessage.query.filter_by(id=waiting).update(
        {"next_attempt_at": _now() + timedelta(hours=1)}, synchronize_session=False)
    db.session.commit()

    status = engine.status()
    assert set(status) == {"smtp", "engine", "queue", "today", "last_7_days", "by_type_30d", "rules",
                           "last_sent", "last_failure", "generated_at"}
    assert set(status["smtp"]) == {"configured", "host", "port", "from_email", "from_display", "password_in_env"}
    assert set(status["engine"]) == {"enabled", "forced_off", "worker_running", "last_tick_at", "last_error",
                                     "consecutive_failures", "poll_seconds", "max_attempts", "retention_days"}
    assert status["engine"]["worker_running"] is False     # no worker thread under pytest
    assert set(status["rules"]) == {"enabled", "total", "next"}
    for key in ("sent", "failed", "skipped"):
        assert status["today"][key] == before["today"][key] + 1
    assert status["queue"]["queued"] == 1 and status["queue"]["oldest_queued_at"] is not None
    assert status["queue"]["failed"] == before["queue"]["failed"] + 1

    days = status["last_7_days"]
    assert len(days) == 7 and [d["date"] for d in days] == sorted(d["date"] for d in days)
    # The last entry is the plant-clock day, however far the server is from UTC.
    assert days[-1]["date"] == datetime.now().date().isoformat()
    assert days[-1]["sent"] == before["last_7_days"][-1]["sent"] + 1
    assert days[-1]["failed"] == before["last_7_days"][-1]["failed"] + 1
    by_type = {t["mail_type"]: t for t in status["by_type_30d"]}
    was = {t["mail_type"]: t for t in before["by_type_30d"]}.get("critical_digest", {"sent": 0, "failed": 0})
    assert by_type["critical_digest"]["sent"] == was["sent"] + 1
    assert by_type["critical_digest"]["failed"] == was["failed"] + 1
    assert status["last_sent"]["id"] == sent and status["last_failure"]["id"] == failed
    assert status["last_failure"]["error"].startswith("SMTPAuthenticationError")
    assert "+" not in status["generated_at"] and not status["generated_at"].endswith("Z")   # zone-less UTC


# ---- the API ----

def test_every_route_refuses_a_non_admin(client):
    c = _as(client, _user("STORE_USER"))
    for method, path in (("get", "/status"), ("put", "/settings"), ("post", "/process"), ("get", "/messages"),
                         ("get", "/messages/1"), ("post", "/messages/1/retry"), ("post", "/messages/1/cancel"),
                         ("get", "/recipients")):
        resp = getattr(c, method)(_BASE + path, json={}) if method != "get" else c.get(_BASE + path)
        assert resp.status_code == 403, (method, path, resp.status_code)


def test_machine_key_can_read_but_cannot_change_anything(app, engine):
    mid = _queue(engine)["id"]
    machine = app.test_client()                            # no session cookie
    key = {"X-API-Key": app.config["API_KEY"]}
    assert machine.get(_BASE + "/status", headers=key).status_code == 200
    assert machine.get(_BASE + "/messages", headers=key).status_code == 200
    before = engine.settings()
    assert machine.put(_BASE + "/settings", json={"enabled": False}, headers=key).status_code == 403
    assert machine.post(_BASE + "/process", headers=key).status_code == 403
    assert machine.post(f"{_BASE}/messages/{mid}/cancel", headers=key).status_code == 403
    assert machine.post(f"{_BASE}/messages/{mid}/retry", headers=key).status_code == 403
    assert engine.settings() == before and _row(mid).status == "QUEUED"
    assert machine.get(_BASE + "/status").status_code == 401       # and with no credential at all


def test_settings_route_saves_and_validates(client, engine):
    admin = _user()
    c = _as(client, admin)
    resp = c.put(_BASE + "/settings", json={"poll_seconds": 120, "enabled": True})
    assert resp.status_code == 200 and resp.get_json()["success"] is True
    assert resp.get_json()["data"] == {**engine.settings(), "poll_seconds": 120}
    assert AppSetting.query.filter_by(key="mail_engine").one().updated_by == admin.username
    assert c.get(_BASE + "/status").get_json()["data"]["engine"]["poll_seconds"] == 120
    assert c.put(_BASE + "/settings", json={"poll_seconds": 5}).status_code == 400
    assert c.put(_BASE + "/settings", json={"nope": 1}).status_code == 400
    assert c.put(_BASE + "/settings", data="not json", content_type="text/plain").status_code == 400
    assert engine.settings()["poll_seconds"] == 120


def test_process_route_drains_the_queue_and_is_rate_limited(app, client, engine, send):
    send()
    mid = _queue(engine)["id"]
    c = _as(client, _user())
    resp = c.post(_BASE + "/process")
    assert resp.status_code == 200
    assert resp.get_json()["data"] == {"processed": 1, "sent": 1, "failed": 0, "deferred": 0}
    assert _row(mid).status == "SENT"

    app.config["RATE_LIMIT_ENABLED"] = True
    rate_limit.reset()
    try:
        codes = [c.post(_BASE + "/process").status_code for _ in range(8)]
    finally:
        app.config["RATE_LIMIT_ENABLED"] = False
        rate_limit.reset()
    assert codes[:6] == [200] * 6 and codes[6:] == [429, 429]


def test_message_list_filters_paging_and_detail(client, engine, send):
    token = uuid.uuid4().hex[:12]
    send()
    first = _queue(engine, subject=f"list {token} one", mail_type="critical_digest")["id"]
    engine.process_due()                                   # → SENT
    second = _queue(engine, subject=f"list {token} two", mail_type="tracker_digest",
                    to=[f"{token}@example.com"])["id"]
    third = _queue(engine, subject=f"list {token} three", mail_type="critical_digest")["id"]
    c = _as(client, _user())

    page1 = c.get(_BASE + "/messages", query_string={"q": token, "per_page": 2}).get_json()["data"]
    assert [m["id"] for m in page1["items"]] == [third, second]           # newest first
    assert page1["meta"] == {"page": 1, "per_page": 2, "total": 3, "total_pages": 2,
                             "has_prev": False, "has_next": True}
    page2 = c.get(_BASE + "/messages", query_string={"q": token, "per_page": 2, "page": 2}).get_json()["data"]
    assert [m["id"] for m in page2["items"]] == [first]
    assert page2["meta"]["has_prev"] is True and page2["meta"]["has_next"] is False
    assert "body_text" not in page1["items"][0] and "attempt_log" not in page1["items"][0]

    def ids(**params):
        return [m["id"] for m in c.get(_BASE + "/messages", query_string={"q": token, **params})
                .get_json()["data"]["items"]]

    assert ids(status="SENT") == [first]
    assert ids(status="queued, sent") == [third, second, first]           # csv, any case
    assert ids(mail_type="critical_digest") == [third, first]
    assert ids(status="QUEUED", mail_type="critical_digest") == [third]
    # q also matches an address, and is a literal — LIKE wildcards in it mean nothing.
    assert [m["id"] for m in c.get(_BASE + "/messages", query_string={"q": f"{token}@example"})
            .get_json()["data"]["items"]] == [second]
    assert c.get(_BASE + "/messages", query_string={"q": f"{token}%one"}).get_json()["data"]["meta"]["total"] == 0
    assert c.get(_BASE + "/messages", query_string={"status": "NOPE"}).status_code == 400
    assert c.get(_BASE + "/messages", query_string={"page": "x"}).status_code == 400
    assert c.get(_BASE + "/messages", query_string={"per_page": 5000}).get_json()["data"]["meta"]["per_page"] == 200

    detail = c.get(f"{_BASE}/messages/{first}").get_json()["data"]
    assert detail["body_text"] == "Body text" and detail["body_html"] is None
    assert [(a["attempt_no"], a["outcome"], a["error"]) for a in detail["attempt_log"]] == [(1, "SENT", None)]
    assert detail["attempt_log"][0]["at"] is not None
    assert set(page1["items"][0]) | {"body_text", "body_html", "attempt_log"} == set(detail)
    assert set(page1["items"][0]) == {
        "id", "mail_type", "rule_key", "store_code", "subject", "to", "cc", "bcc", "status", "attempts",
        "max_attempts", "next_attempt_at", "last_error", "refused", "trigger", "triggered_by", "created_at",
        "sent_at", "attachments"}
    assert c.get(f"{_BASE}/messages/987654321").status_code == 404


def test_retry_and_cancel_routes(client, engine, send):
    c = _as(client, _user())
    mid = _queue(engine)["id"]
    assert c.post(f"{_BASE}/messages/{mid}/retry").status_code == 400      # queued: nothing to retry
    resp = c.post(f"{_BASE}/messages/{mid}/cancel")
    assert resp.status_code == 200 and resp.get_json()["data"]["status"] == "CANCELLED"
    assert c.post(f"{_BASE}/messages/{mid}/cancel").status_code == 400
    resp = c.post(f"{_BASE}/messages/{mid}/retry")
    assert resp.status_code == 200 and resp.get_json()["data"]["status"] == "QUEUED"
    assert c.post(f"{_BASE}/messages/987654321/retry").status_code == 404
    assert c.post(f"{_BASE}/messages/987654321/cancel").status_code == 404

    # A failed mail is dismissed the same way; a sent one is refused, and told why.
    send(_PERMANENT)
    engine.process_due()
    assert _row(mid).status == "FAILED"
    resp = c.post(f"{_BASE}/messages/{mid}/cancel")
    assert resp.status_code == 200 and resp.get_json()["data"]["status"] == "CANCELLED"
    send()
    sent = _queue(engine)["id"]
    engine.process_due()
    resp = c.post(f"{_BASE}/messages/{sent}/cancel")
    assert resp.status_code == 400
    assert resp.get_json()["message"] == _REFUSED.format("SENT")


def test_recipients_route_lists_departments_with_reachable_people(client):
    dept = Department(name=f"Mail Picker {uuid.uuid4().hex[:8]}", notify_reorder=True, is_active=False)
    db.session.add(dept)
    db.session.flush()
    db.session.add_all([
        DepartmentRecipient(department_id=dept.id, name="Asha", email="asha@example.com", role="CC"),
        DepartmentRecipient(department_id=dept.id, name="No Address", email=None, role="TO"),
        DepartmentRecipient(department_id=dept.id, name="Left", email="left@example.com", role="TO", is_active=False),
    ])
    db.session.commit()
    dept_id = dept.id
    try:
        rows = _as(client, _user()).get(_BASE + "/recipients").get_json()["data"]
        mine = next(r for r in rows if r["id"] == dept_id)
        assert set(mine) == {"id", "name", "is_active", "notify_reorder", "recipients"}
        assert mine["is_active"] is False and mine["notify_reorder"] is True      # inactive is flagged, not hidden
        assert [{k: r[k] for k in ("name", "email", "role")} for r in mine["recipients"]] == [
            {"name": "Asha", "email": "asha@example.com", "role": "CC"}]
        assert set(mine["recipients"][0]) == {"id", "name", "email", "role"}
    finally:
        DepartmentRecipient.query.filter_by(department_id=dept_id).delete()
        Department.query.filter_by(id=dept_id).delete()
        db.session.commit()


# ---- the transport (mailer.py) — smtplib is a fake throughout ----

class FakeSMTP:
    """Stands in for smtplib.SMTP: records what it was asked and sends nothing."""
    instances = []
    refused = {}
    raises = None

    def __init__(self, host, port, timeout=None, **kw):
        self.host, self.port, self.steps, self.message, self.envelope = host, port, [], None, None
        FakeSMTP.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def starttls(self, context=None):
        self.steps.append("starttls")

    def login(self, user, password):
        self.steps.append("login")

    def send_message(self, msg, from_addr=None, to_addrs=None):
        if FakeSMTP.raises is not None:
            raise FakeSMTP.raises
        self.steps.append("send")
        self.message, self.envelope = msg, list(to_addrs)
        return dict(FakeSMTP.refused)


@pytest.fixture()
def transport(monkeypatch):
    """The real send_email over a fake SMTP class and a fake config."""
    FakeSMTP.instances, FakeSMTP.refused, FakeSMTP.raises = [], {}, None
    monkeypatch.undo()                        # the autouse stubs: this case wants the real functions
    monkeypatch.setattr(mailer.smtplib, "SMTP", FakeSMTP)
    monkeypatch.setattr(mailer.smtplib, "SMTP_SSL", FakeSMTP)

    def configure(**overrides):
        cfg = dict(SMTP_HOST="mail.local", SMTP_FROM="store@example.com", SMTP_USER=None, SMTP_PASSWORD=None,
                   SMTP_PORT=587, MAIL_FROM_DISPLAY="TBDI_store", SMTP_USE_TLS=True, SMTP_USE_SSL=False,
                   SMTP_TIMEOUT=5)
        cfg.update(overrides)
        monkeypatch.setattr(mailer, "current_app", type("A", (), {"config": cfg}))
    configure()
    return configure


def test_mailer_adds_an_html_alternative(transport):
    out = _REAL_SEND("Digest", "plain text", ["a@example.com"], cc=["c@example.com"], bcc=["b@example.com"],
                     html="<table><tr><td>cell</td></tr></table>")
    assert out == {"ok": True, "to": ["a@example.com"], "cc": ["c@example.com"], "bcc": ["b@example.com"]}
    server = FakeSMTP.instances[-1]
    msg = server.message
    assert msg.get_content_type() == "multipart/alternative"
    assert msg.get_body(("plain",)).get_content().strip() == "plain text"
    assert "<td>cell</td>" in msg.get_body(("html",)).get_content()
    assert msg["Bcc"] is None and server.envelope == ["a@example.com", "c@example.com", "b@example.com"]

    # With a file as well: the two bodies stay together, the file rides beside them.
    _REAL_SEND("Digest", "plain text", ["a@example.com"], html="<p>x</p>",
               attachments=[{"filename": "list.csv", "content": b"a,b", "mime": "text/csv"}])
    msg = FakeSMTP.instances[-1].message
    assert msg.get_content_type() == "multipart/mixed"
    assert [p.get_content_type() for p in msg.iter_parts()] == ["multipart/alternative", "text/csv"]

    # Without html nothing about the message changed.
    _REAL_SEND("Plain", "just text", ["a@example.com"])
    assert FakeSMTP.instances[-1].message.get_content_type() == "text/plain"


def test_mailer_skip_dicts_are_exactly_what_they_were(transport, monkeypatch):
    assert _REAL_SEND("Subject\r\nBcc: evil@example.com", "body", ["a@example.com"],
                      html="<p>x</p>") == {"ok": False, "reason": "invalid_header"}
    assert _REAL_SEND("Subject", "body", [" ", None]) == {"ok": False, "reason": "no_recipient"}
    transport(SMTP_HOST=None)
    assert _REAL_SEND("Subject", "body", ["a@example.com"]) == {"ok": False, "reason": "smtp_not_configured"}
    assert FakeSMTP.instances == []                       # none of them opened a connection


def test_mailer_sets_reply_to_and_refuses_a_forged_one(transport):
    assert _REAL_SEND("Subject", "body", ["a@example.com"], reply_to="store.inbox@example.com")["ok"] is True
    assert FakeSMTP.instances[-1].message["Reply-To"] == "store.inbox@example.com"
    _REAL_SEND("Subject", "body", ["a@example.com"])
    assert FakeSMTP.instances[-1].message["Reply-To"] is None            # none asked for, none set
    opened = len(FakeSMTP.instances)
    assert _REAL_SEND("Subject", "body", ["a@example.com"],
                      reply_to="x@example.com\r\nBcc: evil@example.com") == {"ok": False, "reason": "invalid_header"}
    assert len(FakeSMTP.instances) == opened                             # refused before any connection


def test_mailer_reports_refused_recipients(transport):
    FakeSMTP.refused = {"gone@example.com": (550, b"No such user"), "also@example.com": (550, b"No such user")}
    out = _REAL_SEND("Subject", "body", ["a@example.com", "gone@example.com"], cc=["also@example.com"])
    assert out == {"ok": True, "to": ["a@example.com", "gone@example.com"], "cc": ["also@example.com"], "bcc": [],
                   "refused": ["also@example.com", "gone@example.com"]}


@pytest.mark.parametrize("exc,expected", [
    (smtplib.SMTPDataError(554, b"5.7.1 Relay access denied"),
     {"error": "SMTPDataError", "detail": "554 5.7.1 Relay access denied", "permanent": True}),
    (smtplib.SMTPDataError(451, b"4.3.0 Try again later"),
     {"error": "SMTPDataError", "detail": "451 4.3.0 Try again later", "permanent": False}),
    (smtplib.SMTPAuthenticationError(535, b"5.7.8 Bad credentials"),
     {"error": "SMTPAuthenticationError", "detail": "535 5.7.8 Bad credentials", "permanent": True}),
    (smtplib.SMTPRecipientsRefused({"a@example.com": (550, b"No such\r\n user")}),
     {"error": "SMTPRecipientsRefused", "detail": "a@example.com: 550 No such user", "permanent": True}),
    (smtplib.SMTPRecipientsRefused({"a@example.com": (450, b"Mailbox busy")}),
     {"error": "SMTPRecipientsRefused", "detail": "a@example.com: 450 Mailbox busy", "permanent": False}),
    (smtplib.SMTPNotSupportedError("STARTTLS extension not supported by server."),
     {"error": "SMTPNotSupportedError", "detail": "STARTTLS extension not supported by server.", "permanent": True}),
    (smtplib.SMTPServerDisconnected("Connection unexpectedly closed"),
     {"error": "SMTPServerDisconnected", "detail": "Connection unexpectedly closed", "permanent": False}),
    (TimeoutError("timed out"), {"error": "TimeoutError", "detail": "timed out", "permanent": False}),
])
def test_mailer_failure_carries_the_servers_answer_and_whether_to_retry(transport, exc, expected):
    FakeSMTP.raises = exc
    assert _REAL_SEND("Subject", "body", ["a@example.com"]) == {"ok": False, "reason": "send_failed", **expected}


def test_mailer_never_returns_the_password(transport):
    secret = "s3cr3t-Pa55word"
    transport(SMTP_USER="store@example.com", SMTP_PASSWORD=secret)
    FakeSMTP.raises = RuntimeError(f"debug dump: AUTH PLAIN {secret} rejected")
    out = _REAL_SEND("Subject", "body", ["a@example.com"])
    assert secret not in repr(out) and out["detail"] == "debug dump: AUTH PLAIN *** rejected"
    assert FakeSMTP.instances[-1].steps == ["starttls", "login"]


def test_mailer_refuses_to_sign_in_without_tls(transport):
    transport(SMTP_USER="store@example.com", SMTP_PASSWORD="pw", SMTP_USE_TLS=False, SMTP_USE_SSL=False, SMTP_PORT=25)
    assert _REAL_SEND("Subject", "body", ["a@example.com"]) == {"ok": False, "reason": "auth_requires_tls"}
    assert FakeSMTP.instances == []                       # refused before any connection
    # No sign-in at all (an open internal relay) is still allowed in the clear…
    transport(SMTP_USE_TLS=False, SMTP_PORT=25)
    assert _REAL_SEND("Subject", "body", ["a@example.com"])["ok"] is True
    assert FakeSMTP.instances[-1].steps == ["send"]
    # …and a sign-in over SSL or STARTTLS goes ahead.
    transport(SMTP_USER="store@example.com", SMTP_PASSWORD="pw", SMTP_USE_TLS=False, SMTP_PORT=465)
    assert _REAL_SEND("Subject", "body", ["a@example.com"])["ok"] is True
    assert FakeSMTP.instances[-1].steps == ["login", "send"]


def test_smtp_settings_with_sign_in_but_no_tls_cannot_be_saved():
    from app.services.settings_service import SettingsService
    svc = SettingsService()
    with pytest.raises(ValidationError) as err:
        svc.set_smtp_config({"host": "mail.local", "port": 25, "requires_auth": True,
                             "use_tls": False, "use_ssl": False})
    assert "use_tls" in err.value.errors
    assert AppSetting.get_value("smtp", _ABSENT) is _ABSENT            # the refused save stored nothing
    # The same server is fine without a sign-in, with STARTTLS, with SSL, or on the SSL port.
    for ok in ({"requires_auth": False, "use_tls": False, "use_ssl": False, "port": 25},
               {"requires_auth": True, "use_tls": True, "use_ssl": False, "port": 587},
               {"requires_auth": True, "use_tls": False, "use_ssl": True, "port": 25},
               {"requires_auth": True, "use_tls": False, "use_ssl": False, "port": 465}):
        saved = svc.set_smtp_config({"host": "mail.local", **ok})
        assert saved["host"] == "mail.local" and "password" not in saved
