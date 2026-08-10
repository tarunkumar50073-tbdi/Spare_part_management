"""Application configuration loaded from environment variables (.env driven)."""
import os
from dotenv import load_dotenv

basedir = os.path.abspath(os.path.dirname(__file__))
load_dotenv(os.path.join(basedir, ".env"))


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

    # ERP SRV-submission API — outbound call that issues the official SRV
    # number (and short-note number, when short). Unset in dev: ERPClient
    # falls back to local mock generation until the real ERP endpoint is live.
    ERP_API_BASE_URL = os.getenv("ERP_API_BASE_URL") or None
    ERP_API_TIMEOUT = int(os.getenv("ERP_API_TIMEOUT", "10"))

    # ERP Ledger auto-import "inbox" — drop the ERP stock-ledger Excel in this
    # folder and the app imports it automatically (a folder-drop bridge until
    # the ERP API push is live). Processed files move to processed/ or failed/
    # subfolders. ERP_LEDGER_POLL_SECONDS is the background scan interval;
    # set it to 0 to disable the poller (the "Scan Now" button still works).
    ERP_LEDGER_INBOX = os.getenv("ERP_LEDGER_INBOX", os.path.join(basedir, "erp_ledger_inbox"))
    ERP_LEDGER_POLL_SECONDS = int(os.getenv("ERP_LEDGER_POLL_SECONDS", "300"))


class DevelopmentConfig(Config):
    DEBUG = True


class ProductionConfig(Config):
    DEBUG = False


config_by_name = {
    "development": DevelopmentConfig,
    "production": ProductionConfig,
}
