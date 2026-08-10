"""ERP Ledger auto-import inbox — the folder-drop bridge that removes the
daily manual upload. Drop the ERP stock-ledger Excel into ERP_LEDGER_INBOX
and either the background poller (every ERP_LEDGER_POLL_SECONDS) or the
"Scan Now" button imports it, then moves the file to processed/ or failed/.

Re-processing is safe: ERPLedgerImportService de-dupes every row by Doc No
(ext_ref), so a file that overlaps a previous one can't double-count. This
is the same import path the ERP API will eventually push to — only the
trigger (folder vs API call) differs, so nothing here is throwaway."""
import logging
import os
import shutil
import threading
import time
from datetime import datetime, timezone

from flask import current_app

from app.services.erp_ledger_import_service import ERPLedgerImportService

_VALID_EXT = (".xlsx", ".xlsm")
_SETTLE_SECONDS = 10  # ignore files still being copied (modified very recently)

logger = logging.getLogger("dxstore.erp_ledger_poller")


class ERPLedgerInboxService:
    # Class-level so status survives across requests and the poller thread.
    _last_scan_at = None
    _recent = []
    _lock = threading.Lock()
    _poller_started = False
    # Surfaced by the status endpoint so a poller that keeps failing is
    # visible in the UI rather than only in the log.
    _last_error = None
    _consecutive_failures = 0

    def _ensure_dirs(self):
        inbox = current_app.config["ERP_LEDGER_INBOX"]
        processed = os.path.join(inbox, "processed")
        failed = os.path.join(inbox, "failed")
        for d in (inbox, processed, failed):
            os.makedirs(d, exist_ok=True)
        return inbox, processed, failed

    def _pending(self, inbox):
        out = []
        for name in os.listdir(inbox):
            path = os.path.join(inbox, name)
            if os.path.isfile(path) and name.lower().endswith(_VALID_EXT):
                out.append(name)
        return sorted(out)

    def scan_once(self):
        """Import every settled Excel in the inbox root, moving each to
        processed/ or failed/. Returns the per-file result list."""
        inbox, processed, failed = self._ensure_dirs()
        importer = ERPLedgerImportService()
        results = []
        now = time.time()
        for name in self._pending(inbox):
            path = os.path.join(inbox, name)
            # Skip a file that's still mid-copy (very recent mtime).
            if now - os.path.getmtime(path) < _SETTLE_SECONDS:
                continue
            entry = {"file": name, "at": datetime.now(timezone.utc).isoformat()}
            try:
                with open(path, "rb") as f:
                    report = importer.import_excel(f)
                entry.update(
                    ok=True, created=report["created"],
                    buy_qty=report["buy_qty"], make_qty=report["make_qty"],
                    skipped=report["skipped_duplicate"] + report["skipped_other"],
                    errors=report["error_count"],
                )
                dest = os.path.join(processed, self._stamp(name))
            except Exception as e:  # noqa: BLE001 — one bad file can't stop the batch
                entry.update(ok=False, error=str(e))
                dest = os.path.join(failed, self._stamp(name))
            try:
                shutil.move(path, dest)
            except OSError:
                pass
            results.append(entry)

        with self._lock:
            ERPLedgerInboxService._last_scan_at = datetime.now(timezone.utc).isoformat()
            if results:
                ERPLedgerInboxService._recent = (results + ERPLedgerInboxService._recent)[:20]
        return results

    def status(self):
        inbox, _, _ = self._ensure_dirs()
        return {
            "inbox_path": inbox,
            "poll_seconds": current_app.config["ERP_LEDGER_POLL_SECONDS"],
            "pending_files": self._pending(inbox),
            "last_scan_at": ERPLedgerInboxService._last_scan_at,
            "recent": ERPLedgerInboxService._recent,
            # A poller stuck on the same error reports "nothing pending" like
            # a healthy one, so its failure state has to be part of the status.
            "last_error": ERPLedgerInboxService._last_error,
            "consecutive_failures": ERPLedgerInboxService._consecutive_failures,
        }

    @staticmethod
    def _stamp(name):
        ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        root, ext = os.path.splitext(name)
        return f"{root}__{ts}{ext}"

    def start_poller(self, app):
        """Start the background scan loop once. No-op if the interval is 0 or
        the poller is already running in this process."""
        interval = app.config.get("ERP_LEDGER_POLL_SECONDS", 0)
        if not interval or interval <= 0 or ERPLedgerInboxService._poller_started:
            return
        ERPLedgerInboxService._poller_started = True

        def loop():
            while True:
                time.sleep(interval)
                try:
                    with app.app_context():
                        self.scan_once()
                    ERPLedgerInboxService._last_error = None
                    ERPLedgerInboxService._consecutive_failures = 0
                except Exception as exc:  # noqa: BLE001 — never let the poller thread die
                    # Still swallowed so the thread survives, but no longer
                    # invisible: a poller that has been dead for weeks used to
                    # look exactly like one with nothing to do.
                    ERPLedgerInboxService._last_error = f"{type(exc).__name__}: {exc}"
                    ERPLedgerInboxService._consecutive_failures += 1
                    logger.exception(
                        "ERP ledger inbox scan failed (%s consecutive)",
                        ERPLedgerInboxService._consecutive_failures,
                    )

        threading.Thread(target=loop, name="erp-ledger-poller", daemon=True).start()
