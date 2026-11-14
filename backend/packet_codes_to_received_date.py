"""Packet codes dated by when the material came in (the store, 14 Nov 2026,
"haan kar de"): old-stock packets were coded with the day their label was
printed, so one lot got several codes (CNTR1543: TB20261105 / 1106 / 1114).
Each TB code is set to TB + its batch's received_on + Part No. Only
spare_packets.code changes; a backup CSV is written first; one transaction.
Dry run by default; --apply writes.
"""
import csv
import datetime
import os
import re
import sys

from dotenv import dotenv_values
from sqlalchemy import create_engine, text

HERE = os.path.dirname(os.path.abspath(__file__))
BACKUP_DIR = r"C:\dx_store_data\backups"
CODE_MAX = 24


def main(apply):
    url = os.environ.get("DATABASE_URL") or dotenv_values(os.path.join(HERE, ".env"))["DATABASE_URL"]
    stamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
    with create_engine(url, connect_args={"connect_timeout": 20}).begin() as c:
        rows = c.execute(text(
            "SELECT k.id, k.code, k.status, b.received_on, p.part_no FROM spare_packets k "
            "JOIN spare_batches b ON b.id = k.batch_id JOIN part_master p ON p.id = k.part_id "
            "WHERE k.code LIKE 'TB%' AND b.received_on IS NOT NULL ORDER BY k.id")).fetchall()
        change = []
        for pid, code, status, day, part_no in rows:
            stem = f"TB{day:%Y%m%d}"
            no = re.sub(r"[^A-Z0-9]", "", (part_no or "").upper())
            new = f"{stem}{no[:max(1, CODE_MAX - len(stem))]}"
            if new != code:
                change.append((pid, code, new, status))
        for x in change:
            print(x)
        print(len(change), "of", len(rows), "packets change")
        if not apply:
            print("dry run - nothing written (add --apply)")
            raise SystemExit(0)
        path = os.path.join(BACKUP_DIR, f"packet_codes_before_received_date_{stamp}.csv")
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["id", "code", "new_code", "status"])
            w.writerows(change)
        print("backup:", path)
        for pid, _, new, _ in change:
            c.execute(text("UPDATE spare_packets SET code = :c WHERE id = :i"), {"c": new, "i": pid})
    print("done")


if __name__ == "__main__":
    main("--apply" in sys.argv)
