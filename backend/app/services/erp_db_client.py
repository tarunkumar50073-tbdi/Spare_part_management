"""Read-only connection to the plant ERP PostgreSQL (schema termsdb).

The app is NEVER allowed to write to ERP: the connection is opened with
`default_transaction_read_only=on` AND `set_session(readonly=True)`, so even a
stray UPDATE/INSERT is refused by the server. Everything is config-driven
(ERP_DB_* from .env); with ERP_DB_HOST/USER/PASSWORD unset the sync stays off
(ERPDBNotConfigured) instead of guessing credentials. The password is read from
config and never logged or returned.

Only this module and erp_sync_service know the ERP schema; table and column
names are our own constants (never user input), so the identifier interpolation
below is not an injection surface — they are still whitelisted by the caller and
double-quoted here.
"""
import psycopg2
import psycopg2.extras
from flask import current_app


class ERPDBNotConfigured(Exception):
    """ERP_DB_HOST/USER/PASSWORD are not all set — the read-only pull cannot run
    until credentials are provided; the mirror tables simply stay as they are."""


class ERPDBClient:
    @staticmethod
    def _cfg():
        return current_app.config

    def configured(self):
        c = self._cfg()
        return bool(c.get("ERP_DB_HOST") and c.get("ERP_DB_USER") and c.get("ERP_DB_PASSWORD"))

    def _connect(self):
        c = self._cfg()
        if not self.configured():
            raise ERPDBNotConfigured("ERP_DB_HOST / ERP_DB_USER / ERP_DB_PASSWORD not set")
        conn = psycopg2.connect(
            host=c["ERP_DB_HOST"], port=c.get("ERP_DB_PORT", 5432), dbname=c.get("ERP_DB_NAME", "toyota_db"),
            user=c["ERP_DB_USER"], password=c["ERP_DB_PASSWORD"],
            connect_timeout=c.get("ERP_DB_CONNECT_TIMEOUT", 8),
            options="-c default_transaction_read_only=on",
        )
        conn.set_session(readonly=True, autocommit=True)
        return conn

    def ping(self):
        """Cheap liveness check — returns {ok, server, db} or raises."""
        conn = self._connect()
        try:
            cur = conn.cursor()
            cur.execute("SELECT current_database(), version()")
            db, ver = cur.fetchone()
            cur.close()
            return {"ok": True, "database": db, "server": ver.split(" on ")[0]}
        finally:
            conn.close()

    def fetch_rows(self, table, columns, since_col=None, since_date=None):
        """SELECT `columns` FROM <schema>.<table>, optionally WHERE
        since_col >= since_date. `table`/`columns` are code constants (see module
        docstring). Returns a list of plain dicts keyed by column name."""
        schema = self._cfg().get("ERP_DB_SCHEMA", "termsdb")
        col_sql = ", ".join('"{}"'.format(c) for c in columns)
        sql = 'SELECT {} FROM "{}"."{}"'.format(col_sql, schema, table)
        params = []
        if since_col and since_date is not None:
            sql += ' WHERE "{}" >= %s'.format(since_col)
            params.append(since_date)
        conn = self._connect()
        try:
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute(sql, params)
            rows = [dict(r) for r in cur.fetchall()]
            cur.close()
            return rows
        finally:
            conn.close()
