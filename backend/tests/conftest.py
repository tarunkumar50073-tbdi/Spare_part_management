"""Pytest fixtures for the DX_Store backend.

Binds the app to an isolated, file-based throwaway SQLite database (never the
live C:/dx_store_data one) and provides a factory that drives an SRV to the
TRANSFERRED stage so the stock-moving transitions can be exercised.
"""
import os
import tempfile

import pytest

# Must be set BEFORE `config`/`app` are imported so the app binds to a scratch
# DB. File-based (not :memory:) so the concurrency test's worker threads all
# see the same database.
_TMPDIR = tempfile.mkdtemp(prefix="dxstore_test_")
_DB_PATH = os.path.join(_TMPDIR, "test.db").replace("\\", "/")
os.environ["DATABASE_URL"] = "sqlite:///" + _DB_PATH
os.environ["ERP_LEDGER_POLL_SECONDS"] = "0"
os.environ.setdefault("FLASK_ENV", "development")
# Deterministic shared key so the authz tests can exercise the machine caller
# without depending on whatever .env holds.
os.environ.setdefault("API_KEY", "test-machine-key")

from config import Config  # noqa: E402

# Let a pooled SQLite connection be handed to the worker threads the
# concurrency test spawns; each still gets its own connection to contend on
# SQLite's write lock (busy_timeout is set by the app's pragma hook).
Config.SQLALCHEMY_ENGINE_OPTIONS = {"connect_args": {"check_same_thread": False, "timeout": 15}}


@pytest.fixture(scope="session")
def app():
    from app import create_app
    app = create_app("development")
    # Tests create parts/stock directly and read back within the same second, so
    # the short-lived stock-list cache would hand one test the previous test's
    # rows. Off in tests; the cache is a runtime-only optimisation.
    app.config["SPARE_STOCK_CACHE_TTL"] = 0
    # Tests log in many times a second from one client; the login rate limiter
    # would trip and fail unrelated cases. The dedicated limiter test re-enables
    # it locally.
    app.config["RATE_LIMIT_ENABLED"] = False
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
