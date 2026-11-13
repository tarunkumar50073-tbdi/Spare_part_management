"""Rename every "barcode" table / column to "QR code" (the store, 13 Nov 2026:
"jha bhi barcode name h usko qr code name kr de" ... "dono jagah kar de ui and
table me bhi and backend me bhi").

    python rename_qr_columns.py            # look only: says what it would do
    python rename_qr_columns.py --apply    # back up, then rename

In one transaction:
    part_master.barcode             -> qr_code
    label_print_audit.barcode_value -> qr_code_value
    srv_scan_events.barcode         -> qr_code
    table part_barcodes             -> part_qr_codes  (foreign keys follow)

Run it ONCE, on the database, together with the code that reads the new names:
the old code stops working the moment they change, the new one until they do.
Before changing anything it writes the values of the renamed columns and the
whole part_barcodes table to CSV files (--backup-dir). Run again, it finds the
new names and changes nothing. Reads DATABASE_URL from the environment / .env
and never prints it.
"""
import argparse
import csv
import os
import sys
from datetime import datetime

from dotenv import load_dotenv
from sqlalchemy import create_engine, inspect, text

COLUMNS = (("part_master", "barcode", "qr_code"),
           ("label_print_audit", "barcode_value", "qr_code_value"),
           ("srv_scan_events", "barcode", "qr_code"))
TABLES = (("part_barcodes", "part_qr_codes"),)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--apply", action="store_true", help="back up and rename (without it: look only)")
    ap.add_argument("--backup-dir", default=".", help="where the CSV backups go (default: current folder)")
    args = ap.parse_args()

    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL is not set.")
    engine = create_engine(url)

    plan, backups = [], []
    with engine.connect() as conn:
        insp = inspect(conn)
        tables = set(insp.get_table_names())
        for table, old, new in COLUMNS:
            if table not in tables:
                print(f"  {table}: no such table - skipped")
                continue
            cols = {c["name"] for c in insp.get_columns(table)}
            if new in cols and old not in cols:
                print(f"  {table}.{new}: already done")
            elif old in cols and new not in cols:
                n = conn.execute(text(f"SELECT count(*) FROM {table} WHERE {old} IS NOT NULL")).scalar()
                print(f"  {table}.{old} -> {new}  ({n} rows with a value)")
                plan.append(f"ALTER TABLE {table} RENAME COLUMN {old} TO {new}")
                backups.append((f"{table}_{old}", f"SELECT id, {old} FROM {table} ORDER BY id"))
            else:
                raise SystemExit(f"{table}: unexpected columns {sorted(cols & {old, new})}. Stopping; nothing changed.")
        for old, new in TABLES:
            if new in tables and old not in tables:
                print(f"  table {new}: already done")
            elif old in tables and new not in tables:
                n = conn.execute(text(f"SELECT count(*) FROM {old}")).scalar()
                print(f"  table {old} -> {new}  ({n} rows)")
                plan.append(f"ALTER TABLE {old} RENAME TO {new}")
                backups.append((old, f"SELECT * FROM {old} ORDER BY id"))
            else:
                raise SystemExit(f"Tables {old} / {new} both or neither there. Stopping; nothing changed.")
        if not plan:
            print("Already done. Nothing to change.")
            return 0
        if not args.apply:
            print("Look only. Run with --apply to back up and rename.")
            return 0
        os.makedirs(args.backup_dir, exist_ok=True)
        stamp = f"{datetime.now():%Y-%m-%d_%H%M%S}"
        for name, sql in backups:
            res = conn.execute(text(sql))
            path = os.path.join(args.backup_dir, f"{name}_before_qr_rename_{stamp}.csv")
            with open(path, "w", newline="", encoding="utf-8-sig") as f:
                w = csv.writer(f)
                w.writerow(list(res.keys()))
                w.writerows(res.fetchall())
            print(f"Backup: {os.path.abspath(path)}")

    with engine.begin() as conn:            # one transaction: all of it or none
        for sql in plan:
            print("  ", sql)
            conn.execute(text(sql))
    print("Done: every barcode table / column is a QR code one.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
