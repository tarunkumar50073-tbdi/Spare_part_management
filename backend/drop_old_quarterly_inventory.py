"""Drop the old one-table Quarterly Inventory (quarterly_inventory), replaced on
15 Nov 2026 by the inventory_* tables ("do do table kyu rkhni h confusion
hoga"). It held no row when it was replaced.

Dry run unless --apply. With --apply: writes every row (if any) to a CSV in
C:\\dx_store_data\\backups first, and refuses to drop a table that is not empty
unless --force is given as well.

Run on the server (login "server", the table's owner):  python drop_old_quarterly_inventory.py --apply
"""
import csv
import datetime
import os
import sys

from dotenv import load_dotenv
from sqlalchemy import create_engine, inspect, text

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
APPLY, FORCE = "--apply" in sys.argv, "--force" in sys.argv
TABLE = "quarterly_inventory"

eng = create_engine(os.environ["DATABASE_URL"])
if TABLE not in inspect(eng).get_table_names():
    print(f"{TABLE} is not there — nothing to do")
    raise SystemExit(0)
with eng.connect() as c:
    rows = c.execute(text(f"SELECT * FROM {TABLE}")).mappings().all()
print(f"{TABLE}: {len(rows)} rows")
if not APPLY:
    print("DRY RUN — add --apply to back it up and drop it")
    raise SystemExit(0)
if rows and not FORCE:
    print("NOT EMPTY — refusing to drop without --force (check the rows first)")
    raise SystemExit(1)
folder = r"C:\dx_store_data\backups" if os.path.isdir(r"C:\dx_store_data\backups") else os.path.dirname(os.path.abspath(__file__))
path = os.path.join(folder, f"{TABLE}_before_drop_{datetime.datetime.now():%Y-%m-%d_%H%M%S}.csv")
with open(path, "w", newline="", encoding="utf-8") as f:
    cols = list(rows[0].keys()) if rows else [c["name"] for c in inspect(eng).get_columns(TABLE)]
    w = csv.writer(f)
    w.writerow(cols)
    for r in rows:
        w.writerow([r[k] for k in cols])
with eng.begin() as c:
    c.execute(text(f"DROP TABLE {TABLE}"))
print(f"DROPPED {TABLE}; backup {path}")
