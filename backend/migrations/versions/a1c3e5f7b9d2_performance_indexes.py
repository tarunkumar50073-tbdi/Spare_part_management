"""performance indexes from the query audit

Composite / expression indexes for the hot read paths: the stock list
(parts by store + active, sorted by part_no), time-window and per-part ledger
reads, the audit trail's newest-first paging, and the case-insensitive gate
history match. Also the two ledger created_at indexes the running app has
created at boot since before the baseline, so a DB built purely from
migrations matches one built by the app. IF NOT EXISTS throughout, so this is
safe on a database that already has them (every live SQLite DB does — the
boot-time schema patch creates the same names).

Revision ID: a1c3e5f7b9d2
Revises: 6bd110a6ba9d
Create Date: 2026-09-25
"""
from alembic import op
import sqlalchemy as sa

revision = "a1c3e5f7b9d2"
down_revision = "6bd110a6ba9d"
branch_labels = None
depends_on = None

_INDEXES = [
    ("ix_spare_stock_ledger_created_at", "spare_stock_ledger", ["created_at"]),
    ("ix_spare_stock_ledger_txn_created", "spare_stock_ledger", ["txn_type", "created_at"]),
    ("ix_spare_stock_ledger_part_created", "spare_stock_ledger", ["part_id", "created_at"]),
    ("ix_parts_store_active_no", "parts", ["store_code", "is_active", "part_no"]),
    ("ix_audit_logs_created_at", "audit_logs", ["created_at"]),
    ("ix_gate_entries_item_code_upper", "gate_entries", [sa.text("upper(item_code)")]),
]


def upgrade():
    for name, table, cols in _INDEXES:
        op.create_index(name, table, cols, unique=False, if_not_exists=True)


def downgrade():
    for name, table, _cols in reversed(_INDEXES):
        op.drop_index(name, table_name=table, if_exists=True)
