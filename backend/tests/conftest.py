"""Pytest fixtures for the DX_Store backend.

Binds the app to an isolated, file-based throwaway SQLite database (never the
live C:/dx_store_data one) and provides a factory that drives an SRV to the
TRANSFERRED stage so the stock-moving transitions can be exercised.
"""
import os
import tempfile
from urllib.parse import unquote

import pytest

# Must be set BEFORE `config`/`app` are imported so the app binds to a scratch
# DB. File-based (not :memory:) so the concurrency test's worker threads all
# see the same database.
_TMPDIR = tempfile.mkdtemp(prefix="dxstore_test_")
_DB_PATH = os.path.join(_TMPDIR, "test.db").replace("\\", "/")
os.environ["DATABASE_URL"] = "sqlite:///" + _DB_PATH
os.environ["ERP_LEDGER_POLL_SECONDS"] = "0"
# The real .env now names the plant's mail server. Blank it for the test run
# (load_dotenv never overrides a variable that is already set), so a test that
# forgets to fake the mailer finds mail "not configured" instead of sending.
for _key in ("SMTP_HOST", "SMTP_FROM", "SMTP_USER", "SMTP_PASSWORD"):
    os.environ[_key] = ""
# Since 25 Oct 2026 the laptop's .env forces the mail engine off (the server
# runs it for the shared database). The tests switch it on and off themselves.
os.environ["MAIL_ENGINE_FORCE_OFF"] = ""
os.environ.setdefault("FLASK_ENV", "development")
# Deterministic shared key so the authz tests can exercise the machine caller
# without depending on whatever .env holds.
os.environ.setdefault("API_KEY", "test-machine-key")
# A strong key of the run's own, so create_app never writes a key file of its
# own into the instance folder (it would, for a missing / weak key).
os.environ.setdefault("SECRET_KEY", "pytest-only-session-key-0123456789-abcdefghij")

from config import Config  # noqa: E402

# If anything imported `config` before this file ran (a pytest -p plugin, a
# helper loaded at collection), Config already read DATABASE_URL from .env —
# the LIVE database — and setting the environment above came too late. That is
# how a test run wrote 42 test stores into the live data on 17 Oct 2026. Bind
# the class to the scratch DB here as well, and refuse to run at all if the app
# could still reach the live database.
Config.SQLALCHEMY_DATABASE_URI = os.environ["DATABASE_URL"]
_LIVE_MARKERS = ("dx_store_data", "dx_store.db")


def _assert_scratch_db(uri):
    """Stop the whole run if the database is not this run's scratch file."""
    # An engine URL prints the drive colon encoded ("C%3A"); compare it decoded.
    text = unquote(str(uri)).replace("\\", "/").lower()
    if _DB_PATH.lower() not in text or any(m in text for m in _LIVE_MARKERS[:1]):
        pytest.exit(f"REFUSING TO RUN: tests are bound to {uri!r}, not the scratch DB {_DB_PATH!r}. "
                    "Never let a test touch the live database.", returncode=3)

# Let a pooled SQLite connection be handed to the worker threads the
# concurrency test spawns; each still gets its own connection to contend on
# SQLite's write lock (busy_timeout is set by the app's pragma hook).
Config.SQLALCHEMY_ENGINE_OPTIONS = {"connect_args": {"check_same_thread": False, "timeout": 15}}


@pytest.fixture(scope="session")
def app():
    from app import create_app
    # Before create_app: it runs create_all and the seeds on whatever it binds to.
    _assert_scratch_db(Config.SQLALCHEMY_DATABASE_URI)
    app = create_app("development")
    _assert_scratch_db(app.config["SQLALCHEMY_DATABASE_URI"])
    from app.extensions import db
    with app.app_context():
        _assert_scratch_db(db.engine.url)
    # Tests create parts/stock directly and read back within the same second, so
    # the short-lived stock-list cache would hand one test the previous test's
    # rows. Off in tests; the cache is a runtime-only optimisation.
    app.config["SPARE_STOCK_CACHE_TTL"] = 0
    app.config["SPARE_MGMT_CACHE_TTL"] = 0
    # Tests log in many times a second from one client; the login rate limiter
    # would trip and fail unrelated cases. The dedicated limiter test re-enables
    # it locally.
    app.config["RATE_LIMIT_ENABLED"] = False
    # Likewise the sign-in Security Check and account block: tests sign in
    # without a code and with wrong passwords on purpose. test_login_security
    # switches them back on.
    app.config["LOGIN_CAPTCHA_ENABLED"] = False
    app.config["LOGIN_LOCK_ENABLED"] = False
    return app


@pytest.fixture(autouse=True)
def app_context(app):
    with app.app_context():
        yield


_seq = {"n": 0}


@pytest.fixture()
def make_transferred():
    """Create a fresh supplier + part and drive one no-QC (DOL) SRV all the way
    to TRANSFERRED. Returns (srv_id, part_id, qty). Afterwards PART_STORE holds
    `qty` for that part."""
    from datetime import datetime, timezone
    from app.extensions import db
    from app.models.supplier import Supplier
    from app.models.part import Part
    from app.services.srv_service import SRVService

    def _make(qty=100):
        _seq["n"] += 1
        n = _seq["n"]
        vendor = f"VENT{n:03d}"
        part_no = f"PT-{n:04d}"
        db.session.add(Supplier(vendor_code=vendor, supplier_name=f"Test Supplier {n}", status="Active"))
        db.session.add(Part(part_no=part_no, part_name=f"Test Part {n}", uom="PCS", part_type="OTHER"))
        db.session.commit()

        svc = SRVService()
        srvs = svc.ingest_gate_entry({
            "vendor_code": vendor,
            "invoice_no": f"INV-{n}",
            "gate_entry_time": datetime.now(timezone.utc),
            "lines": [{"part_no": part_no, "qty_invoiced": qty, "qc_required": False}],
        })
        svc.unload(srvs[0].id)
        svc.verify(srvs[0].id, qty)
        srv = svc.create_srv(srvs[0].id, f"SRV-T{n}")  # DOL -> auto-routes to TRANSFERRED
        part = Part.query.filter_by(part_no=part_no).first()
        return srv.id, part.id, qty

    return _make


@pytest.fixture()
def waiting_return():
    """A return recorded before the store's rule of 14 Oct 2026 (no inspection)
    and still waiting for the store inspection — exactly what return_to_store
    wrote then: the return document with all of it pending, its
    RETURN_TO_STORE journal row and the issue's new status; no stock moved.
    return_to_store now takes every new return straight back into stock, so
    this is the only way to a return the inspection (hold / damaged / RGP)
    can still act on. Call (issue_id, qty=None -> everything still out,
    reason, user); returns the SpareReturn."""
    from app.extensions import db
    from app.models.spare_flow import SpareReturn
    from app.models.spare_stock import SpareStockLedger
    from app.services.spare_journal_service import SpareJournalService
    from app.services.spare_stock_service import SpareStockService

    def _make(issue_id, qty=None, reason="Fitment Issue", user=None):
        issue = db.session.get(SpareStockLedger, issue_id)
        out = round(abs(float(issue.qty_delta)) - SpareStockService._returned_qty(issue_id), 2)
        qty = out if qty is None else qty
        journal = SpareJournalService()
        ret = SpareReturn(
            return_no=journal.next_return_no(), part_id=issue.part_id,
            store_code=issue.part.store_code, issue_id=issue.id, status="INSPECTION_PENDING",
            qty=qty, qty_pending=qty, qty_hold=0, qty_damaged=0, qty_good=0, qty_scrap=0,
            qty_rgp=0, reason=reason, received_by=user, department=issue.department,
            issued_to=issue.issued_to, line_name=issue.line_name, line_no=issue.line_no,
            machine=issue.machine, die_no=issue.die_no,
        )
        db.session.add(ret)
        db.session.flush()
        prev_status = issue.status
        issue.status = "RETURNED" if qty >= out else "PARTIALLY_RETURNED"
        journal.record(
            issue.part_id, "RETURN_TO_STORE", qty, store_code=ret.store_code, user=user,
            prev_status=prev_status, new_status=issue.status,
            from_bucket="ISSUED", to_bucket="RETURN_PENDING", return_id=ret.id,
            issue_id=issue.id, department=issue.department, issued_to=issue.issued_to,
            line_name=issue.line_name, line_no=issue.line_no, machine=issue.machine,
            die_no=issue.die_no, return_reason=reason,
        )
        db.session.commit()
        return ret

    return _make
