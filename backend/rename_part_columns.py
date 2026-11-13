"""Rename the Part Master table and its columns in the database (the store, 13
Nov 2026: "model no vala column hta de and specification ki jagah model no kr de
and part name ki jagah item description kr de" ... "frontend backend and table
tino me" ... "or table ka name bhi part master kr de").

    python rename_part_columns.py            # look only: says what it would do
    python rename_part_columns.py --apply    # back up, then rename

In one transaction:
    1. parts: drop model_no            (the old, separate Model No. field - empty)
    2. parts: specification -> model_no  (the part's model / size code)
    3. parts: part_name -> item_description
    4. table parts -> part_master       (every foreign key follows it)

Run it ONCE, on the machine that holds the database, right after pulling the
code that reads the new names and before restarting the app: the old code reads
parts.part_name / parts.specification and stops working the moment they change.

It refuses to drop an old model_no that holds any value, and before it changes
anything it writes every part's id, part no. and the three columns to a CSV
backup (--backup-dir, default: the current folder). Run again, it finds the new
names and changes nothing. Reads DATABASE_URL from the environment / .env and
never prints it.
"""
import argparse
import csv
import os
import sys
from datetime import datetime

from dotenv import load_dotenv
from sqlalchemy import create_engine, inspect, text

OLD, NEW = "parts", "part_master"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--apply", action="store_true", help="back up and rename (without it: look only)")
    ap.add_argument("--backup-dir", default=".", help="where the CSV backup goes (default: current folder)")
    args = ap.parse_args()

    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL is not set.")
    engine = create_engine(url)

    with engine.connect() as conn:
        tables = set(inspect(conn).get_table_names())
        if NEW in tables and OLD not in tables:
            cols = {c["name"] for c in inspect(conn).get_columns(NEW)}
            if {"item_description", "model_no"} <= cols and not {"part_name", "specification"} & cols:
                print(f"Already done: table {NEW} with item_description and model_no. Nothing to change.")
                return 0
            raise SystemExit(f"Table {NEW} has unexpected columns, stopping: {sorted(cols)}")
        if OLD not in tables or NEW in tables:
            raise SystemExit(f"Expected table {OLD} and no table {NEW}; found {OLD}: {OLD in tables}, "
                             f"{NEW}: {NEW in tables}. Stopping.")
        cols = {c["name"] for c in inspect(conn).get_columns(OLD)}
        if not {"part_name", "specification"} <= cols:
            raise SystemExit(f"Unexpected columns on {OLD}, stopping: {sorted(cols)}")
        old_model = "model_no" in cols
        filled = conn.execute(text(
            f"SELECT count(*) FROM {OLD} WHERE model_no IS NOT NULL AND trim(model_no) <> ''")).scalar() if old_model else 0
        total = conn.execute(text(f"SELECT count(*) FROM {OLD}")).scalar()
        print(f"{OLD}: {total} rows. Old model_no column: {'yes' if old_model else 'no'}, with a value in {filled} rows.")
        if filled:
            raise SystemExit("The old model_no column holds values - not dropping it. Stopping; nothing changed.")
        plan = ([f"ALTER TABLE {OLD} DROP COLUMN model_no"] if old_model else []) + [
            f"ALTER TABLE {OLD} RENAME COLUMN specification TO model_no",
            f"ALTER TABLE {OLD} RENAME COLUMN part_name TO item_description",
            f"ALTER TABLE {OLD} RENAME TO {NEW}",
        ]
        for sql in plan:
            print("  ", sql)
        if not args.apply:
            print("Look only. Run with --apply to back up and rename.")
            return 0

        os.makedirs(args.backup_dir, exist_ok=True)
        path = os.path.join(args.backup_dir, f"parts_columns_before_rename_{datetime.now():%Y-%m-%d_%H%M%S}.csv")
        rows = conn.execute(text(
            "SELECT id, part_no, part_name, specification"
            + (", model_no" if old_model else ", NULL") + f" FROM {OLD} ORDER BY id")).fetchall()
        with open(path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(["id", "part_no", "part_name", "specification", "model_no"])
            w.writerows(rows)
        print(f"Backup: {len(rows)} rows -> {os.path.abspath(path)}")

    with engine.begin() as conn:            # one transaction: all of it or none
        for sql in plan:
            conn.execute(text(sql))
    with engine.connect() as conn:
        tables = set(inspect(conn).get_table_names())
        cols = {c["name"] for c in inspect(conn).get_columns(NEW)} if NEW in tables else set()
    ok = OLD not in tables and {"item_description", "model_no"} <= cols and not {"part_name", "specification"} & cols
    print(f"Done: table {NEW} with item_description and model_no." if ok
          else f"Check the database: tables {sorted(tables & {OLD, NEW})}, columns {sorted(cols)}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
