"""Old-stock labels made on 14 Nov 2026 with the count day: re-date their batch
to the part's last GRN (as the app does since a6b22d7), recode the packets, and
write the new code wherever history holds the old one. Backup first. Dry run
unless --apply."""
import csv, datetime, re, sys
from dotenv import dotenv_values
from sqlalchemy import create_engine, text
APPLY = "--apply" in sys.argv
url = dotenv_values(r"C:\Users\Administrator\Desktop\App\DX_Store\backend\.env")["DATABASE_URL"]
eng = create_engine(url, connect_args={"connect_timeout": 20})
with eng.begin() as c:
    rows = c.execute(text("""select b.id bid, b.received_on, p.part_no, k.id kid, k.code
        from spare_batches b join spare_packets k on k.batch_id=b.id join part_master p on p.id=b.part_id
        where b.source='OPENING' and b.received_on = date '2026-11-14' and k.status <> 'CANCELLED' order by k.id""")).fetchall()
    plan, codes = [], {}
    for r in rows:
        g = c.execute(text("""select max(grn_date) from receiving_register where upper(trim(item_cd))=upper(trim(:p))
            and grn_date <= :d and (accept_qty is null or accept_qty <> 0)"""), {"p": r.part_no, "d": r.received_on}).scalar()
        if not g:
            print("no GRN, kept:", r.part_no, r.code); continue
        no = re.sub(r"[^A-Z0-9]", "", r.part_no.upper())
        new = f"TB{g:%Y%m%d}{no[:max(1, 24-10)]}"
        plan.append((r.bid, r.kid, r.code, new, g)); codes.setdefault(r.code, set()).add(new)
    for x in plan: print("plan:", x[2], "->", x[3], "batch", x[0], "date", x[4])
    clash = {k: v for k, v in codes.items() if len(v) > 1}
    if clash: print("CLASH, text history not changed for:", clash)
    hist = [("spare_stock_ledger","reference"),("spare_stock_ledger","remarks"),("spare_transactions","scanned_code"),
            ("spare_transactions","remarks"),("scan_audit","scanned_code"),("label_print_audit","qr_code_value")]
    have = {(t, col) for t, col in c.execute(text("select table_name, column_name from information_schema.columns where table_schema='public'"))}
    hits = []
    for old, news in codes.items():
        if old in clash: continue
        for t, col in hist:
            if (t, col) in have:
                for rid, val in c.execute(text(f'select id, "{col}" from "{t}" where "{col}" like :l'), {"l": f"%{old}%"}):
                    hits.append((t, col, rid, val, val.replace(old, next(iter(news)))))
    for h in hits: print("history:", h[0], h[1], h[2], "|", h[3][:70], "->", h[4][:70])
    if not APPLY:
        print("DRY RUN"); raise SystemExit(0)
    stamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
    bk = rf"C:\dx_store_data\backups\labels_before_grn_redate_{stamp}.csv"
    with open(bk, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f); w.writerow(["kind","table","col","id","old","new"])
        for b, k, o, n, g in plan: w.writerow(["packet","spare_packets","code",k,o,n]); w.writerow(["batch","spare_batches","received_on",b,"2026-11-14",g])
        for t, col, rid, old, new in hits: w.writerow(["history",t,col,rid,old,new])
    for b, k, o, n, g in plan:
        c.execute(text("update spare_batches set received_on=:g where id=:b"), {"g": g, "b": b})
        c.execute(text("update spare_packets set code=:n where id=:k"), {"n": n, "k": k})
    for t, col, rid, old, new in hits:
        c.execute(text(f'update "{t}" set "{col}"=:v where id=:i'), {"v": new, "i": rid})
    print("APPLIED; backup", bk)
