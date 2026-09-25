"""Application factory: wires extensions, blueprints, and error handling
together (MVC + Repository pattern)."""
import os
from datetime import timedelta

from flask import Flask, request
from sqlalchemy import event
from sqlalchemy.engine import Engine
from config import config_by_name
from app.extensions import db, cors, migrate
from app.middleware.error_handler import register_error_handlers
from app.routes import register_routes
from app.utils.response import error_response

# Paths reachable without being signed in: the health probe (for monitoring),
# and the auth endpoints themselves — you cannot require a session to create
# one. /auth/me is here too because the SPA asks it on boot precisely to find
# out whether it has a session.
_AUTH_EXEMPT_PATHS = {
    "/api/v1/health",
    "/api/v1/auth/login",
    "/api/v1/auth/logout",
    "/api/v1/auth/me",
}


def _register_auth_guard(app):
    """Every /api request must carry either a signed-in session or the shared
    X-API-Key.

    Two credentials because there are two kinds of caller: a person in the
    browser, who signs in and gets a session cookie, and a machine — the ERP
    push — which has no login and uses the key. Requiring both would lock the
    ERP out; accepting only the key is what made the gate decorative, since
    the key ships inside the frontend bundle for anyone to read.
    """
    import hmac
    from flask import g, session
    from app.services.auth_service import AuthService

    api_key = app.config.get("API_KEY")

    @app.before_request
    def _require_auth():
        if request.method == "OPTIONS":
            return None
        if not request.path.startswith("/api/"):
            return None
        # Reset per-request identity; the route-level guards in app/utils/authz
        # read the caller off g (audit finding AUTHZ-1).
        g.current_user = None
        g.is_machine = False
        if request.path in _AUTH_EXEMPT_PATHS:
            return None
        # A signed-in browser session.
        user = AuthService().get_user(session.get("user_id"))
        if user:
            g.current_user = user
            return None
        # Or a machine caller with the shared key. Constant-time compare so the
        # key can't be recovered by timing the response (audit finding SEC-L1).
        supplied = request.headers.get("X-API-Key")
        if api_key and supplied and hmac.compare_digest(supplied, api_key):
            g.is_machine = True
            return None
        return error_response("Sign in required", 401)


@event.listens_for(Engine, "connect")
def _set_sqlite_pragmas(dbapi_connection, connection_record):
    """WAL mode lets concurrent reads proceed without blocking each other —
    the dashboard fires 15+ requests in parallel on load, and the default
    rollback-journal mode serializes them against Flask's threaded dev
    server far more than WAL does. No-op on non-SQLite engines."""
    if dbapi_connection.__class__.__module__.startswith("sqlite3"):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        # Wait up to 5s for a competing writer instead of failing the request
        # with "database is locked" the instant two writes collide — some
        # dashboard GET paths commit, so brief writer overlap happens under
        # load (audit finding CONC-1).
        cursor.execute("PRAGMA busy_timeout=5000")
        # Enforce foreign keys (off by default in SQLite) so a delete of a
        # still-referenced master row fails loudly instead of silently
        # orphaning its dependents (audit finding H-2). Must be set per
        # connection — it is not persistent.
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


def create_app(env_name=None):
    env_name = env_name or os.getenv("FLASK_ENV", "development")
    app = Flask(__name__)
    app.config.from_object(config_by_name[env_name])

    # Fail fast rather than boot a production server on the known dev secret
    # or without an API key (audit findings M-4 / C-1).
    if env_name == "production":
        if not app.config.get("SECRET_KEY") or app.config["SECRET_KEY"] == "dev-secret":
            raise RuntimeError("SECRET_KEY must be set to a strong value in production")
        if not app.config.get("API_KEY"):
            raise RuntimeError("API_KEY must be set in production")

    # Session cookie settings. SameSite=Lax stops another site driving the
    # API with the operator's cookie; HttpOnly keeps it out of reach of any
    # script on the page. Not marked Secure: the plant deployment is plain
    # HTTP on the LAN, and a Secure cookie would simply never be sent.
    app.config.setdefault("SESSION_COOKIE_HTTPONLY", True)
    app.config.setdefault("SESSION_COOKIE_SAMESITE", "Lax")
    app.config.setdefault("PERMANENT_SESSION_LIFETIME", timedelta(hours=12))

    db.init_app(app)
    cors.init_app(app, resources={r"/api/*": {"origins": app.config["CORS_ORIGINS"]}}, supports_credentials=True)
    # Registers the `flask db ...` CLI (Alembic). No effect on the runtime boot
    # below — migrations run only when the CLI is invoked.
    migrate.init_app(app, db, render_as_batch=True)

    register_error_handlers(app)
    _register_auth_guard(app)
    register_routes(app)

    # Mounted after the API blueprints so its catch-all route can never
    # shadow one of them. No-op until the frontend has been built.
    from app.spa import register_spa
    register_spa(app)

    # Ensure all models are imported so db.create_all() can discover them.
    from app import models  # noqa: F401

    # SKIP_DB_INIT lets the migration CLI load the app WITHOUT auto-creating the
    # schema, so `flask db migrate` can diff the models against an empty database.
    # Unset in normal operation, so the runtime boot is exactly as it was.
    if not os.getenv("SKIP_DB_INIT"):
        with app.app_context():
            db.create_all()
            _patch_schema()
            # Portable (ORM + a plain UPDATE), so it runs on every dialect — not
            # from inside _patch_schema, which returns early on non-SQLite and so
            # would leave a fresh Postgres DB with no stores at all (audit
            # finding PORT-1).
            _seed_stores()
            _seed_departments()
            _seed_department_recipients()
            _seed_report_recipients()

    _start_erp_ledger_poller(app)
    _start_erp_sync_poller(app)
    _start_window_time_mailer(app)

    return app


def _start_erp_ledger_poller(app):
    """Start the ERP-ledger inbox auto-import poller — but only in the process
    that actually serves requests, so the Werkzeug reloader's parent process
    doesn't spawn a second one."""
    import os
    if app.debug and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        return  # reloader parent; the worker child will start it
    from app.services.erp_ledger_inbox_service import ERPLedgerInboxService
    ERPLedgerInboxService().start_poller(app)


def _start_erp_sync_poller(app):
    """Start the read-only ERP DB -> mirror sync poller — like the ledger poller,
    only in the request-serving process (not the Werkzeug reloader parent), and
    only when ERP_SYNC_POLL_SECONDS > 0 and ERP DB credentials are configured."""
    import os
    if app.debug and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        return  # reloader parent; the worker child will start it
    from app.services.erp_sync_service import ERPSyncService
    ERPSyncService().start_poller(app)


def _start_window_time_mailer(app):
    """Start the once-a-day window-time mail thread — only in the request-serving
    process (not the Werkzeug reloader parent), and only when
    WINDOW_TIME_MAIL_ENABLED is true and SMTP is configured."""
    import os
    if app.debug and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        return  # reloader parent; the worker child will start it
    from app.services.window_time_mail_service import WindowTimeMailService
    WindowTimeMailService().start_scheduler(app)


def _patch_schema():
    """Idempotent schema patches for columns added after a DB was first
    created with db.create_all() (which never ALTERs existing tables).
    SQLite-only for now; replace with a real migration tool if one is added."""
    from sqlalchemy import text
    if db.engine.dialect.name != "sqlite":
        return
    cols = [row[1] for row in db.session.execute(text("PRAGMA table_info(stock_ledger)")).fetchall()]
    if "ext_ref" not in cols:
        db.session.execute(text("ALTER TABLE stock_ledger ADD COLUMN ext_ref VARCHAR(80)"))
        db.session.execute(text("CREATE INDEX IF NOT EXISTS ix_stock_ledger_ext_ref ON stock_ledger (ext_ref)"))
        db.session.commit()

    part_cols = [row[1] for row in db.session.execute(text("PRAGMA table_info(parts)")).fetchall()]
    if "store_code" not in part_cols:
        db.session.execute(text("ALTER TABLE parts ADD COLUMN store_code VARCHAR(30) REFERENCES stores(code)"))
        db.session.execute(text("CREATE INDEX IF NOT EXISTS ix_parts_store_code ON parts (store_code)"))
        db.session.commit()
    if "section_id" not in part_cols:
        db.session.execute(text("ALTER TABLE parts ADD COLUMN section_id INTEGER REFERENCES sections(id)"))
        db.session.execute(text("CREATE INDEX IF NOT EXISTS ix_parts_section_id ON parts (section_id)"))
        db.session.commit()

    for col in ("location", "rework_location"):
        if col not in part_cols:
            db.session.execute(text(f"ALTER TABLE parts ADD COLUMN {col} VARCHAR(40)"))
            db.session.commit()

    # BOP bin-stock sheet planning fields (added with the child part-master import).
    for col in ("no_of_row", "no_of_pallet", "store_rack_capacity", "total_store_rack_qty",
                "monthly_peak_schedule_qty", "reck_covg_days"):
        if col not in part_cols:
            db.session.execute(text(f"ALTER TABLE parts ADD COLUMN {col} NUMERIC(14, 2)"))
            db.session.commit()

    # Spare reorder point (part-master REORDER column) — order when stock hits it.
    if "reorder_level" not in part_cols:
        db.session.execute(text("ALTER TABLE parts ADD COLUMN reorder_level NUMERIC(12, 2)"))
        db.session.commit()

    srv_cols = [row[1] for row in db.session.execute(text("PRAGMA table_info(srvs)")).fetchall()]
    if srv_cols and "gate_out_time" not in srv_cols:
        db.session.execute(text("ALTER TABLE srvs ADD COLUMN gate_out_time DATETIME"))
        db.session.commit()

    ledger_cols = [row[1] for row in db.session.execute(text("PRAGMA table_info(spare_stock_ledger)")).fetchall()]
    if ledger_cols and "department" not in ledger_cols:
        db.session.execute(text("ALTER TABLE spare_stock_ledger ADD COLUMN department VARCHAR(40)"))
        db.session.execute(text("CREATE INDEX IF NOT EXISTS ix_spare_stock_ledger_department ON spare_stock_ledger (department)"))
        db.session.commit()
    if ledger_cols and "machine" not in ledger_cols:
        db.session.execute(text("ALTER TABLE spare_stock_ledger ADD COLUMN machine VARCHAR(60)"))
        db.session.execute(text("CREATE INDEX IF NOT EXISTS ix_spare_stock_ledger_machine ON spare_stock_ledger (machine)"))
        db.session.commit()
    if ledger_cols and "returnable" not in ledger_cols:
        db.session.execute(text("ALTER TABLE spare_stock_ledger ADD COLUMN returnable BOOLEAN NOT NULL DEFAULT 0"))
        db.session.commit()
    if ledger_cols and "return_of_id" not in ledger_cols:
        db.session.execute(text("ALTER TABLE spare_stock_ledger ADD COLUMN return_of_id INTEGER"))
        db.session.execute(text("CREATE INDEX IF NOT EXISTS ix_spare_stock_ledger_return_of_id ON spare_stock_ledger (return_of_id)"))
        db.session.commit()
    if ledger_cols and "erp_pushed_at" not in ledger_cols:
        db.session.execute(text("ALTER TABLE spare_stock_ledger ADD COLUMN erp_pushed_at DATETIME"))
        db.session.execute(text("CREATE INDEX IF NOT EXISTS ix_spare_stock_ledger_erp_pushed_at ON spare_stock_ledger (erp_pushed_at)"))
        db.session.commit()

    # Two-stage issue + structured receiving columns (barcode module Phase 2).
    # All nullable/additive; validated in the service, no DB CHECK (so an
    # ALTER-added column matches a fresh create_all one).
    _ledger_adds = {
        "issued_to": "VARCHAR(80)", "status": "VARCHAR(30)",
        "line_name": "VARCHAR(60)", "line_no": "VARCHAR(30)",
        "actual_qty": "NUMERIC(12, 2)", "confirmed_by": "VARCHAR(60)",
        "confirmed_at": "DATETIME", "supplier_id": "INTEGER",
        "invoice_no": "VARCHAR(60)", "invoice_date": "DATE",
        "check_result": "VARCHAR(20)",
        # Store return slip (a department sending an issued part back).
        "return_no": "VARCHAR(40)", "return_reason": "VARCHAR(60)",
        "returned_by": "VARCHAR(80)",
    }
    for _col, _type in _ledger_adds.items():
        if ledger_cols and _col not in ledger_cols:
            db.session.execute(text(f"ALTER TABLE spare_stock_ledger ADD COLUMN {_col} {_type}"))
            db.session.commit()
    if ledger_cols and "status" not in ledger_cols:
        db.session.execute(text("CREATE INDEX IF NOT EXISTS ix_spare_stock_ledger_status ON spare_stock_ledger (status)"))
        db.session.commit()
    if ledger_cols and "return_no" not in ledger_cols:
        db.session.execute(text("CREATE INDEX IF NOT EXISTS ix_spare_stock_ledger_return_no ON spare_stock_ledger (return_no)"))
        db.session.commit()

    # created_at drives every time-window query (today's movements, the
    # consumption trend, the date-range filters) but was never indexed — so each
    # was a full ledger scan that grows with the whole table, not the window.
    # Composite (txn_type, created_at) too, because those queries first filter
    # txn_type == 'ISSUE' and then range on the date. IF NOT EXISTS → a cheap
    # catalog no-op on every later boot.
    if ledger_cols:
        db.session.execute(text("CREATE INDEX IF NOT EXISTS ix_spare_stock_ledger_created_at ON spare_stock_ledger (created_at)"))
        db.session.execute(text("CREATE INDEX IF NOT EXISTS ix_spare_stock_ledger_txn_created ON spare_stock_ledger (txn_type, created_at)"))
        db.session.commit()

    # Admin user-management additions: a readable password copy (so the admin
    # screen can show it) and the per-module rights map. Both nullable/additive.
    user_cols = [row[1] for row in db.session.execute(text("PRAGMA table_info(users)")).fetchall()]
    if user_cols and "password_plain" not in user_cols:
        db.session.execute(text("ALTER TABLE users ADD COLUMN password_plain VARCHAR(255)"))
        db.session.commit()
    if user_cols and "permissions" not in user_cols:
        db.session.execute(text("ALTER TABLE users ADD COLUMN permissions TEXT"))
        db.session.commit()

    # `rgps` was first created with an earlier schema; the RGP model since moved
    # to the ERP Pending-RGP columns (ven_cd, balance_qty, ...). create_all never
    # ALTERs an existing table, so the old shape made every /rgp query 500. It is
    # an empty, ERP-fed mirror, so when the old shape is detected (and the table
    # is empty) drop it and rebuild it to the current model.
    rgp_info = db.session.execute(text("PRAGMA table_info(rgps)")).fetchall()
    rgp_cols = [row[1] for row in rgp_info]
    if rgp_info and "ven_cd" not in rgp_cols and \
            db.session.execute(text("SELECT COUNT(*) FROM rgps")).scalar() == 0:
        db.session.execute(text("DROP TABLE rgps"))
        db.session.commit()
        from app.models.rgp import RGP
        RGP.__table__.create(bind=db.engine, checkfirst=True)


def _seed_stores():
    """Create the starting stores and put every untagged part in the child-part
    one. Idempotent: an existing store is left exactly as the user has since
    edited it, and only parts with no store yet are touched — so this cannot
    undo a part someone has deliberately moved."""
    from sqlalchemy import text
    from app.models.store import DEFAULT_STORE_CODE, SEED_STORES, Store

    existing = {s.code for s in Store.query.all()}
    for seed in SEED_STORES:
        if seed["code"] not in existing:
            db.session.add(Store(**seed))
    db.session.commit()

    db.session.execute(
        text("UPDATE parts SET store_code = :code WHERE store_code IS NULL"),
        {"code": DEFAULT_STORE_CODE},
    )
    db.session.commit()


def _seed_departments():
    """Create the starting departments so the master is never empty. Idempotent:
    an existing department is left exactly as the admin has since edited it —
    only a missing one is inserted, so this never overwrites an e-mail someone
    has set."""
    from app.models.department import SEED_DEPARTMENTS, Department

    existing = {d.name for d in Department.query.all()}
    for seed in SEED_DEPARTMENTS:
        if seed["name"] not in existing:
            db.session.add(Department(**seed))
    db.session.commit()


def _seed_department_recipients():
    """One-time migration: turn each department's legacy single e-mail into a
    person-wise recipient, so an address set before the master went person-wise
    still shows. Runs only while the recipients table is empty; idempotent."""
    from app.models.department import Department
    from app.models.department_recipient import DepartmentRecipient
    if DepartmentRecipient.query.first() is not None:
        return
    for d in Department.query.all():
        email = (d.email or "").strip()
        if email:
            db.session.add(DepartmentRecipient(
                department_id=d.id, name=email.split("@")[0], email=email, is_active=True))
    db.session.commit()


def _seed_report_recipients():
    """Seed the window-time mail recipients so the master is never empty — the
    names off the store's existing daily mail, e-mails left BLANK for an admin to
    fill. Idempotent on (report_key, name, role): never overwrites an address an
    admin has since typed, never double-inserts."""
    from app.models.report_recipient import SEED_REPORT_RECIPIENTS, ReportRecipient

    existing = {(r.report_key, r.name, r.role) for r in ReportRecipient.query.all()}
    for seed in SEED_REPORT_RECIPIENTS:
        if (seed["report_key"], seed["name"], seed["role"]) not in existing:
            db.session.add(ReportRecipient(**seed))
    db.session.commit()
