"""ERP -> app mirror sync (READ-ONLY on the ERP side).

Reads the plant ERP Postgres (schema termsdb) through ERPDBClient and refreshes
the local ERP-report mirror tables via their existing replace_* methods. Only
the local SQLite mirrors are written; ERP is never modified.

termsdb tables read (the store, 27 Oct 2026: "erp api me jo bhi data milta h
wo upto date chahiye turant upload hona chahiye" — every 2 minutes on the
server, ERP_SYNC_POLL_SECONDS=120, and "Read ERP now" on ERP Control):
    termsdb.gate_entry            -> GateEntry          (vehicle-in / material arrival; feeds window-time)
    termsdb.srv_report            -> ReceivingRegister  (GRN receiving history)
    termsdb.current_stock         -> ERPStock           (ERP's stock: clos_stock summed over its locations,
                                                         per part — the ERP side of ERP vs Physical)
    termsdb.line_rejection_report -> ErpLineRejection   (line rejection return slips)
    termsdb.challan_register      -> ErpRgpLine         (RGPs, JobWorkService)
Each table is read on its own: one failing never stops the others, and how
each went — rows, ERP's own newest date, any error — is saved in app_settings
(erp_sync_status), so every machine sees the server's last run. Only one read
runs at a time across machines (a PostgreSQL advisory lock), so the server's
poller and a button press elsewhere can never write the same mirror together.
termsdb.line_rejection_report has no mirror yet. The other four reports (RGP,
Pending GRN, Current Stock, Stock Valuation, Gate Exit) await their own ERP
source tables — when those appear, add a mapper here the same way.

Full-snapshot sync: each run reads the ERP rows (optionally limited to the last
ERP_SYNC_SINCE_DAYS) and hands them to replace_* (delete-by-store + bulk insert),
so re-running is idempotent and never double-counts. Poller mirrors the ERP
ledger inbox one: per-process, guarded, daemon thread, errors surfaced not fatal.
"""
import logging
import os
import socket
import threading
import time
from contextlib import contextmanager
from datetime import date, timedelta

from flask import current_app
from sqlalchemy import text

from app.models.base import utcnow
from app.services.erp_db_client import ERPDBClient, ERPDBNotConfigured
from app.services.gate_service import GateService
from app.services.receiving_register_service import ReceivingRegisterService

logger = logging.getLogger("dxstore.erp_sync")

STORE_CODE = "CHILD_PART"
SYNC_STATUS_KEY = "erp_sync_status"
# Which process saved a run: the saved status is shown by OTHER processes only.
THIS_PROCESS = f"{socket.gethostname()}:{os.getpid()}"
# pg_try_advisory_lock key of the ERP read (any number no other code uses).
SYNC_LOCK_KEY = 72620271
# ERP's own newest record per table: what "up to date" means for each.
ERP_LATEST_SQL = {
    "gate_entry": 'SELECT max(gate_entry_dt)::text FROM "{s}".gate_entry',
    "receiving_register": 'SELECT max(grn_date)::text FROM "{s}".srv_report',
    "erp_stock": 'SELECT max(created_at)::text FROM "{s}".current_stock',
    "line_rejection": 'SELECT max(return_slip_date)::text FROM "{s}".line_rejection_report',
    "rgp_lines": 'SELECT max(updated_at)::text FROM "{s}".challan_register',
}


@contextmanager
def _one_read_at_a_time():
    """True when this run may read ERP: no other machine / thread is reading now."""
    from app.extensions import db
    if db.engine.dialect.name != "postgresql":
        yield True
        return
    conn = db.engine.connect()
    try:
        got = bool(conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": SYNC_LOCK_KEY}).scalar())
        try:
            yield got
        finally:
            if got:
                conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": SYNC_LOCK_KEY})
                conn.commit()
    finally:
        conn.close()


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

    def sync_current_stock(self):
        """ERP's stock per part: clos_stock (accepted, not under inspection)
        summed over ERP's locations, for every active app part ERP lists. A part
        ERP no longer lists loses its figure (reads "Awaiting ERP") rather than
        a guessed 0. Physical stock (spare_stock) is never touched."""
        from app.extensions import db
        from app.models.erp_stock import ERPStock
        from app.models.part import Part
        totals = {}
        for r in self.erp.fetch_rows("current_stock", ["item_cd", "clos_stock"]):
            code, qty = (r.get("item_cd") or "").strip().upper(), _num(r.get("clos_stock"))
            if code and qty is not None:
                totals[code] = round(totals.get(code, 0.0) + qty, 2)
        parts = {(p.part_no or "").strip().upper(): p.id for p in Part.query.filter(Part.is_active.is_(True))}
        now = utcnow()
        have = {e.part_id: e for e in ERPStock.query.all()}
        present = []
        for code, qty in totals.items():
            pid = parts.get(code)
            if pid is None:
                continue
            present.append(pid)
            row = have.pop(pid, None)
            if row is None:
                db.session.add(ERPStock(part_id=pid, qty_on_hand=qty, synced_at=now))
            elif float(row.qty_on_hand or 0) != qty:
                row.qty_on_hand = qty
        for start in range(0, len(present), 500):
            (ERPStock.query.filter(ERPStock.part_id.in_(present[start:start + 500]))
             .update({"synced_at": now}, synchronize_session=False))
        for row in have.values():
            db.session.delete(row)
        db.session.commit()
        return len(present)

    def sync_line_rejection(self):
        """ERP's line rejection slips, the whole table (under a thousand rows), replaced."""
        from app.extensions import db
        from app.models.erp_line_rejection import ErpLineRejection
        from app.services.job_work_service import _day, _txt
        cols = ["id", "return_slip_no", "return_slip_date", "return_slip_time", "ref_doc_no", "item_cd", "item_desc",
                "uom", "return_qty", "return_from_loc", "return_from_name", "party_cd", "party_name", "challan_no",
                "challan_dt"]
        raw = self.erp.fetch_rows("line_rejection_report", cols)
        now = utcnow()
        ErpLineRejection.query.delete()
        for r in raw:
            db.session.add(ErpLineRejection(
                erp_id=r["id"], return_slip_no=_txt(r.get("return_slip_no"), 40), return_slip_date=_day(r.get("return_slip_date")),
                return_slip_time=_txt(r.get("return_slip_time"), 10), ref_doc_no=_txt(r.get("ref_doc_no"), 60),
                item_cd=_txt(r.get("item_cd"), 40), item_desc=_txt(r.get("item_desc"), 255), uom=_txt(r.get("uom"), 20),
                return_qty=_num(r.get("return_qty")), return_from_loc=_txt(r.get("return_from_loc"), 20),
                return_from_name=_txt(r.get("return_from_name"), 80), party_cd=_txt(r.get("party_cd"), 40),
                party_name=_txt(r.get("party_name"), 160), challan_no=_txt(r.get("challan_no"), 60),
                challan_dt=_txt(r.get("challan_dt"), 20), synced_at=now))
        db.session.commit()
        return len(raw)

    def _erp_latest(self):
        """{table: ERP's own newest record} — read only, best effort."""
        out = {}
        try:
            conn = self.erp._connect()
            try:
                cur = conn.cursor()
                schema = current_app.config.get("ERP_DB_SCHEMA", "termsdb")
                for name, sql in ERP_LATEST_SQL.items():
                    try:
                        cur.execute(sql.format(s=schema))
                        out[name] = cur.fetchone()[0]
                    except Exception:  # noqa: BLE001 — one table renamed must not hide the rest
                        out[name] = None
            finally:
                conn.close()
        except Exception:  # noqa: BLE001
            pass
        return out

    def _step(self, tables, name, fn):
        """Run one table's read; its outcome goes in `tables`, never raised."""
        from app.extensions import db
        started = time.monotonic()
        try:
            n = fn()
            tables[name] = {"ok": True, "rows": n, "error": None, "seconds": round(time.monotonic() - started, 1)}
            return n
        except Exception as exc:  # noqa: BLE001 — logged and shown, the next table still runs
            db.session.rollback()
            logger.exception("ERP read of %s failed", name)
            tables[name] = {"ok": False, "rows": None, "error": f"{type(exc).__name__}: {str(exc)[:200]}",
                            "seconds": round(time.monotonic() - started, 1)}
            return None

    def sync_all(self):
        """Refresh every mirror that has an ERP source. One run at a time — in
        this process and across machines (_one_read_at_a_time); a run that
        finds another going returns {"skipped": ...} at once. Raises
        ERPDBNotConfigured when credentials are unset. Returns rows per table."""
        if not self.configured():
            raise ERPDBNotConfigured("ERP DB not configured")
        if not self._lock.acquire(blocking=False):
            return {"skipped": "An ERP read is already running"}
        try:
            with _one_read_at_a_time() as mine:
                if not mine:
                    return {"skipped": "An ERP read is already running on another machine"}
                return self._sync_all()
        finally:
            self._lock.release()

    def _sync_all(self):
        from app.models.app_setting import AppSetting
        tables = {}
        result = {
            "gate_entry": self._step(tables, "gate_entry", self.sync_gate_entry),
            "receiving_register": self._step(tables, "receiving_register", self.sync_receiving_register),
            "erp_stock": self._step(tables, "erp_stock", self.sync_current_stock),
            "line_rejection": self._step(tables, "line_rejection", self.sync_line_rejection),
        }
        errors = [f"{k}: {v['error']}" for k, v in tables.items() if not v["ok"]]
        ERPSyncService._last_sync_at = utcnow().isoformat()
        ERPSyncService._last_result = result
        ERPSyncService._last_error = "; ".join(errors) or None
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
        # ERP's RGP lines, for linking job work returns (27 Oct 2026). Its own
        # failure is kept and shown by JobWorkService; never fails this sync.
        def rgp():
            from app.services.job_work_service import JobWorkService
            st = JobWorkService().sync()
            if not st.get("ok"):
                raise RuntimeError(st.get("last_error") or "ERP RGP read failed")
            return st.get("lines")
        result["rgp_lines"] = self._step(tables, "rgp_lines", rgp)
        latest = self._erp_latest()
        for name, t in tables.items():
            t["erp_latest"] = latest.get(name)
        try:
            AppSetting.set_value(SYNC_STATUS_KEY, {
                "at": ERPSyncService._last_sync_at, "ok": all(t["ok"] for t in tables.values()),
                "process": THIS_PROCESS,
                "tables": tables, "error": ERPSyncService._last_error,
                "poll_seconds": current_app.config.get("ERP_SYNC_POLL_SECONDS", 0)}, "SYSTEM")
        except Exception:  # noqa: BLE001
            logger.exception("Saving the ERP sync status failed")
        return result

    def status(self):
        """This process's last run, or — when it has none (the poller runs on
        the server) — the last run saved by any machine."""
        from app.models.app_setting import AppSetting
        saved = AppSetting.get_value(SYNC_STATUS_KEY, {}) or {}
        mine = ERPSyncService._last_sync_at
        use_saved = (bool(saved.get("at")) and saved.get("process") != THIS_PROCESS
                     and (not mine or saved["at"] > mine))
        return {
            "configured": self.configured(),
            "poll_seconds": (saved.get("poll_seconds") if use_saved and saved.get("poll_seconds") is not None
                             else current_app.config.get("ERP_SYNC_POLL_SECONDS", 0)),
            "since_days": current_app.config.get("ERP_SYNC_SINCE_DAYS", 0),
            "last_sync_at": saved.get("at") if use_saved else mine,
            "last_result": ({k: v.get("rows") for k, v in (saved.get("tables") or {}).items()} if use_saved
                            else ERPSyncService._last_result),
            "last_error": saved.get("error") if use_saved else ERPSyncService._last_error,
            # Each table's last outcome, whoever read it last.
            "tables": saved.get("tables") or {},
            "saved_by_other_machine": use_saved,
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
