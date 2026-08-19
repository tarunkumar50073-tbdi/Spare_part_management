"""Reusable outbound e-mail via stdlib smtplib — no Flask-Mail dependency, same
'no-op until configured' shape as ERPClient. Reads SMTP_* from
current_app.config at call time (never imports Config), guards against header
injection, verifies TLS, and never puts the password in logs or return values.

Ships DISABLED: with SMTP_HOST unset, send_email returns
{'ok': False, 'reason': 'smtp_not_configured'} and never raises — safe to call
before the plant relay is provided.
"""
import logging
import smtplib
import ssl
from email.message import EmailMessage

from flask import current_app

logger = logging.getLogger("dxstore.mailer")


def smtp_is_configured():
    c = current_app.config
    return bool(c.get("SMTP_HOST") and (c.get("SMTP_FROM") or c.get("SMTP_USER")))


def _has_bad_header(*values):
    """A CR/LF in any header value is a header-injection attempt (forged extra
    headers / recipients) — refuse rather than send."""
    return any(v and ("\n" in str(v) or "\r" in str(v)) for v in values)


def send_email(subject, body, to, cc=None, attachments=None, from_display=None):
    """Send a plain-text e-mail with optional file attachments.

    to/cc: lists of address strings. attachments: list of
    {filename, content (bytes), mime ('type/subtype')}. Returns
    {'ok': True, 'to': [...], 'cc': [...]} on success or
    {'ok': False, 'reason': ...} on any skip/failure. Never raises; the password
    is never logged or returned.
    """
    c = current_app.config
    to = [a.strip() for a in (to or []) if a and a.strip()]
    cc = [a.strip() for a in (cc or []) if a and a.strip()]
    if not smtp_is_configured():
        return {"ok": False, "reason": "smtp_not_configured"}
    if not to:
        return {"ok": False, "reason": "no_recipient"}

    from_addr = c.get("SMTP_FROM") or c.get("SMTP_USER")
    from_display = from_display or c.get("MAIL_FROM_DISPLAY")
    if _has_bad_header(subject, from_addr, from_display, *to, *cc):
        return {"ok": False, "reason": "invalid_header"}

    msg = EmailMessage()
    msg["Subject"] = subject or ""
    msg["From"] = f"{from_display} <{from_addr}>" if from_display else from_addr
    msg["To"] = ", ".join(to)
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg.set_content(body or "")
    for att in attachments or []:
        maintype, _, subtype = (att.get("mime") or "application/octet-stream").partition("/")
        msg.add_attachment(att["content"], maintype=maintype, subtype=subtype or "octet-stream",
                           filename=att["filename"])

    host, port = c["SMTP_HOST"], c.get("SMTP_PORT", 587)
    user, password = c.get("SMTP_USER"), c.get("SMTP_PASSWORD")
    use_ssl = bool(c.get("SMTP_USE_SSL")) or port == 465        # implicit TLS
    use_tls = c.get("SMTP_USE_TLS", True)                       # STARTTLS
    timeout = c.get("SMTP_TIMEOUT", 20)
    context = ssl.create_default_context()  # verifies cert + hostname
    try:
        if use_ssl:
            server = smtplib.SMTP_SSL(host, port, context=context, timeout=timeout)
        else:
            server = smtplib.SMTP(host, port, timeout=timeout)
        with server:
            if not use_ssl and use_tls:
                server.starttls(context=context)
            if user and password:
                server.login(user, password)
            server.send_message(msg, from_addr=from_addr, to_addrs=to + cc)
    except Exception as exc:  # noqa: BLE001 — mail must never crash the caller; never log creds/detail
        logger.warning("send_email failed: %s", type(exc).__name__)
        return {"ok": False, "reason": "send_failed", "error": type(exc).__name__}
    return {"ok": True, "to": to, "cc": cc}
