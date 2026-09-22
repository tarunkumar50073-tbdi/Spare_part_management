"""Admin Settings: the barcode-label editor, a read-only system-status view,
and store/section visibility.

Only non-secret, admin-tunable values live here. Real secrets and infra config
(SMTP password, ERP DB credentials, API key, DB URL, CORS) stay in the
git-ignored backend/.env and are NEVER read back to the browser — system_status
reports only whether such a thing is configured, never its value.
"""
from flask import current_app

from app.models.app_setting import AppSetting
from app.models.store import Section, Store
from app.services.barcode_service import LABEL_DEFAULTS, LABEL_SETTING_KEY, BarcodeService


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

    # ---- read-only system status ----

    def system_status(self):
        """A safe snapshot of operational config for the admin to SEE. Secrets
        are reduced to booleans ("configured" yes/no); no host, user, password,
        key or URL value is ever included."""
        cfg = current_app.config
        smtp_configured = bool(cfg.get("SMTP_HOST") and (cfg.get("SMTP_FROM") or cfg.get("SMTP_USER")))
        erp_write = bool(cfg.get("ERP_STOCK_WRITE_ENABLED"))
        erp_api = bool(cfg.get("ERP_API_BASE_URL"))
        max_bytes = cfg.get("MAX_CONTENT_LENGTH") or 0
        return {
            "email": {
                "configured": smtp_configured,
                "daily_mail_enabled": bool(cfg.get("WINDOW_TIME_MAIL_ENABLED")),
                "daily_mail_hour": cfg.get("WINDOW_TIME_MAIL_HOUR"),
                "smtp_port": cfg.get("SMTP_PORT"),
                "use_tls": bool(cfg.get("SMTP_USE_TLS")),
                "use_ssl": bool(cfg.get("SMTP_USE_SSL")),
                "from_display": cfg.get("MAIL_FROM_DISPLAY"),
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
        }

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
