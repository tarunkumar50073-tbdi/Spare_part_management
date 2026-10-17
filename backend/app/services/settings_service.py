"""Admin Settings: the label editor, the label printer, a read-only
system-status view, and store/section visibility.

Only non-secret, admin-tunable values live here. Real secrets and infra config
(SMTP password, ERP DB credentials, API key, DB URL, CORS) stay in the
git-ignored backend/.env and are NEVER read back to the browser — system_status
reports only whether such a thing is configured, never its value.
"""
from flask import current_app

from app.models.app_setting import AppSetting
from app.models.store import Section, Store
from app.services.backup_service import BackupService
from app.services.barcode_service import (
    LABEL_DEFAULTS, LABEL_SETTING_KEY, PRINTER_DEFAULTS, PRINTER_SETTING_KEY, BarcodeService,
)
from app.services.email_engine import EmailEngine
from app.services.email_rules import rule_settings
from app.utils import mailer
from app.utils.exceptions import ValidationError

SMTP_SETTING_KEY = "smtp"
# Non-secret SMTP server fields an admin may set from the UI. The password is
# NEVER among them — when auth is required it stays in .env (SMTP_PASSWORD).
SMTP_FIELDS = ("host", "port", "from_email", "from_display", "use_tls", "use_ssl",
               "requires_auth", "username")


class SettingsService:
    def __init__(self):
        self.barcode = BarcodeService()

    # ---- barcode label template ----

    def label_config(self):
        return self.barcode.label_config()

    def set_label_config(self, data, user=None):
        """Merge the given fields over the current label template and persist.
        Only known label keys are kept; the route validates ranges/values."""
        current = self.label_config()
        current.update({k: v for k, v in (data or {}).items() if k in LABEL_DEFAULTS})
        AppSetting.set_value(LABEL_SETTING_KEY, current, user)
        return current

    # ---- label printer ----

    def label_printer(self):
        return self.barcode.printer_config()

    def set_label_printer(self, data, user=None):
        """Merge the given fields over the saved printer and persist. The route
        validates each field; the one cross-field rule is checked here, after
        the merge, so a partial update is judged on the printer it produces: a
        NETWORK printer needs an address, or its status could never be checked.
        A BROWSER printer keeps any saved address for switching back."""
        current = self.label_printer()
        current.update({k: v for k, v in (data or {}).items() if k in PRINTER_DEFAULTS})
        current["name"] = (current.get("name") or "").strip() or PRINTER_DEFAULTS["name"]
        current["host"] = (current.get("host") or "").strip() or None
        if current["connection"] == "NETWORK" and not current["host"]:
            msg = "A network printer needs its IP address or host name"
            raise ValidationError(msg, errors={"host": [msg]})
        AppSetting.set_value(PRINTER_SETTING_KEY, current, user)
        return current

    # ---- SMTP mail server (non-secret: host / port / From / TLS / auth toggle) ----

    def smtp_config(self):
        """The effective SMTP server settings for the Settings screen — the saved
        DB values over the .env defaults. A password is NEVER returned; the UI
        only learns whether one is present in .env (`password_in_env`)."""
        c = mailer.effective_smtp_cfg()
        saved = AppSetting.get_value(SMTP_SETTING_KEY, {}) or {}
        return {
            "host": c.get("SMTP_HOST") or "",
            "port": int(c.get("SMTP_PORT") or 25),
            "from_email": c.get("SMTP_FROM") or "",
            "from_display": c.get("MAIL_FROM_DISPLAY") or "",
            "use_tls": bool(c.get("SMTP_USE_TLS", True)),
            "use_ssl": bool(c.get("SMTP_USE_SSL")),
            "requires_auth": bool(saved.get("requires_auth", bool(c.get("SMTP_USER")))),
            "username": c.get("SMTP_USER") or "",
            "configured": mailer.smtp_is_configured(),
            "password_in_env": bool(current_app.config.get("SMTP_PASSWORD")),
        }

    def set_smtp_config(self, data, user=None):
        """Persist the non-secret SMTP server settings (takes effect at once, no
        restart). The password is never accepted here."""
        current = AppSetting.get_value(SMTP_SETTING_KEY, {}) or {}
        for k in SMTP_FIELDS:
            if k in data:
                current[k] = data[k]
        # A sign-in with neither SSL nor STARTTLS would put the mailbox password
        # on the LAN in the clear; the mailer refuses to send that way, so do
        # not let it be saved. Judged after the merge (like the printer rule
        # above), each value falling back to .env exactly as the mailer reads it.
        cfg = current_app.config
        encrypted = (current.get("use_tls", cfg.get("SMTP_USE_TLS", True))
                     or current.get("use_ssl", cfg.get("SMTP_USE_SSL"))
                     or (current.get("port") or cfg.get("SMTP_PORT")) == 465)
        if current.get("requires_auth", bool(cfg.get("SMTP_USER"))) and not encrypted:
            msg = "A mail server that needs a sign-in must use TLS or SSL — switch one on, or turn the sign-in off"
            raise ValidationError(msg, errors={"use_tls": [msg]})
        AppSetting.set_value(SMTP_SETTING_KEY, current, user)
        return self.smtp_config()

    def send_test_mail(self, to, user=None):
        """Send a one-line test mail to prove the current SMTP settings work.
        Returns the mailer's result ({'ok':..., 'reason'?:...})."""
        to = (to or "").strip()
        if not to:
            raise ValidationError("A test recipient e-mail is required", errors={"to": ["required"]})
        # Through the mail engine (same result dict), so a test shows in Email Logs.
        return EmailEngine().submit(
            mail_type="smtp_test", subject="TBDI Digital SMP — test mail",
            body=("This is a test mail from TBDI Digital SMP.\nIf you received it, the mail settings work."
                  f"\n\n{mailer.SYSTEM_NOTE}"),
            to=[to], trigger="TEST", triggered_by=user, mode="sync")

    # ---- read-only system status ----

    def system_status(self):
        """A safe snapshot of operational config for the admin to SEE. Secrets
        are reduced to booleans ("configured" yes/no); no host, user, password,
        key or URL value is ever included."""
        cfg = current_app.config
        # SMTP reflects the EFFECTIVE config (Settings-screen values over .env).
        smtp = mailer.effective_smtp_cfg()
        # The daily window-time mail is a notification rule now; the .env flags
        # are only its default until an admin saves it.
        daily_mail, _ = rule_settings("window_time_daily")
        erp_write = bool(cfg.get("ERP_STOCK_WRITE_ENABLED"))
        erp_api = bool(cfg.get("ERP_API_BASE_URL"))
        max_bytes = cfg.get("MAX_CONTENT_LENGTH") or 0
        return {
            "email": {
                "configured": mailer.smtp_is_configured(),
                "daily_mail_enabled": daily_mail["enabled"],
                "daily_mail_hour": daily_mail["hour"],
                "smtp_port": smtp.get("SMTP_PORT"),
                "use_tls": bool(smtp.get("SMTP_USE_TLS")),
                "use_ssl": bool(smtp.get("SMTP_USE_SSL")),
                "from_display": smtp.get("MAIL_FROM_DISPLAY"),
            },
            "erp": {
                "read_sync_configured": bool(cfg.get("ERP_DB_HOST")),
                "sync_since_days": cfg.get("ERP_SYNC_SINCE_DAYS"),
                "sync_poll_seconds": cfg.get("ERP_SYNC_POLL_SECONDS"),
                "ledger_poll_seconds": cfg.get("ERP_LEDGER_POLL_SECONDS"),
                "stock_write_enabled": erp_write,
                "stock_write_endpoint_set": erp_api,
                "stock_write_active": erp_write and erp_api,
            },
            "uploads": {
                "max_mb": round(max_bytes / (1024 * 1024), 1) if max_bytes else None,
            },
            "label": self.label_config(),
            "backup": self.backup_status(),
        }

    def backup_status(self):
        """The daily database backup (store's request of 16 Oct 2026): on/off,
        the time, days kept, the last attempt and the newest good file. A
        problem reading it is shown in its own box — it must never take the
        rest of System status down with it."""
        try:
            return BackupService().status()
        except Exception as exc:  # noqa: BLE001
            current_app.logger.exception("system status: backup status failed")
            return {"available": False, "error": f"{type(exc).__name__}: {exc}"}

    # ---- store / section visibility ----

    def store_visibility(self):
        """Every store and section (active AND inactive) with its on/off state,
        so the admin can re-enable one that was switched off — the normal store
        list only returns active rows."""
        out = []
        for s in Store.query.order_by(Store.sort_order.asc(), Store.name.asc()).all():
            sections = Section.query.filter_by(store_id=s.id).order_by(
                Section.sort_order.asc(), Section.name.asc()).all()
            out.append({
                "code": s.code,
                "name": s.name,
                "icon": s.icon,
                "is_active": s.is_active,
                "sections": [
                    {"id": sec.id, "name": sec.name, "is_active": sec.is_active}
                    for sec in sections
                ],
            })
        return out
