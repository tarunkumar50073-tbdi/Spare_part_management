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


# How every mail of the app ends. The mails used to close with "Regards," and a
# name (the window-time sheet even carried a person's); they are sent by the
# system, so they say so instead — the store's instruction, 13 Oct 2026. It is
# the default closing of the reorder and window-time mails and the default
# signature of the mail engine's own mails; an administrator can still reword it
# on the Email Templates screen. The note sits under a dashed rule — asked for the
# same day; the rule is part of the text, so the plain-text and the HTML body both
# show it. Do not drop it.
SYSTEM_NOTE = "-" * 47 + "\nNote: This is a system-generated mail."


def effective_smtp_cfg():
    """The SMTP settings the mailer actually uses: the admin's saved DB settings
    (non-secret — host, port, From, TLS/SSL, the auth toggle and username)
    override the .env defaults, so the server can be set from the Settings screen
    with no restart. The password is never stored in the DB; it still comes from
    .env (SMTP_PASSWORD), and when the admin marks auth 'not required' no login
    is attempted at all (this O365 direct-send relay needs none)."""
    c = dict(current_app.config)
    try:
        from app.models.app_setting import AppSetting
        s = AppSetting.get_value("smtp", None) or {}
    except Exception:  # noqa: BLE001 — a settings read must never break sending
        s = {}
    if (s.get("host") or "").strip():
        c["SMTP_HOST"] = s["host"].strip()
    if s.get("port"):
        try:
            c["SMTP_PORT"] = int(s["port"])
        except (TypeError, ValueError):
            pass
    if (s.get("from_email") or "").strip():
        c["SMTP_FROM"] = s["from_email"].strip()
    if "from_display" in s:
        c["MAIL_FROM_DISPLAY"] = (s.get("from_display") or "").strip() or None
    if "use_tls" in s:
        c["SMTP_USE_TLS"] = bool(s["use_tls"])
    if "use_ssl" in s:
        c["SMTP_USE_SSL"] = bool(s["use_ssl"])
    if s.get("requires_auth") is False:
        c["SMTP_USER"] = None
        c["SMTP_PASSWORD"] = None
    elif (s.get("username") or "").strip():
        c["SMTP_USER"] = s["username"].strip()  # password stays from .env
    return c


def smtp_is_configured():
    c = effective_smtp_cfg()
    return bool(c.get("SMTP_HOST") and (c.get("SMTP_FROM") or c.get("SMTP_USER")))


def _has_bad_header(*values):
    """A CR/LF in any header value is a header-injection attempt (forged extra
    headers / recipients) — refuse rather than send."""
    return any(v and ("\n" in str(v) or "\r" in str(v)) for v in values)


def _error_detail(exc, password=None):
    """The mail server's own answer to a failed send, made safe to store and
    show: reply code + text for an SMTP reply, otherwise the error's message.
    It is the one thing that tells an expired password from a refused relay from
    a dead network. smtplib never puts the password in an error, but it is
    blanked here all the same so no future code path can leak it into a log."""
    def text_of(value):
        return value.decode("utf-8", "replace") if isinstance(value, bytes) else str(value)

    if isinstance(exc, smtplib.SMTPRecipientsRefused):
        text = "; ".join(f"{addr}: {code} {text_of(msg)}"
                         for addr, (code, msg) in exc.recipients.items())
    elif isinstance(exc, smtplib.SMTPResponseException):
        text = f"{exc.smtp_code} {text_of(exc.smtp_error)}"
    else:
        text = str(exc)
    if password:
        text = text.replace(password, "***")
    return " ".join(text.split())[:300]


def _is_permanent(exc):
    """True when trying again cannot help: the server refused the sign-in, lacks
    what the settings ask for (STARTTLS / AUTH), or answered 5xx. Everything
    else — a dropped connection, a timeout, a 4xx 'try later' — is worth a retry."""
    if isinstance(exc, (smtplib.SMTPAuthenticationError, smtplib.SMTPNotSupportedError)):
        return True
    if isinstance(exc, smtplib.SMTPRecipientsRefused):
        return all(500 <= code < 600 for code, _ in exc.recipients.values())
    if isinstance(exc, smtplib.SMTPResponseException):
        return 500 <= exc.smtp_code < 600
    return False


def send_email(subject, body, to, cc=None, bcc=None, attachments=None, from_display=None, html=None,
               reply_to=None):
    """Send an e-mail with optional file attachments — plain text, plus an HTML
    alternative when `html` is given (a client that cannot show HTML falls back
    to `body`).

    to/cc/bcc: lists of address strings. Bcc addresses go only on the envelope,
    never in a header, so To/Cc recipients can't see them. reply_to: the address
    a reply goes to instead of From. attachments: list of
    {filename, content (bytes), mime ('type/subtype')}. Returns
    {'ok': True, 'to': [...], 'cc': [...], 'bcc': [...]} on success — with a
    'refused' list added only when the server took the mail but turned some
    recipients away — or {'ok': False, 'reason': ...} on any skip/failure. A
    'send_failed' also carries 'error' (the exception class), 'detail' (the
    server's answer, no secret in it) and 'permanent' (retrying cannot help).
    Never raises; the password is never logged or returned.
    """
    c = effective_smtp_cfg()
    to = [a.strip() for a in (to or []) if a and a.strip()]
    cc = [a.strip() for a in (cc or []) if a and a.strip()]
    bcc = [a.strip() for a in (bcc or []) if a and a.strip()]
    if not smtp_is_configured():
        return {"ok": False, "reason": "smtp_not_configured"}
    if not to and not cc and not bcc:
        return {"ok": False, "reason": "no_recipient"}

    from_addr = c.get("SMTP_FROM") or c.get("SMTP_USER")
    from_display = from_display or c.get("MAIL_FROM_DISPLAY")
    if _has_bad_header(subject, from_addr, from_display, reply_to, *to, *cc, *bcc):
        return {"ok": False, "reason": "invalid_header"}

    msg = EmailMessage()
    msg["Subject"] = subject or ""
    msg["From"] = f"{from_display} <{from_addr}>" if from_display else from_addr
    msg["To"] = ", ".join(to)
    if cc:
        msg["Cc"] = ", ".join(cc)
    if reply_to:
        msg["Reply-To"] = reply_to
    msg.set_content(body or "")
    if html:
        msg.add_alternative(html, subtype="html")
    for att in attachments or []:
        maintype, _, subtype = (att.get("mime") or "application/octet-stream").partition("/")
        msg.add_attachment(att["content"], maintype=maintype, subtype=subtype or "octet-stream",
                           filename=att["filename"])

    host, port = c["SMTP_HOST"], c.get("SMTP_PORT", 587)
    user, password = c.get("SMTP_USER"), c.get("SMTP_PASSWORD")
    use_ssl = bool(c.get("SMTP_USE_SSL")) or port == 465        # implicit TLS
    use_tls = c.get("SMTP_USE_TLS", True)                       # STARTTLS
    timeout = c.get("SMTP_TIMEOUT", 20)
    # A sign-in over a channel with neither SSL nor STARTTLS would put the
    # mailbox password on the LAN in the clear — refuse before even connecting.
    if user and password and not use_ssl and not use_tls:
        return {"ok": False, "reason": "auth_requires_tls"}
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
            # smtplib raises only when EVERY recipient is refused; a partial
            # refusal comes back here as {address: (code, text)}.
            refused = server.send_message(msg, from_addr=from_addr, to_addrs=to + cc + bcc)
    except Exception as exc:  # noqa: BLE001 — mail must never crash the caller; never log creds/detail
        logger.warning("send_email failed: %s", type(exc).__name__)
        return {"ok": False, "reason": "send_failed", "error": type(exc).__name__,
                "detail": _error_detail(exc, password), "permanent": _is_permanent(exc)}
    result = {"ok": True, "to": to, "cc": cc, "bcc": bcc}
    if refused:
        result["refused"] = sorted(refused)
    return result
