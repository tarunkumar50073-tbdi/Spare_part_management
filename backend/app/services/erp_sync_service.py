"""ERP -> app mirror sync (READ-ONLY on the ERP side).

Reads the plant ERP Postgres (schema termsdb) through ERPDBClient and refreshes
the local ERP-report mirror tables via their existing replace_* methods. Only
the local SQLite mirrors are written; ERP is never modified.

termsdb exposes 3 tables today; two map onto mirrors that already exist:
    termsdb.gate_entry  -> GateEntry         (vehicle-in / material arrival; feeds window-time)
    termsdb.srv_report  -> ReceivingRegister (GRN receiving history)
termsdb.line_rejection_report has no mirror yet. The other four reports (RGP,
Pending GRN, Current Stock, Stock Valuation, Gate Exit) await their own ERP
source tables — when those appear, add a mapper here the same way.

Full-snapshot sync: each run reads the ERP rows (optionally limited to the last
ERP_SYNC_SINCE_DAYS) and hands them to replace_* (delete-by-store + bulk insert),
so re-running is idempotent and never double-counts. Poller mirrors the ERP
ledger inbox one: per-process, guarded, daemon thread, errors surfaced not fatal.
"""
import logging
import threading
import time
from datetime import date, timedelta

from flask import current_app

from app.models.base import utcnow
from app.services.erp_db_client import ERPDBClient, ERPDBNotConfigured
from app.services.gate_service import GateService
from app.services.receiving_register_service import ReceivingRegisterService

logger = logging.getLogger("dxstore.erp_sync")

STORE_CODE = "CHILD_PART"


def _num(value):
    """ERP qty columns are `character varying`. Cast to float; blank, 'None' and
    anything non-numeric become None rather than raising — a bad cell must not
    fail a 15k-row sync."""
    if value is None:
        return None
    s = str(value).strip().replace(",", "")
    if s == "" or s.lower() == "none":
        return None
    try:
        return float(s)
    except ValueError:
        return None


class ERPSyncService:
    # Per-process status, like ERPLedgerInboxService — survives across requests
    # and the poller thread.
    _last_sync_at = None
    _last_result = None
    _last_error = None
    _poller_started = False
    _lock = threading.Lock()

    def __init__(self):
        self.erp = ERPDBClient()
        self.gate = GateService()
        self.receiving = ReceivingRegisterService()

    def configured(self):
        return self.erp.configured()

    def _since_date(self):
        days = current_app.config.get("ERP_SYNC_SINCE_DAYS", 0)
        return (date.today() - timedelta(days=days)) if days and days > 0 else None

    # ---- per-table mappers (ERP column -> mirror column) ----
    def sync_gate_entry(self):
        cols = ["gate_entry_no", "gate_entry_dt", "gate_entry_time", "ven_cd", "ven_name",
                "challan_dt", "po_no", "item_cd", "reference_code", "item_desc", "qty"]
        raw = self.erp.fetch_rows("gate_entry", cols, since_col="gate_entry_dt", since_date=self._since_date())
        rows = [{
            "gate_entry_no": r.get("gate_entry_no"),
            "gate_entry_dt": r.get("gate_entry_dt"),
            "gate_entry_time": r.get("gate_entry_time"),
            "ven_cd": r.get("ven_cd"), "ven_name": r.get("ven_name"),
            "bill_no": None, "bill_date": r.get("challan_dt"),
            "po_no": r.get("po_no"),
            "item_code": r.get("item_cd"),
            "reference_code": r.get("reference_code"),
            "item_desc": r.get("item_desc"),
            "qty": _num(r.get("qty")),
            "hsn": None,
        } for r in raw]
        return self.gate.replace_entries(STORE_CODE, rows)

    def sync_receiving_register(self):
        cols = ["grn_no", "grn_date", "vendor_cd", "vendor_name", "invoice_no",
                "item_cd", "item_desc", "challan_qty", "receipt_qty", "accept_qty", "reject_qty"]
        raw = self.erp.fetch_rows("srv_report", cols, since_col="grn_date", since_date=self._since_date())
        rows = [{
            "grn_no": r.get("grn_no"), "grn_date": r.get("grn_date"),
            "ven_cd": r.get("vendor_cd"), "ven_name": r.get("vendor_name"),
            "gate_entry_no": None, "gate_entry_dt": None,
            "challan_no": r.get("invoice_no"), "challan_dt": None,
            "po_no": None,
            "item_cd": r.get("item_cd"), "item_desc": r.get("item_desc"),
            "challan_qty": _num(r.get("challan_qty")), "receipt_qty": _num(r.get("receipt_qty")),
            "accept_qty": _num(r.get("accept_qty")), "reject_qty": _num(r.get("reject_qty")),
        } for r in raw]
        return self.receiving.replace_from_rows(STORE_CODE, rows)

    def sync_all(self):
        """Refresh every mirror that has an ERP source today. One run at a time
        (a slow full-snapshot must not overlap itself). Raises ERPDBNotConfigured
        when credentials are unset. Returns a per-table row-count summary."""
        if not self.configured():
            raise ERPDBNotConfigured("ERP DB not configured")
        with self._lock:
            result = {
                "gate_entry": self.sync_gate_entry(),
                "receiving_register": self.sync_receiving_register(),
            }
            ERPSyncService._last_sync_at = utcnow().isoformat()
            ERPSyncService._last_result = result
            ERPSyncService._last_error = None
        # Spare receiving is read from ERP: a GRN line whose quality ERP has
        # accepted becomes store stock, once (ErpGrnPostingService). A failure
        # here is logged and never fails the mirror sync itself.
        try:
            from app.services.erp_grn_posting_service import ErpGrnPostingService
            from app.utils.event_bus import publish
            posted = ErpGrnPostingService().post("MAINTENANCE").get("posted", [])
            result["spare_grn_posted"] = len(posted)
            if posted:
                publish("stock", {"store_code": "MAINTENANCE", "action": "erp_grn"})
        except Exception:  # noqa: BLE001
            logger.exception("Posting ERP GRNs to spare stock failed")
        return result

    def status(self):
        return {
            "configured": self.configured(),
            "poll_seconds": current_app.config.get("ERP_SYNC_POLL_SECONDS", 0),
            "since_days": current_app.config.get("ERP_SYNC_SINCE_DAYS", 0),
            "last_sync_at": ERPSyncService._last_sync_at,
            "last_result": ERPSyncService._last_result,
            "last_error": ERPSyncService._last_error,
        }

    def start_poller(self, app):
        """Start the background sync loop once. No-op if the interval is 0, the
        ERP DB is not configured, or a poller is already running in this process.
        `app.config` is read directly (no app context here in create_app); the
        loop opens its own app_context per run."""
        interval = app.config.get("ERP_SYNC_POLL_SECONDS", 0)
        configured = bool(app.config.get("ERP_DB_HOST") and app.config.get("ERP_DB_USER")
                          and app.config.get("ERP_DB_PASSWORD"))
        if not interval or interval <= 0 or not configured or ERPSyncService._poller_started:
            return
        ERPSyncService._poller_started = True

        def loop():
            # Sync-first, not sleep-first: refresh ERP data ~immediately on start
            # so it is fresh the moment the app comes up (and after every restart),
            # then repeat on the interval. Sleep-first meant a backend that
            # restarted within the interval never completed a first sync — which
            # is exactly why the mirror could sit days behind ERP.
            time.sleep(3)  # let the app finish starting before the first pull
            while True:
                try:
                    with app.app_context():
                        self.sync_all()
                except Exception as exc:  # noqa: BLE001 — never let the poller thread die
                    ERPSyncService._last_error = f"{type(exc).__name__}: {exc}"
                    logger.exception("ERP sync failed")
                time.sleep(interval)

        threading.Thread(target=loop, name="erp-sync-poller", daemon=True).start()
