"""Packet codes without the label number (the store, 14 Nov 2026: "dono me
number hata de, saare change kar de old bhi ... kaam har jagah backend,
frontend and DB tino jagah").

Every packet of a part made with one date shares TB + YYYYMMDD + Part No.;
the packets are told apart by id and seq. In the database:
  * spare_packets.code: the unique index ix_spare_packets_code becomes a plain
    index, and every TB code loses its "-NN";
  * the same codes written elsewhere lose it too: spare_stock_ledger
    reference / remarks, spare_transactions scanned_code / remarks,
    scan_audit scanned_code, label_print_audit qr_code_value.
A backup CSV of every row touched is written first; all of it is one
transaction. Dry run by default; --apply writes.

    python strip_packet_numbers.py            # what would change
    python strip_packet_numbers.py --apply
"""
import csv
import datetime
import os
import sys

from dotenv import dotenv_values
from sqlalchemy import create_engine, text

HERE = os.path.dirname(os.path.abspath(__file__))
BACKUP_DIR = r"C:\dx_store_data\backups"
NUMBERED = r"TB[0-9]{8}[A-Z0-9]+-[0-9]{2,3}"
STRIP = r"(TB[0-9]{8}[A-Z0-9]+)-[0-9]{2,3}"
COLUMNS = (
    ("spare_packets", "code"),
    ("spare_stock_ledger", "reference"),
    ("spare_stock_ledger", "remarks"),
    ("spare_transactions", "scanned_code"),
    ("spare_transactions", "remarks"),
    ("scan_audit", "scanned_code"),
    ("label_print_audit", "qr_code_value"),
)


def main(apply):
    url = os.environ.get("DATABASE_URL") or dotenv_values(os.path.join(HERE, ".env"))["DATABASE_URL"]
    eng = create_engine(url, connect_args={"connect_timeout": 20})
    stamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
    with eng.begin() as c:
        have = {(t, col) for t, col in c.execute(text(
            "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'"))}
        todo = [x for x in COLUMNS if x in have]
        rows = {}
        for t, col in todo:
            rows[(t, col)] = c.execute(text(
                f'SELECT id, "{col}" FROM "{t}" WHERE "{col}" ~ :p ORDER BY id'), {"p": NUMBERED}).fetchall()
            print(f"{t}.{col}: {len(rows[(t, col)])} rows")
        unique = c.execute(text(
            "SELECT indexdef FROM pg_indexes WHERE tablename = 'spare_packets' AND indexname = 'ix_spare_packets_code'"
        )).scalar()
        print("index:", unique)
        if not apply:
            print("dry run - nothing written (add --apply)")
            raise SystemExit(0)
        os.makedirs(BACKUP_DIR, exist_ok=True)
        path = os.path.join(BACKUP_DIR, f"packet_codes_before_strip_numbers_{stamp}.csv")
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["table", "column", "id", "value"])
            for (t, col), rs in rows.items():
                for rid, val in rs:
                    w.writerow([t, col, rid, val])
        print("backup:", path)
        if unique and "UNIQUE" in unique.upper():
            c.execute(text("DROP INDEX ix_spare_packets_code"))
            c.execute(text("CREATE INDEX ix_spare_packets_code ON spare_packets (code)"))
            print("ix_spare_packets_code: now a plain index")
        for t, col in todo:
            n = c.execute(text(
                f'UPDATE "{t}" SET "{col}" = regexp_replace("{col}", :s, \'\\1\', \'g\') WHERE "{col}" ~ :p'),
                {"s": STRIP, "p": NUMBERED}).rowcount
            print(f"{t}.{col}: {n} updated")
        left = c.execute(text("SELECT count(*) FROM spare_packets WHERE code ~ :p"), {"p": NUMBERED}).scalar()
        assert left == 0, left
    print("done")


if __name__ == "__main__":
    main("--apply" in sys.argv)
