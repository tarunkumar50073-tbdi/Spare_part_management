"""Window-time auto-mail send flow — SMTP is stubbed (no real mail), so the
skip reasons, the exact subject/attachment, and the durable once-per-day
idempotency are covered without a relay."""
from app.extensions import db
from app.models.report_recipient import ReportRecipient
from app.models.mail_send_log import MailSendLog
from app.services import window_time_mail_service as wm
from app.services.window_time_mail_service import WindowTimeMailService, REPORT_KEY, ATTACHMENT_NAME


def test_send_flow_and_idempotency(monkeypatch):
    svc = WindowTimeMailService()

    # 1) SMTP not configured -> skipped, never raises
    monkeypatch.setattr(wm.mailer, "smtp_is_configured", lambda: False)
    r = svc.send_current_month()
    assert r["status"] == "skipped" and r["reason"] == "smtp_not_configured"

    # 2) configured, but every seeded recipient e-mail is blank -> skipped
    monkeypatch.setattr(wm.mailer, "smtp_is_configured", lambda: True)
    sent_calls = []

    def fake_send(**kw):
        sent_calls.append(kw)
        return {"ok": True, "to": kw["to"], "cc": kw["cc"]}

    monkeypatch.setattr(wm.mailer, "send_email", fake_send)
    r = svc.send_current_month()
    assert r["status"] == "skipped" and r["reason"] == "no_recipient_email"

    # 3) give the seeded TO recipient an address -> sends, exact subject + attachment
    to_row = ReportRecipient.query.filter_by(report_key=REPORT_KEY, role="TO").first()
    assert to_row is not None            # proves the boot seed ran
    to_row.email = "pintu@example.com"
    db.session.commit()

    r = svc.send_current_month()
    assert r["status"] == "sent"
    assert r["to"] == ["pintu@example.com"]
    assert r["subject"].startswith("SUPPLIER WINDOW TIME ON DATED ")
    assert sent_calls[-1]["attachments"][0]["filename"] == ATTACHMENT_NAME
    assert MailSendLog.query.filter_by(report_key=REPORT_KEY).count() == 1

    # 4) second unforced call same day -> skipped (durable log), no second mail
    n_before = len(sent_calls)
    r2 = svc.send_current_month(force=False)
    assert r2["status"] == "skipped" and r2["reason"] == "already_sent_today"
    assert len(sent_calls) == n_before

    # 5) forced (the 'Email now' button) -> sends again despite the log
    r3 = svc.send_current_month(force=True)
    assert r3["status"] == "sent"
    assert len(sent_calls) == n_before + 1


def test_header_injection_and_ssl_branch(monkeypatch):
    """The mailer refuses a CR/LF in any header value rather than sending."""
    from app.utils import mailer

    class _Cfg(dict):
        pass

    cfg = _Cfg(SMTP_HOST="mail.local", SMTP_FROM="store@x.com", SMTP_USER=None,
               SMTP_PASSWORD=None, SMTP_PORT=587, MAIL_FROM_DISPLAY="TBDI_store",
               SMTP_USE_TLS=True, SMTP_USE_SSL=False, SMTP_TIMEOUT=5)
    monkeypatch.setattr(mailer, "current_app", type("A", (), {"config": cfg}))
    out = mailer.send_email("Subject\r\nBcc: evil@x.com", "body", ["a@x.com"])
    assert out == {"ok": False, "reason": "invalid_header"}
