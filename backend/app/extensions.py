"""Shared Flask extension instances."""
from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate
from flask_cors import CORS

db = SQLAlchemy()
cors = CORS()
# Enables the `flask db ...` (Alembic) CLI for versioned schema migrations.
# render_as_batch lets SQLite ALTERs work via table-rebuild. Wiring it does NOT
# change the runtime boot — migrations are applied only when you run the CLI.
migrate = Migrate()
