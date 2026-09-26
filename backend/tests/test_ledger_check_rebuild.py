"""The boot-time rebuild of a spare_stock_ledger whose txn_type CHECK predates
RETURN (the live DB's case: SQLite can't ALTER a CHECK, so every RETURN insert
failed there with an IntegrityError while freshly-built test DBs passed).

Runs against its own throwaway SQLite file that imitates the old live table —
four-value CHECK, no die_no column, rows already in it, and another table
pointing at it — never the app's test DB.
"""
import os
import sqlite3
import tempfile

import pytest
from sqlalchemy import create_engine
from sqlalchemy.schema import CreateTable

from app import _rebuild_spare_ledger_if_check_stale
from app.models.spare_stock import SpareStockLedger

OLD_CHECK = "txn_type IN ('OPENING','RECEIPT','ISSUE','ADJUSTMENT')"


@pytest.fixture()
def old_db():
    path = os.path.join(tempfile.mkdtemp(prefix="dx_ledger_rebuild_"), "old.db").replace("\\", "/")
    engine = create_engine(f"sqlite:///{path}")
    new_ddl = str(CreateTable(SpareStockLedger.__table__).compile(engine))
    start = new_ddl.index("txn_type IN (")
    old_ddl = new_ddl[:start] + OLD_CHECK + new_ddl[new_ddl.index(")", start) + 1:]
    old_ddl = "\n".join(line for line in old_ddl.splitlines() if "die_no" not in line)
    assert "'RETURN'" not in old_ddl and "die_no" not in old_ddl

    con = sqlite3.connect(path)
    # Every table the ledger's foreign keys point at (employees: the issue's
    # employee, from the Employee master) — as db.create_all leaves the live DB.
    con.executescript("""
        CREATE TABLE parts (id INTEGER PRIMARY KEY, part_no VARCHAR(30));
        CREATE TABLE suppliers (id INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS employees (id INTEGER PRIMARY KEY);
        INSERT INTO parts (id, part_no) VALUES (1, 'P-1');
    """)
    con.execute(old_ddl)
    con.execute("CREATE INDEX ix_spare_stock_ledger_part_id ON spare_stock_ledger (part_id)")
    for i, (typ, delta, bal) in enumerate((("OPENING", 10, 10), ("ISSUE", -2, 8)), start=1):
        con.execute(
            "INSERT INTO spare_stock_ledger (id, part_id, qty_delta, balance_after, txn_type, returnable, "
            "created_at, updated_at) VALUES (?, 1, ?, ?, ?, 0, '2026-09-01', '2026-09-01')",
            (i, delta, bal, typ))
    # Another table pointing at the ledger, as spare_returns does.
    con.execute("CREATE TABLE doc (id INTEGER PRIMARY KEY, issue_id INTEGER REFERENCES spare_stock_ledger (id))")
    con.execute("INSERT INTO doc (id, issue_id) VALUES (1, 2)")
    con.commit()
    with pytest.raises(sqlite3.IntegrityError):
        con.execute("INSERT INTO spare_stock_ledger (part_id, qty_delta, balance_after, txn_type, returnable, "
                    "created_at, updated_at) VALUES (1, 1, 9, 'RETURN', 0, '2026-09-02', '2026-09-02')")
    con.close()
    yield engine, path
    engine.dispose()


def test_stale_check_is_rebuilt_keeping_rows_and_references(old_db):
    engine, path = old_db
    assert _rebuild_spare_ledger_if_check_stale(engine) is True

    con = sqlite3.connect(path)
    con.execute("PRAGMA foreign_keys=ON")
    ddl = con.execute("SELECT sql FROM sqlite_master WHERE name='spare_stock_ledger'").fetchone()[0]
    assert "'RETURN'" in ddl and "die_no" in ddl
    rows = con.execute("SELECT id, txn_type, qty_delta, balance_after FROM spare_stock_ledger ORDER BY id").fetchall()
    assert rows == [(1, "OPENING", 10, 10), (2, "ISSUE", -2, 8)]
    # RETURN is now accepted, and the ids carry on from the copied rows.
    con.execute("INSERT INTO spare_stock_ledger (part_id, qty_delta, balance_after, txn_type, returnable, "
                "return_of_id, created_at, updated_at) VALUES (1, 1, 9, 'RETURN', 0, 2, '2026-09-02', '2026-09-02')")
    assert con.execute("SELECT MAX(id) FROM spare_stock_ledger").fetchone()[0] == 3
    # The model's indexes are back, and the other table still resolves its FK.
    names = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='spare_stock_ledger'")}
    assert {"ix_spare_stock_ledger_part_created", "ix_spare_stock_ledger_txn_type"} <= names
    assert con.execute("PRAGMA foreign_key_check").fetchall() == []
    assert "__rebuild" not in " ".join(r[0] for r in con.execute("SELECT name FROM sqlite_master"))
    con.close()


def test_current_check_is_left_alone(old_db):
    engine, _ = old_db
    assert _rebuild_spare_ledger_if_check_stale(engine) is True
    assert _rebuild_spare_ledger_if_check_stale(engine) is False
