"""Spare receiving read from ERP: the GRN register -> store stock.

Receiving, the GRN and the Maintenance / Tool Room quality clearance all happen
in ERP (spec 1 / 9). The app records none of them by hand; it READS the ERP GRN
register (termsdb.srv_report, mirrored read-only into receiving_register by
ERPSyncService) and turns what ERP says into the part's store stock and history:

    ERP GRN line, accept_qty empty      -> GRN created, quality pending (not stock)
    ERP GRN line, accept_qty > 0        -> quality cleared: the accepted qty is
                                           added to available stock ONCE (a
                                           RECEIPT ledger row, status ERP_GRN,
                                           reference = GRN no.) + a journal row
    ERP GRN line, reject_qty > 0        -> rejected by quality (never stock)

Quality pending follows ERP's own figure (5 Nov 2026): ERP's current stock
holds, per part, what is still under inspection (erp_stock.under_insp). The
part's newest GRN lines with no accepted qty, up to that figure, are quality
pending; any older one ERP holds nothing of under inspection was cleared into
ERP's stock though the SRV line shows no accepted qty (ERP often leaves it
empty) - it is taken as accepted at its receipt qty and goes through the same
rules below (already in a count, or added once). Where ERP's figure is not
read for a part - its current stock has no row for it, which is so for every
item whose accepted stock is 0 - the old way stands: a line still waiting for quality but
dated on/before the part's stock count, and NOT on that count's "Waiting for
QC" list, is taken as already in that stock ("list k alawa grn pending bhi na
dikhayen") and never added.

Posting rules, all to avoid counting anything twice:
  * matched on item_cd = Part No. (the ERP item code), spare store parts only;
  * a part never physically counted is skipped — its first count includes it;
  * a GRN dated on/before the part's stock baseline (its last physical count,
    opening load or stock-row creation) is skipped — that count already has it —
    UNLESS the line was still waiting for quality when that count was taken:
    the upload's "Waiting for QC" tab names those lines (5 Nov 2026, an opening
    load from ERP's stock, which holds accepted material only) - or, with no
    tab, the lines ERP held under inspection at the upload - and every ERP read
    (post) notes again the lines ERP still holds under inspection; each is
    added once quality clears it, whatever its GRN date;
  * a GRN dated before the configured "post from" date is never auto-posted;
  * each (part, GRN no.) is posted once; if ERP later accepts more on the same
    GRN only the difference is added; a reduction is flagged, never reversed
    silently.
RECEIPT rows with status ERP_GRN are ERP-originated, so the ERP stock-write
push leaves them out (models/spare_stock.ERP_ORIGIN_RECEIPT_STATUSES).

ERP gives no quality date — only the GRN date. The time the app first saw the
accepted qty (the sync that read it) is when the stock-in is recorded, and the
row says so.
"""
from collections import defaultdict
from datetime import date, datetime, timezone

from sqlalchemy import func

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.erp_stock import ERPStock
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.spare_flow import SpareTransaction
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.services.spare_journal_service import SpareJournalService
from app.services.spare_stock_service import SpareStockService
from app.utils.db_tx import atomic
from app.utils.exceptions import BadRequestError

SETTING_KEY = "erp_grn_autopost"
# GRN lines waiting for quality when a part's stock was counted / loaded:
# {"<part id>|<GRN key>": "<that count's day, YYYY-MM-DD>"}. Written by the
# stock upload's "Waiting for QC" tab (SpareStockService.bulk_import).
PENDING_KEY = "erp_grn_pending_at_count"
# Posting starts from the day this went live: GRNs before it are part of the
# physical counts the store already did. An admin can move it in Receiving & GRN.
DEFAULTS = {"enabled": True, "from_date": "2026-09-26"}
STATUS = "ERP_GRN"
ERP_USER = "ERP-GRN"


def _f(v):
    return float(v) if v is not None else None


def _plant_date(stamp):
    """A DB stamp (naive UTC in SQLite, or aware) as the plant's calendar date —
    the server clock is the plant clock."""
    if stamp is None:
        return None
    if isinstance(stamp, date) and not isinstance(stamp, datetime):
        return stamp
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone().date()


def _as_date(value):
    if value in (None, ""):
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        raise BadRequestError("from_date must be a date (YYYY-MM-DD)")


class ErpGrnPostingService:
    def __init__(self):
        self.stock = SpareStockService()
        self.journal = SpareJournalService()

    # ---- settings ----

    def settings(self):
        saved = AppSetting.get_value(SETTING_KEY)
        out = dict(DEFAULTS)
        if isinstance(saved, dict):
            out.update({k: saved[k] for k in DEFAULTS if k in saved})
        return out

    def set_settings(self, data, user=None):
        current = self.settings()
        if "enabled" in (data or {}):
            current["enabled"] = bool(data["enabled"])
        if "from_date" in (data or {}):
            d = _as_date(data["from_date"])
            if d is None:
                raise BadRequestError("from_date is required")
            if d > date.today():
                raise BadRequestError("from_date cannot be in the future")
            current["from_date"] = d.isoformat()
        AppSetting.set_value(SETTING_KEY, current, user)
        return current

    # ---- GRN lines waiting for quality at a count ----

    @staticmethod
    def pending_at_count():
        """{(part id, GRN key): count day} — the lines that were still waiting
        for quality in ERP when that count of the part was taken. Not in the
        count, whatever their GRN date (the store, 5 Nov 2026: ERP's stock
        counts accepted material only)."""
        saved = AppSetting.get_value(PENDING_KEY)
        out = {}
        for key, day in (saved.items() if isinstance(saved, dict) else ()):
            pid, _, grn = str(key).partition("|")
            try:
                out[(int(pid), grn)] = date.fromisoformat(str(day)[:10])
            except ValueError:
                continue
        return out

    @classmethod
    def remember_pending(cls, lines, user=None):
        """Note GRN lines waiting for quality at a count: `lines` is
        [(part id, GRN no., count day)]. A newer note for the same line wins.
        No commit — it rides on the caller's transaction (the stock upload)."""
        if not lines:
            return 0
        row = AppSetting.query.filter_by(key=PENDING_KEY).first()
        if row is None:
            row = AppSetting(key=PENDING_KEY)
            db.session.add(row)
        import json
        try:
            saved = json.loads(row.value) if row.value else {}
        except (TypeError, ValueError):
            saved = {}
        if not isinstance(saved, dict):
            saved = {}
        new = 0
        for pid, grn_no, day in lines:
            key = cls._key(grn_no)
            if key and saved.get(f"{int(pid)}|{key}") != day.isoformat():
                saved[f"{int(pid)}|{key}"] = day.isoformat()
                new += 1
        if new:
            row.value = json.dumps(saved)
            row.updated_by = user
        elif row.id is None:
            db.session.expunge(row)          # nothing to keep: no empty row
        return len(lines)

    @staticmethod
    def _under_inspection(part_ids):
        """{part id: qty ERP holds under inspection, or None when ERP's figure
        is not read for it}. A part ERP's current stock does not list is NOT
        read as 0: ERP leaves out every item whose accepted stock is 0, even
        with material under inspection (5 Nov 2026: CNEI1500 / CNEI1501, first
        GRN 03.11, pending QC in ERP's own screen, no current stock row) — so
        for such a part the count / Waiting for QC rules decide."""
        if not part_ids:
            return {}
        out = {}
        for start in range(0, len(part_ids), 900):
            for pid, under in (db.session.query(ERPStock.part_id, ERPStock.under_insp)
                               .filter(ERPStock.part_id.in_(part_ids[start:start + 900]))):
                out[pid] = float(under) if under is not None else None
        return out

    @staticmethod
    def _held_lines(grouped, under):
        """{(part id, GRN no.)} ERP holds under inspection: per part, its newest
        GRN lines with no accepted and no rejected qty, while ERP's figure lasts
        (a line it covers even in part is held)."""
        waiting = defaultdict(list)
        for (pid, grn_no), g in grouped.items():
            if not g["accept"] and not g["reject"]:
                waiting[pid].append((g.get("grn_date") or date.min, grn_no, g["receipt"]))
        held = set()
        for pid, rows in waiting.items():
            left = under.get(pid)
            if not left:
                continue
            for _, grn_no, qty in sorted(rows, key=lambda r: (r[0], r[1]), reverse=True):
                if left <= 1e-9:
                    break
                held.add((pid, grn_no))
                left -= qty
        return held

    # ---- reading ----

    @staticmethod
    def _baseline(part_ids):
        """part_id -> (baseline plant date, counted?) — the latest of the last
        physical count, the latest OPENING / ADJUSTMENT row and the stock row's
        creation. No stock row = never counted. A count loaded later than it
        was taken carries its own day (SpareStock.count_as_of, 27 Oct 2026):
        that day is the baseline, so GRNs after it are added on top."""
        rows = {r.part_id: r for r in SpareStock.query.filter(SpareStock.part_id.in_(part_ids)).all()} if part_ids else {}
        counts = dict(
            db.session.query(SpareStockLedger.part_id, func.max(SpareStockLedger.created_at))
            .filter(SpareStockLedger.part_id.in_(part_ids),
                    SpareStockLedger.txn_type.in_(("OPENING", "ADJUSTMENT")))
            .group_by(SpareStockLedger.part_id).all()
        ) if part_ids else {}
        out = {}
        for pid in part_ids:
            r = rows.get(pid)
            if r is None:
                out[pid] = (None, False)
                continue
            if getattr(r, "count_as_of", None):
                out[pid] = (r.count_as_of, True)
                continue
            dates = [d for d in (_plant_date(r.last_counted_at), _plant_date(counts.get(pid)),
                                 _plant_date(r.created_at)) if d]
            out[pid] = (max(dates) if dates else None, True)
        return out

    @staticmethod
    def _key(grn_no):
        """GRN numbers are matched trimmed and case-blind: a supervisor typed
        some of them by hand."""
        return (grn_no or "").strip().upper()

    @classmethod
    def _posted(cls, part_ids):
        """(part_id, GRN no. key) -> qty already in store stock from that GRN,
        whichever way it got there: this ERP posting (status ERP_GRN), the
        short-lived in-app quality clearance (status STOCK_AVAILABLE, reference
        = the GRN no. as typed), or an RGP GRN (its GRN no. is on the journal
        row and the RGP, the ledger reference being the RGP no.). Without all
        three an ERP line for the same GRN would be added a second time."""
        if not part_ids:
            return {}
        out = defaultdict(float)
        ledger = (db.session.query(SpareStockLedger.part_id, SpareStockLedger.reference,
                                   func.sum(SpareStockLedger.qty_delta))
                  .filter(SpareStockLedger.part_id.in_(part_ids), SpareStockLedger.txn_type == "RECEIPT",
                          SpareStockLedger.status.in_((STATUS, "STOCK_AVAILABLE")))
                  .group_by(SpareStockLedger.part_id, SpareStockLedger.reference))
        for pid, ref, qty in ledger.all():
            out[(pid, cls._key(ref))] += float(qty or 0)
        rgp = (db.session.query(SpareTransaction.part_id, SpareTransaction.grn_no, func.sum(SpareTransaction.qty))
               .filter(SpareTransaction.part_id.in_(part_ids), SpareTransaction.txn_type == "RGP_GRN",
                       SpareTransaction.grn_no.isnot(None))
               .group_by(SpareTransaction.part_id, SpareTransaction.grn_no))
        for pid, grn, qty in rgp.all():
            out[(pid, cls._key(grn))] += float(qty or 0)
        return {k: round(v, 2) for k, v in out.items()}

    def lines(self, store_code, part_id=None):
        """Every ERP GRN line of the store's parts (in the mirror's window),
        grouped per (part, GRN no.), each with what the app does with it."""
        parts_q = Part.query.filter(Part.store_code == store_code)
        if part_id:
            parts_q = parts_q.filter(Part.id == part_id)
        parts = {p.part_no.upper(): p for p in parts_q.all() if p.part_no}
        if not parts:
            return []
        grn_q = ReceivingRegister.query.filter(func.upper(ReceivingRegister.item_cd).in_(list(parts)))
        grouped = defaultdict(lambda: {"receipt": 0.0, "accept": None, "reject": None, "rows": []})
        for r in grn_q.all():
            part = parts.get((r.item_cd or "").upper())
            if part is None or not r.grn_no:
                continue
            g = grouped[(part.id, r.grn_no)]
            g["part"] = part
            g["grn_no"] = r.grn_no
            g["grn_date"] = min(filter(None, [g.get("grn_date"), r.grn_date]), default=None)
            g["ven_cd"] = g.get("ven_cd") or r.ven_cd
            g["ven_name"] = g.get("ven_name") or r.ven_name
            g["invoice_no"] = g.get("invoice_no") or r.challan_no
            g["receipt"] += float(r.receipt_qty or 0)
            if r.accept_qty is not None:
                g["accept"] = (g["accept"] or 0.0) + float(r.accept_qty)
            if r.reject_qty is not None:
                g["reject"] = (g["reject"] or 0.0) + float(r.reject_qty)

        cfg = self.settings()
        from_date = _as_date(cfg.get("from_date"))
        part_ids = list({k[0] for k in grouped})
        base = self._baseline(part_ids)
        posted = self._posted(part_ids)
        waiting = self.pending_at_count()
        under = self._under_inspection(part_ids)
        held = self._held_lines(grouped, under)
        out = []
        for (pid, grn_no), g in grouped.items():
            part = g["part"]
            accepted = round(g["accept"], 2) if g["accept"] is not None else None
            rejected = round(g["reject"], 2) if g["reject"] is not None else None
            erp_read = under.get(pid) is not None
            in_insp = (pid, grn_no) in held
            # ERP holds none of it under inspection and rejected none: quality
            # cleared it into ERP's stock, though the SRV line shows no accepted
            # qty (5 Nov 2026) - taken as accepted at its receipt qty.
            cleared = erp_read and not in_insp and not accepted and not rejected and g["receipt"] > 0
            if cleared:
                accepted = round(g["receipt"], 2)
            already = posted.get((pid, self._key(grn_no)), 0.0)
            baseline, counted = base.get(pid, (None, False))
            grn_date = g.get("grn_date")
            # Waiting for quality when THIS count was taken: not in it.
            was_waiting = baseline is not None and waiting.get((pid, self._key(grn_no))) == baseline
            state, reason, to_post = None, None, 0.0
            if not accepted and already > 0:
                # Stock already came in from this GRN (in-app clearance / RGP GRN,
                # or ERP later took the acceptance back) — never count it as
                # quality pending again.
                state, reason = "CHECK", (f"{already:g} already added to store stock from this GRN, but ERP "
                                          f"shows no accepted qty — check with ERP")
            elif not accepted:
                if rejected:
                    state, reason = "REJECTED", "Rejected by quality in ERP — not stock"
                elif erp_read and in_insp:
                    state, reason = "QUALITY_PENDING", "Under inspection in ERP — quality clearance pending"
                elif erp_read:
                    state, reason = "SKIPPED", "ERP holds nothing of this GRN under inspection — not quality pending"
                elif counted and baseline and grn_date and grn_date <= baseline and not was_waiting:
                    state, reason = "SKIPPED", (
                        f"GRN dated {grn_date.isoformat()}, on/before the part's stock count of "
                        f"{baseline.isoformat()} and not on that count's Waiting for QC list — taken as "
                        f"already in that stock, so not quality pending and never added")
                else:
                    state, reason = "QUALITY_PENDING", "GRN created in ERP — quality clearance pending"
            elif already >= accepted:
                state = "POSTED" if already == accepted else "CHECK"
                reason = (f"{already:g} added to store stock from this GRN" if already == accepted
                          else f"ERP now accepts {accepted:g} but {already:g} was already added — check with ERP")
            elif not counted:
                state, reason = "SKIPPED", "Part not counted yet — its first physical count will include this"
            elif baseline and grn_date and grn_date <= baseline and not was_waiting:
                state, reason = "SKIPPED", (f"GRN dated {grn_date.isoformat()}, on/before the part's stock "
                                            f"baseline {baseline.isoformat()} — that count already includes it")
            elif from_date and grn_date and grn_date < from_date:
                state, reason = "SKIPPED", f"GRN before the post-from date {from_date.isoformat()}"
            else:
                to_post = round(accepted - already, 2)
                state = "WILL_POST" if cfg.get("enabled") else "OFF"
                reason = (f"{to_post:g} accepted in ERP will be added to store stock" if cfg.get("enabled")
                          else "Auto-add from ERP is switched off")
                if was_waiting:
                    reason += (f" (it was waiting for quality when the stock was counted on "
                               f"{baseline.isoformat()}, so that count does not have it)")
            if cleared:
                reason = (reason or "") + (" — cleared by quality in ERP (no longer under inspection); "
                                           "the SRV line shows no accepted qty, so its receipt qty is used")
            out.append({
                "part_id": pid, "part_no": part.part_no, "part_name": part.part_name,
                "grn_no": grn_no, "grn_date": grn_date.isoformat() if grn_date else None,
                "ven_cd": g.get("ven_cd"), "ven_name": g.get("ven_name"), "invoice_no": g.get("invoice_no"),
                "receipt_qty": round(g["receipt"], 2), "accept_qty": accepted, "reject_qty": rejected,
                "posted_qty": already, "to_post": to_post, "state": state, "reason": reason,
                "baseline_date": baseline.isoformat() if baseline else None,
                "under_inspection": in_insp, "accept_inferred": cleared,
            })
        out.sort(key=lambda x: (x["grn_date"] or "", x["grn_no"]), reverse=True)
        return out

    def mirror_freshness(self):
        """When the GRN mirror was last refreshed and its newest GRN date — shown
        with every figure, so stale ERP data is never read as current."""
        last_write, newest = db.session.query(
            func.max(ReceivingRegister.created_at), func.max(ReceivingRegister.grn_date)).one()
        return {"synced_at": last_write.isoformat() if last_write else None,
                "newest_grn_date": newest.isoformat() if newest else None}

    def preview(self, store_code):
        rows = self.lines(store_code)
        counts = defaultdict(int)
        for r in rows:
            counts[r["state"]] += 1
        return {"settings": self.settings(), "erp": self.mirror_freshness(),
                "counts": dict(counts), "rows": rows}

    # ---- writing ----

    def note_held(self, lines, part_ids=None, user=None):
        """Note the lines ERP holds under inspection, dated on/before their
        part's current count, against that count (remember_pending) - they
        are in no count taken so far. `lines` as lines() gives them; part_ids
        limits it. Returns how many were noted."""
        held = [(l["part_id"], l["grn_no"], date.fromisoformat(l["baseline_date"])) for l in lines
                if l.get("under_inspection") and l["baseline_date"] and l["grn_date"]
                and l["grn_date"] <= l["baseline_date"]
                and (part_ids is None or l["part_id"] in part_ids)]
        if held:
            with atomic():
                self.remember_pending(held, user=user)
        return len(held)

    def post(self, store_code, user=ERP_USER):
        """Add every WILL_POST line to store stock. Each (part, GRN) is its own
        transaction and re-checked inside it, so a concurrent run can't add the
        same GRN twice. Returns what was posted."""
        if not self.settings().get("enabled"):
            return {"posted": [], "skipped_off": True}
        lines = self.lines(store_code)
        # A line ERP still holds under inspection is in no count taken so far:
        # note it against the part's current count, so it is added once quality
        # clears it, whatever its GRN date (5 Nov 2026).
        self.note_held(lines, user=user)
        done = []
        for line in lines:
            if line["state"] != "WILL_POST" or line["to_post"] <= 0:
                continue
            with atomic():
                already = self._posted([line["part_id"]]).get((line["part_id"], self._key(line["grn_no"])), 0.0)
                qty = round((line["accept_qty"] or 0) - already, 2)
                if qty <= 0:
                    continue
                stock_row = SpareStock.query.filter_by(part_id=line["part_id"]).first()
                if stock_row is None:
                    continue  # never counted — the rule above; re-checked here
                new_qty = round(float(stock_row.qty_on_hand or 0) + qty, 2)
                remarks = (f"ERP GRN {line['grn_no']} ({line['grn_date']}) — accepted by quality in ERP; "
                           f"read by the app's ERP sync")
                row, _ = self.stock._write(
                    line["part_id"], new_qty, "RECEIPT", reference=line["grn_no"],
                    remarks=remarks[:255], user=user,
                    extra={"status": STATUS, "invoice_no": line["invoice_no"]},
                )
                ledger = (SpareStockLedger.query
                          .filter_by(part_id=line["part_id"], txn_type="RECEIPT", status=STATUS,
                                     reference=line["grn_no"])
                          .order_by(SpareStockLedger.id.desc()).first())
                self.journal.record(
                    line["part_id"], "GRN", qty, store_code=store_code, user=user,
                    prev_status="QUALITY_PENDING", new_status="STOCK_AVAILABLE",
                    from_bucket="QUALITY_PENDING", to_bucket="AVAILABLE",
                    ledger_id=ledger.id if ledger else None,
                    supplier_name=line["ven_name"], ven_cd=line["ven_cd"], grn_no=line["grn_no"],
                    invoice_no=line["invoice_no"], remarks=remarks,
                )
                # The receipt batch its packets / QR labels and FIFO date hang
                # on (spare_packet.py) — made with the stock, in the same go.
                if ledger is not None:
                    from app.services.spare_packet_service import SparePacketService
                    SparePacketService().receipt_for_ledger(ledger, user=user)
            done.append({"part_id": line["part_id"], "part_no": line["part_no"],
                         "grn_no": line["grn_no"], "qty": qty})
        return {"posted": done, "skipped_off": False}
