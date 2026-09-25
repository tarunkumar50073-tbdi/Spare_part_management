# Database migrations (Alembic / Flask-Migrate)

Versioned schema migrations are wired up via **Flask-Migrate** (`app/extensions.py`
`migrate`, registered in `create_app`). The `flask db ...` CLI is available.

> **The runtime boot is unchanged.** `create_app` still does `db.create_all()` +
> the idempotent `_patch_schema()` on start-up, so the live SQLite deployment
> keeps booting exactly as before. Alembic is the **go-forward** mechanism for
> schema changes and the **safe path for a Postgres cut-over** — it is only
> exercised when you run the CLI. Nothing here runs automatically.

## One-off: adopt Alembic on the existing (live) database

The live DB already has every table/column (from `create_all` + `_patch_schema`),
so tell Alembic it is already at the baseline instead of re-applying it:

```bash
cd backend
FLASK_APP=run.py flask db stamp head
```

Now `alembic_version` is set and the DB is migration-tracked.

## Going forward: add a schema change

1. Edit the model(s).
2. Autogenerate a migration and **review it** (autogenerate is not infallible):

   ```bash
   FLASK_APP=run.py flask db migrate -m "add <thing>"
   ```
3. Apply it:

   ```bash
   FLASK_APP=run.py flask db upgrade
   ```

Prefer this over adding another hand-rolled `ALTER` to
`app/__init__.py::_patch_schema` (that helper is SQLite-only and returns early on
Postgres — kept only so existing SQLite DBs still self-heal until fully migrated).

## Postgres cut-over

Fresh, empty Postgres — the baseline builds the whole schema (verified: 48 tables):

```bash
cd backend
FLASK_APP=run.py DATABASE_URL="postgresql+psycopg2://USER:PASS@HOST:5432/DBNAME" flask db upgrade
```

Then copy the data across and switch the app's `DATABASE_URL`. Take a backup first.

## `SKIP_DB_INIT`

Set `SKIP_DB_INIT=1` when running a CLI command that must NOT auto-create the
schema — e.g. to autogenerate a baseline by diffing the models against an **empty**
database. It only affects the CLI-loaded app; normal boot leaves it unset.

```bash
FLASK_APP=run.py SKIP_DB_INIT=1 DATABASE_URL=sqlite:///throwaway.db flask db migrate -m "baseline"
```
