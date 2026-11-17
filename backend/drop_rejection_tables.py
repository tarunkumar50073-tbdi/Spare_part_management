"""Drop the tables of the removed rejection features (17 Nov 2026, the store:
"only rejection ka hta de na dekhni na bhejni . short wala rhne de"):

    rejection_request_history   the Rejection Mail (RQC) log      (dropped first: it points at rejection_requests)
    rejection_requests          the Rejection Mail (RQC) drafts
    erp_line_rejections         the read-only mirror of ERP's line_rejection_report

Short Receiving and the Short Mail stay; they use none of these tables.

Dry run unless --apply. With --apply: writes every row of each table to a CSV in
C:\\dx_store_data\\backups (else next to this script) first, then drops it. A
non-empty rejection_requests / rejection_request_history (the store's own
records) is refused unless --force is given as well; erp_line_rejections is only
a copy of ERP's table, so it is dropped with its rows backed up.

Run on the server (login "server", the tables' owner):  python drop_rejection_tables.py --apply
"""
import csv
import datetime
import os
import sys

from dotenv import load_dotenv
from sqlalchemy import create_engine, inspect, text

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
APPLY, FORCE = "--apply" in sys.argv, "--force" in sys.argv
# In drop order: the history refers to rejection_requests.
TABLES = ("rejection_request_history", "rejection_requests", "erp_line_rejections")
# The store's own records: never dropped with rows in them unless --force.
GUARDED = {"rejection_request_history", "rejection_requests"}

eng = create_engine(os.environ["DATABASE_URL"])
present = set(inspect(eng).get_table_names())
found = {}
for table in TABLES:
    if table not in present:
        print(f"{table}: not there — nothing to do")
        continue
    with eng.connect() as c:
        found[table] = c.execute(text(f"SELECT * FROM {table}")).mappings().all()
    print(f"{table}: {len(found[table])} rows")
if not found:
    raise SystemExit(0)
if not APPLY:
    print("DRY RUN — add --apply to back them up and drop them")
    raise SystemExit(0)
full = [t for t in found if t in GUARDED and found[t]]
if full and not FORCE:
    print(f"NOT EMPTY: {', '.join(full)} — refusing to drop without --force (check the rows first)")
    raise SystemExit(1)

folder = r"C:\dx_store_data\backups" if os.path.isdir(r"C:\dx_store_data\backups") else os.path.dirname(os.path.abspath(__file__))
stamp = f"{datetime.datetime.now():%Y-%m-%d_%H%M%S}"
for table, rows in found.items():
    path = os.path.join(folder, f"{table}_before_drop_{stamp}.csv")
    with open(path, "w", newline="", encoding="utf-8") as f:
        cols = list(rows[0].keys()) if rows else [c["name"] for c in inspect(eng).get_columns(table)]
        w = csv.writer(f)
        w.writerow(cols)
        for r in rows:
            w.writerow([r[k] for k in cols])
    print(f"{table}: backup {path}")
with eng.begin() as c:
    for table in found:
        c.execute(text(f"DROP TABLE {table}"))
        print(f"DROPPED {table}")
