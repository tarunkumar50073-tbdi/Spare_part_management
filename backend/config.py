"""Application configuration loaded from environment variables (.env driven)."""
import os
from dotenv import load_dotenv

basedir = os.path.abspath(os.path.dirname(__file__))
load_dotenv(os.path.join(basedir, ".env"))


def _env_bool(name, default):
    """bool(os.getenv('x')) is truthy even for 'false' — parse real booleans."""
    return os.getenv(name, default).strip().lower() in ("1", "true", "yes", "on")


class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret")
    SQLALCHEMY_DATABASE_URI = os.getenv("DATABASE_URL", f"sqlite:///{os.path.join(basedir, 'dx_store.db')}")
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")

    # Shared API key guarding every /api route (audit finding C-1). When set,
    # requests must carry it in the X-API-Key header. Left unset it disables
    # the gate — intended only for isolated local dev; production MUST set it.
    API_KEY = os.getenv("API_KEY") or None

    # Reject uploads larger than this (audit finding H-3) — Excel imports load
    # fully into memory, so an unbounded file could exhaust RAM.
    MAX_CONTENT_LENGTH = int(os.getenv("MAX_UPLOAD_BYTES", str(10 * 1024 * 1024)))  # 10 MB

    # Throttle /auth/login so a stolen or guessed password can't be brute-forced
    # (an unlimited login endpoint was the top security finding). In-process
    # sliding window keyed by client IP; tuned generously so a legitimate
    # operator mistyping a few times is never locked out. Tests disable it.
    RATE_LIMIT_ENABLED = _env_bool("RATE_LIMIT_ENABLED", "true")
    LOGIN_RATE_MAX = int(os.getenv("LOGIN_RATE_MAX", "10"))            # attempts...
    LOGIN_RATE_WINDOW = int(os.getenv("LOGIN_RATE_WINDOW", "60"))     # ...per this many seconds, per IP

    # ERP SRV-submission API — outbound call that issues the official SRV
    # number (and short-note number, when short). Unset in dev: ERPClient
    # falls back to local mock generation until the real ERP endpoint is live.
    ERP_API_BASE_URL = os.getenv("ERP_API_BASE_URL") or None
    ERP_API_TIMEOUT = int(os.getenv("ERP_API_TIMEOUT", "10"))

    # Writing spare stock movements (+receipt / -issue) back to ERP is OFF by
    # default and stays off until it is explicitly approved AND enabled. It is a
    # second, independent gate on top of ERP_API_BASE_URL: BOTH the endpoint URL
    # and this flag must be set before any movement is pushed, so a stray config
    # URL can never silently start changing ERP stock. While OFF, movements are
    # deducted/added in the app's own on-hand only and queue as "pending ERP
    # sync" — ERP is never touched. Read-only ERP data pull (ERP_DB_*) is
    # completely separate and always allowed.
    ERP_STOCK_WRITE_ENABLED = _env_bool("ERP_STOCK_WRITE_ENABLED", "false")

    # ERP Ledger auto-import "inbox" — drop the ERP stock-ledger Excel in this
    # folder and the app imports it automatically (a folder-drop bridge until
    # the ERP API push is live). Processed files move to processed/ or failed/
    # subfolders. ERP_LEDGER_POLL_SECONDS is the background scan interval;
    # set it to 0 to disable the poller (the "Scan Now" button still works).
    ERP_LEDGER_INBOX = os.getenv("ERP_LEDGER_INBOX", os.path.join(basedir, "erp_ledger_inbox"))
    ERP_LEDGER_POLL_SECONDS = int(os.getenv("ERP_LEDGER_POLL_SECONDS", "300"))

    # ERP source DB (plant PostgreSQL, schema termsdb) — the app mirrors the ERP
    # reports locally and this READ-ONLY connection refreshes them. The app never
    # writes to ERP (the session is opened read-only). All values come from the
    # environment; the password is NEVER hardcoded and never logged. Leave
    # ERP_DB_HOST unset to keep the sync disabled (mirror tables stay empty).
    ERP_DB_HOST = os.getenv("ERP_DB_HOST") or None
    ERP_DB_PORT = int(os.getenv("ERP_DB_PORT", "5432"))
    ERP_DB_NAME = os.getenv("ERP_DB_NAME", "toyota_db")
    ERP_DB_USER = os.getenv("ERP_DB_USER") or None
    ERP_DB_PASSWORD = os.getenv("ERP_DB_PASSWORD") or None
    ERP_DB_SCHEMA = os.getenv("ERP_DB_SCHEMA", "termsdb")
    ERP_DB_CONNECT_TIMEOUT = int(os.getenv("ERP_DB_CONNECT_TIMEOUT", "8"))
    # Only pull rows on/after (today - N days) to keep the local mirror lean;
    # 0 = no date limit (full history).
    ERP_SYNC_SINCE_DAYS = int(os.getenv("ERP_SYNC_SINCE_DAYS", "120"))
    # Background ERP-sync interval in seconds; 0 disables the poller (the
    # "Sync Now" endpoint still works on demand).
    ERP_SYNC_POLL_SECONDS = int(os.getenv("ERP_SYNC_POLL_SECONDS", "0"))

    # --- Outbound e-mail (window-time daily auto-mail). Backend-only.
    # SMTP_PASSWORD is the only real secret and lives ONLY in the git-ignored
    # backend/.env. The feature ships DISABLED so nothing sends until an admin
    # has filled recipient addresses AND SMTP is verified. STARTTLS on 587 by
    # default; set SMTP_USE_SSL (or port 465) for an implicit-TLS relay. ---
    SMTP_HOST = os.getenv("SMTP_HOST") or None
    SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
    SMTP_USER = os.getenv("SMTP_USER") or None
    SMTP_PASSWORD = os.getenv("SMTP_PASSWORD") or None
    SMTP_FROM = os.getenv("SMTP_FROM") or None
    SMTP_USE_TLS = _env_bool("SMTP_USE_TLS", "true")
    SMTP_USE_SSL = _env_bool("SMTP_USE_SSL", "false")
    SMTP_TIMEOUT = int(os.getenv("SMTP_TIMEOUT", "20"))
    MAIL_FROM_DISPLAY = os.getenv("MAIL_FROM_DISPLAY", "TBDI_store")
    WINDOW_TIME_MAIL_ENABLED = _env_bool("WINDOW_TIME_MAIL_ENABLED", "false")
    WINDOW_TIME_MAIL_HOUR = int(os.getenv("WINDOW_TIME_MAIL_HOUR", "7"))
    # Daily reorder / low-stock mail to each flagged department. Off by default;
    # "Send now" on the Department Emails screen works regardless of this flag.
    REORDER_MAIL_ENABLED = _env_bool("REORDER_MAIL_ENABLED", "false")
    REORDER_MAIL_HOUR = int(os.getenv("REORDER_MAIL_HOUR", "8"))


class DevelopmentConfig(Config):
    DEBUG = True


class ProductionConfig(Config):
    DEBUG = False


config_by_name = {
    "development": DevelopmentConfig,
    "production": ProductionConfig,
}
