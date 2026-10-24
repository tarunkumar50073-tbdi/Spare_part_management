"""Application factory: wires extensions, blueprints, and error handling
together (MVC + Repository pattern)."""
import gzip
import os
from datetime import timedelta

from flask import Flask, current_app, request
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
# out whether it has a session, and /auth/captcha draws the sign-in page's
# Security Check code before anyone is signed in.
_AUTH_EXEMPT_PATHS = {
    "/api/v1/health",
    "/api/v1/auth/login",
    "/api/v1/auth/logout",
    "/api/v1/auth/me",
    "/api/v1/auth/captcha",
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


# Below this many bytes gzip's own overhead isn't worth it (and tiny JSON acks
# don't matter). Big list payloads — Inventory Control, the stock list, the
# dashboards — are far above it.
_GZIP_MIN_BYTES = 1024


def _register_gzip(app):
    """gzip JSON / text responses. The plant runs Flask behind waitress with no
    nginx, so nothing compresses for us and large JSON (the Inventory Control
    overview was ~1.8 MB — mostly repeated keys and strings) crossed the LAN
    uncompressed. gzip shrinks that kind of body ~85-90%; browsers and axios
    decompress transparently, so no client changes. Streamed responses (SSE,
    file sends) and non-text bodies are left untouched."""

    @app.after_request
    def _compress(response):
        if "gzip" not in request.headers.get("Accept-Encoding", "").lower():
            return response
        ctype = (response.content_type or "").split(";")[0].strip()
        if (response.direct_passthrough
                or not (200 <= response.status_code < 300)
                or "Content-Encoding" in response.headers
                or ctype == "text/event-stream"
                or not (ctype == "application/json" or ctype.startswith("text/"))):
            return response
        data = response.get_data()
        if len(data) < _GZIP_MIN_BYTES:
            return response
        response.set_data(gzip.compress(data, 6))
        response.headers["Content-Encoding"] = "gzip"
        response.headers["Content-Length"] = str(len(response.get_data()))
        vary = response.headers.get("Vary")
        if not vary:
            response.headers["Vary"] = "Accept-Encoding"
        elif "accept-encoding" not in vary.lower():
            response.headers["Vary"] = f"{vary}, Accept-Encoding"
        return response


def _register_security_headers(app):
    """Baseline hardening headers on every response: block cross-origin framing
    (clickjacking of Scan Part / the Work Queue), stop MIME sniffing, and drop
    the referrer. These are framing/sniffing controls only, so they do not change
    how the SPA loads its own scripts/styles. A full script/style CSP is a
    separate, test-gated step and is intentionally NOT set here."""

    @app.after_request
    def _security_headers(response):
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("Content-Security-Policy", "frame-ancestors 'self'")
        return response


_SESSION_HOURS_DEFAULT = 12.0


def _session_hours():
    """How long one sign-in lasts, in hours: SESSION_LIFETIME_HOURS from the
    environment, 12 by default. Anything that is not a positive number of hours
    (up to 31 days) falls back to 12 instead of stopping the server."""
    raw = os.getenv("SESSION_LIFETIME_HOURS", "").strip()
    try:
        hours = float(raw) if raw else _SESSION_HOURS_DEFAULT
    except ValueError:
        return _SESSION_HOURS_DEFAULT
    return hours if 0 < hours <= 24 * 31 else _SESSION_HOURS_DEFAULT


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
    # ASSIGNED, not setdefault: Flask's own defaults already fill these keys
    # (SameSite None, a 31-day life), so setdefault never applied them — a
    # sign-in cookie lived 31 days and carried no SameSite (the store's "chhote
    # security fix", 16 Oct 2026). SESSION_LIFETIME_HOURS overrides the 12 h.
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
    app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(hours=_session_hours())
    # One sign-in lasts 12 h from the moment of signing in, however busy the
    # screen. Flask's default re-issues the cookie on every request, which
    # slides the 12 h forward for as long as a screen keeps polling — it would
    # never run out. With this off the cookie is written once at login (and
    # cleared at logout): its expiry stays login + 12 h, and Flask refuses its
    # signature after 12 h on the server too, so a copied cookie dies with it.
    # The 30-minute idle sign-out on the screens (AuthContext) is unchanged.
    app.config["SESSION_REFRESH_EACH_REQUEST"] = False
    # MAIL_ENGINE_FORCE_OFF=1 keeps the mail engine switched off whatever the
    # database says. For a server started on a COPY of the plant's data (the
    # TEST instance): the copy brings the real recipients, the switched-on rules
    # and the queued mails with it, and must never mail any of them.
    app.config.setdefault("MAIL_ENGINE_FORCE_OFF",
                          os.getenv("MAIL_ENGINE_FORCE_OFF", "").strip().lower() in ("1", "true", "yes", "on"))

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

    # Compress large JSON/text responses (no proxy does it for us).
    _register_gzip(app)
    _register_security_headers(app)

    # Ensure all models are imported so db.create_all() can discover them.
    from app import models  # noqa: F401

    # SKIP_DB_INIT lets the migration CLI load the app WITHOUT auto-creating the
    # schema, so `flask db migrate` can diff the models against an empty database.
    # Unset in normal operation, so the runtime boot is exactly as it was.
    if not os.getenv("SKIP_DB_INIT"):
        with app.app_context():
            db.create_all()
            _patch_schema()
            _split_rights()
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
    _start_email_engine(app)
    _start_backup_worker(app)

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


def _start_email_engine(app):
    """Start the mail engine's worker thread ("email-engine": the queue, its
    retries, the scheduled rules and the reminders) — like the pollers above,
    only in the process that serves requests, never in the Werkzeug reloader
    parent. It replaces the two once-a-day mail threads (window-time, reorder):
    their schedule is now a rule the worker checks on every tick, so a server
    that was down at the hour catches up instead of losing the day's mail.

    Unlike those threads it is not gated on SMTP being set up at boot. And
    serve.py (waitress) has no reloader at all, so it says so with
    DX_NO_RELOADER=1: without that, a .env that still carries
    FLASK_ENV=development would make this guard treat the one real process as
    the reloader parent and no mail would ever leave the queue. On start the
    worker puts mails a crash left in SENDING back in the queue."""
    import os
    if (app.debug and os.environ.get("WERKZEUG_RUN_MAIN") != "true"
            and os.environ.get("DX_NO_RELOADER") != "1"):
        return  # reloader parent; the worker child will start it
    from app.services.email_engine import EmailEngine
    EmailEngine.start_worker(app)


def _start_backup_worker(app):
    """Start the daily database backup worker ("db-backup", the store's "Roz ka
    automatic backup" of 16 Oct 2026; see backup_service) — like the mail
    engine, only in the process that serves requests: never in the Werkzeug
    reloader parent, and under serve.py (DX_NO_RELOADER=1) even when .env still
    says development. A failure to start is logged, never fatal: the app must
    come up whatever happens to its backup."""
    import os
    if (app.debug and os.environ.get("WERKZEUG_RUN_MAIN") != "true"
            and os.environ.get("DX_NO_RELOADER") != "1"):
        return  # reloader parent; the worker child will start it
    try:
        from app.services.backup_service import BackupService
        BackupService.start_worker(app)
    except Exception:  # noqa: BLE001
        app.logger.exception("database backup worker could not start; the app runs on without it")


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

    # Free-text specification (part-master Specification column) — searchable.
    if "specification" not in part_cols:
        db.session.execute(text("ALTER TABLE parts ADD COLUMN specification VARCHAR(255)"))
        db.session.commit()

    # The part's model no. and its one photo (file name in the part-images
    # folder) — Part Master, 21 Oct 2026.
    for col, kind in (("model_no", "VARCHAR(60)"), ("image_file", "VARCHAR(80)")):
        if col not in part_cols:
            db.session.execute(text(f"ALTER TABLE parts ADD COLUMN {col} {kind}"))
            db.session.commit()

    # Discontinued / not required any more (22 Oct 2026): kept with its stock,
    # out of every to-order and missing-level figure.
    if "discontinued" not in part_cols:
        db.session.execute(text("ALTER TABLE parts ADD COLUMN discontinued BOOLEAN NOT NULL DEFAULT 0"))
        db.session.commit()

    # Reorder-mail recipient role: To / Cc / Bcc (older rows default to To).
    dr_cols = [row[1] for row in db.session.execute(text("PRAGMA table_info(department_recipients)")).fetchall()]
    if dr_cols and "role" not in dr_cols:
        db.session.execute(text("ALTER TABLE department_recipients ADD COLUMN role VARCHAR(3) NOT NULL DEFAULT 'TO'"))
        db.session.commit()

    # Section umbrella: sibling sections (Press Tool Room / General Tool Room)
    # grouped under one name for a single sidebar page and one reorder mail.
    sec_cols = [row[1] for row in db.session.execute(text("PRAGMA table_info(sections)")).fetchall()]
    if sec_cols and "group_name" not in sec_cols:
        db.session.execute(text("ALTER TABLE sections ADD COLUMN group_name VARCHAR(60)"))
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
        # QR traceability: the die an issued part went into (spec 11/12).
        "die_no": "VARCHAR(60)",
        # The person the part was issued to, from the Employee master.
        "employee_id": "INTEGER REFERENCES employees(id)",
        "issued_to_mobile": "VARCHAR(10)", "issued_to_code": "VARCHAR(30)",
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

    # A ledger first created before RETURN joined TXN_TYPES still carries the
    # four-value CHECK, which SQLite can't ALTER — every RETURN insert (the
    # return slip, the GOOD return inspection) fails there with an
    # IntegrityError. Rebuild it once with the model's DDL, keeping every row.
    if ledger_cols:
        db.session.commit()  # no open session transaction while the table is swapped
        try:
            if _rebuild_spare_ledger_if_check_stale(db.engine):
                current_app.logger.warning("spare_stock_ledger rebuilt: txn_type CHECK now allows RETURN")
        except Exception:
            # Rolled back inside — the old table is untouched. Boot on; returns
            # keep failing until the cause in the log is fixed.
            current_app.logger.exception("spare_stock_ledger CHECK rebuild failed; old table kept")

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

    # Hot-path composites found by the query audit (the models declare the same
    # names, so a fresh DB gets them from create_all and this is a no-op there):
    #  - every stock list filters parts on (store_code, is_active), sorted by part_no;
    #  - a part's ledger / last-issue lookups filter part_id and order by date;
    #  - the audit trail pages newest-first on created_at;
    #  - a part's gate history matches upper(item_code), which the plain
    #    item_code index cannot serve.
    for ddl in (
        "CREATE INDEX IF NOT EXISTS ix_parts_store_active_no ON parts (store_code, is_active, part_no)",
        "CREATE INDEX IF NOT EXISTS ix_spare_stock_ledger_part_created ON spare_stock_ledger (part_id, created_at)",
        "CREATE INDEX IF NOT EXISTS ix_audit_logs_created_at ON audit_logs (created_at)",
        "CREATE INDEX IF NOT EXISTS ix_gate_entries_item_code_upper ON gate_entries (upper(item_code))",
    ):
        db.session.execute(text(ddl))
    db.session.commit()

    # The journal carries the same issued-to person fields as the ledger (a
    # table created earlier by create_all never gets new columns on its own).
    txn_cols = [row[1] for row in db.session.execute(text("PRAGMA table_info(spare_transactions)")).fetchall()]
    for _col, _type in (("employee_id", "INTEGER REFERENCES employees(id)"),
                        ("issued_to_mobile", "VARCHAR(10)"), ("issued_to_code", "VARCHAR(30)")):
        if txn_cols and _col not in txn_cols:
            db.session.execute(text(f"ALTER TABLE spare_transactions ADD COLUMN {_col} {_type}"))
            db.session.commit()
    # The models index employee_id on both tables; an ALTER-added column needs
    # its index created here (IF NOT EXISTS: a no-op on every later boot).
    for ddl in ("CREATE INDEX IF NOT EXISTS ix_spare_stock_ledger_employee_id ON spare_stock_ledger (employee_id)",
                "CREATE INDEX IF NOT EXISTS ix_spare_transactions_employee_id ON spare_transactions (employee_id)"):
        db.session.execute(text(ddl))
    db.session.commit()

    # Label print audit (spec 8): print source, printer, symbology and the
    # location that was printed, plus the gate entry no. a label was printed
    # for (reference). Nullable/additive — older rows keep NULLs.
    lpa_cols = [row[1] for row in db.session.execute(text("PRAGMA table_info(label_print_audit)")).fetchall()]
    for _col, _type in (("source", "VARCHAR(20)"), ("printer_name", "VARCHAR(80)"),
                        ("symbology", "VARCHAR(10)"), ("location_printed", "VARCHAR(40)"),
                        ("reference", "VARCHAR(60)")):
        if lpa_cols and _col not in lpa_cols:
            db.session.execute(text(f"ALTER TABLE label_print_audit ADD COLUMN {_col} {_type}"))
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


def _rebuild_spare_ledger_if_check_stale(engine):
    """Bring spare_stock_ledger's txn_type CHECK up to the model, SQLite only.

    The 12-step SQLite table change: with foreign keys off, create the table
    from the model's own DDL under a temporary name, copy every row, drop the
    old table, rename the new one into place, recreate the model's indexes,
    check foreign keys, commit — all in ONE transaction, so a failure leaves
    the old table untouched. Other tables reference spare_stock_ledger by name,
    so their foreign keys point at the rebuilt table afterwards. Returns True
    when it rebuilt, False when the CHECK was already current (the normal case,
    and every DB built by create_all)."""
    from sqlalchemy.schema import CreateIndex, CreateTable
    from app.models.spare_stock import TXN_TYPES, SpareStockLedger

    if engine.dialect.name != "sqlite":
        return False
    table = SpareStockLedger.__table__
    raw = engine.raw_connection()
    try:
        con = raw.driver_connection
        old_iso = con.isolation_level
        con.isolation_level = None  # explicit BEGIN / COMMIT below
        cur = con.cursor()
        row = cur.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='spare_stock_ledger'").fetchone()
        if not row or all(f"'{t}'" in (row[0] or "") for t in TXN_TYPES):
            con.isolation_level = old_iso
            return False
        have = {r[1] for r in cur.execute("PRAGMA table_info(spare_stock_ledger)").fetchall()}
        cols = ", ".join(c.name for c in table.columns if c.name in have)
        ddl = str(CreateTable(table).compile(engine)).strip()
        ddl = ddl.replace("CREATE TABLE spare_stock_ledger", "CREATE TABLE spare_stock_ledger__rebuild", 1)
        cur.execute("PRAGMA foreign_keys=OFF")
        try:
            cur.execute("BEGIN IMMEDIATE")
            before = cur.execute("SELECT COUNT(*) FROM spare_stock_ledger").fetchone()[0]
            cur.execute(ddl)
            cur.execute(f"INSERT INTO spare_stock_ledger__rebuild ({cols}) SELECT {cols} FROM spare_stock_ledger")
            after = cur.execute("SELECT COUNT(*) FROM spare_stock_ledger__rebuild").fetchone()[0]
            if after != before:
                raise RuntimeError(f"ledger rebuild copied {after} of {before} rows")
            cur.execute("DROP TABLE spare_stock_ledger")
            cur.execute("ALTER TABLE spare_stock_ledger__rebuild RENAME TO spare_stock_ledger")
            for idx in table.indexes:
                cur.execute(str(CreateIndex(idx).compile(engine)).replace("CREATE INDEX", "CREATE INDEX IF NOT EXISTS", 1)
                            .replace("CREATE UNIQUE INDEX", "CREATE UNIQUE INDEX IF NOT EXISTS", 1))
            bad = cur.execute("PRAGMA foreign_key_check(spare_stock_ledger)").fetchall()
            if bad:
                raise RuntimeError(f"ledger rebuild left {len(bad)} foreign-key violation(s)")
            cur.execute("COMMIT")
        except Exception:
            cur.execute("ROLLBACK")
            raise
        finally:
            cur.execute("PRAGMA foreign_keys=ON")
            con.isolation_level = old_iso
        return True
    finally:
        raw.close()


def _split_rights():
    """Hand every login saved before 23 Oct 2026 the rights of the screens that
    got their own Rights Matrix column that day (models.user.SPLIT_RIGHTS): each
    new right copies the view / edit of the right its screen used to open on, and
    Notification Center — which had no right — becomes viewable by every login
    of the Spare Parts Store. Once per database (an app setting marks it), so a
    right an administrator later takes away is never handed back."""
    from app.models.app_setting import AppSetting
    from app.models.user import SPLIT_RIGHTS, User

    mark = "rights_split_2026_10_23"
    if AppSetting.get_value(mark):
        return
    for user in User.query.all():
        if user.is_admin:
            continue
        perms = user.get_permissions()
        spare_login = any(a.store_code == "MAINTENANCE" for a in user.store_access)
        for new, old in SPLIT_RIGHTS.items():
            if new in perms:
                continue
            if old is None:
                if spare_login:
                    perms[new] = {"view": True, "edit": False}
            elif old in perms:
                perms[new] = dict(perms[old])
        user.set_permissions(perms)
    AppSetting.set_value(mark, True)   # commits the users too


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
