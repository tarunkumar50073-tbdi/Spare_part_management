"""Job work returns and ERP's RGPs (the store's spec of 27 Oct 2026: "Part
Return, Job Work Return & Pending RGP Integration").

A job work return (SpareReturnService.job_work_return) waits in the store, not
stock, for the returnable challan another store employee makes in ERP. In ERP a
spare goes out for job work / coating on a "General FOC" challan of exit type
RETURNABLE, made from the issue slip in the vendor's name (doc_no = the issue
slip no.) — never on the "Returnable Gate Pass (RGP)" type, which carries no
spare part (the store, 27 Oct 2026: "haan general foc returnable dikha de").
This service:
  * reads those challan lines of the store's spare parts, READ ONLY — from
    termsdb.challan_register (the RGP type too, should a spare ever go on one)
    — through the same ERP database login the GRN sync uses, and keeps them as
    ErpRgpLine, keyed by challan no. + item code, so reading again never makes
    a second line; a line no longer in that read and on no return is dropped
    (sync());
  * says, per job work return, where it stands — RGP Linked, RGP Available –
    Pending Match (unlinked lines of the same item made on / after the
    return), Pending RGP, or API Sync Failed when the last read failed;
  * links each waiting return to its challan by itself at every read (his
    pick, 27 Oct 2026: "Apne aap jode") — the first unlinked line of the same
    part made on / after the return, the same quantity first (auto_link()). A
    store person can unlink a wrong one and pick another (link()); a return a
    person has unlinked is never linked by itself again. One line belongs to
    one return (unique), the link names who (or "Auto") saved it.

Every challan line that carries the issue slip no. in doc_no — ERP took the
part out of its stock by that slip — leaves store stock too, as in ERP (the
store, 28 Oct 2026: "jab return hoga to us part ka stock user dept se main
store me add hoga phir supplier k naam par issue slip dalegi tab wo stock less
hoga"): a new part straight from the shelf, or a used one a job work return
took into the main store first (SpareReturnService.job_work_return, + stock).
A JOB_WORK_OUT ledger row, reference = the challan no.; the vendor's GRN brings
it back like any GRN (ErpGrnPostingService). Same switch and start date as the
GRN posting; never for a part not counted, or a challan on / before its count
(the count already holds it). A line cancelled in ERP or gone from it is put
back — unless a count since has taken it in (post_stock_out()).

RGP status (12 Nov 2026: "issue hokar jo bhi part ja rha h spare part store se
wo sabhi" - when each RGP was made, how many parts and qty, how much came back,
how much is pending and for how many days): every challan of this plant made
from an issue slip for a spare-store part, any party (rgp_summary()). What came
back is the party's GRN of the same part dated on / after the challan, the
oldest challan first - ERP's GRN carries no RGP no., so this is the app's match
until IT gives the RGP receiving detail. The GRNs are read with the challans,
from ERP's SRV register for those parties and parts, all dates (the GRN mirror
keeps only recent months), and kept in app_settings (RECEIPTS_KEY); the mirror
fills in any newer line.

The app never creates, edits, approves or cancels an RGP. When ERP cannot be
read, the returns and links stay as they are and the failure is shown (and
logged) with when the last good read was.
"""
import logging
import re
from datetime import date, datetime, timedelta

from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.base import utcnow
from app.models.job_work import ErpRgpLine, RgpReturnLink
from app.models.part import Part
from app.models.spare_flow import SpareReturn
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.utils.db_tx import atomic
from app.utils.exceptions import BadRequestError, NotFoundError

logger = logging.getLogger("dxstore.job_work")

RGP_TYPE = "Returnable Gate Pass (RGP)"
FOC_TYPE, RETURNABLE = "General FOC", "RETURNABLE"
SPARE_STORE = "MAINTENANCE"
SETTING_KEY = "erp_rgp_sync"
# The RGP parties' GRNs of the RGP parts, read with the challans (rgp_summary):
# {"read_at": iso, "grns": [[party, item, grn no., grn date, receipt qty], ...]}.
RECEIPTS_KEY = "erp_rgp_receipts"
_CHALLAN_UNIT = re.compile(r"^[A-Z]+(\d{3})/")
# Returns a store person unlinked: auto_link() leaves them to the person.
MANUAL_KEY = "erp_rgp_manual_returns"
AUTO_BY = "Auto (ERP challan)"
# A new part's move out of store stock on its challan (post_stock_out).
JOB_WORK_OUT = "JOB_WORK_OUT"
OUT_BY = "ERP-CHALLAN"
_ISSUE_SLIP = re.compile(r"IS\d+")
# The slip no. as ERP writes it in doc_no: 26-27/001IS7762.
_ISSUE_SLIP_FULL = re.compile(r"\d{2}-\d{2}/\d{3}IS\d+|IS\d+")
STOCK_STATES = {
    "OUT": "Taken out of store stock",
    "WILL_OUT": "Goes out of store stock at the next ERP read",
    "SHORT": "Check: store stock is less than the challan qty",
    "NO_SLIP": "No issue slip on the challan — stock not moved",
    "NOT_COUNTED": "Part never counted — stock not moved",
    "BEFORE_COUNT": "On / before the part's count — already in it",
    "BEFORE_FROM": "Before the auto-stock start date",
    "OFF": "Auto stock from ERP is switched off",
    "CANCELLED": "Cancelled in ERP",
    "NOT_IN_MASTER": "Not in the Part Master",
}
# An RGP made a day before the return is booked (the return written late) still matches.
DATE_SLACK = timedelta(days=1)
STATES = {
    "RGP_LINKED": "RGP Linked",
    "RGP_AVAILABLE": "RGP Available – Pending Match",
    "PENDING_RGP": "Pending RGP",
    "SYNC_FAILED": "API Sync Failed",
}
_SQL = ('SELECT id, challan_no, challan_dt, challan_type, party_cd, party_name, status, target_date, gate_exit_no, '
        'doc_no, item_cd, item_desc, uom, qty FROM "{schema}"."challan_register" '
        'WHERE ((challan_type = %s AND upper(exit_type) = %s) OR challan_type = %s) '
        'AND upper(trim(item_cd)) = ANY(%s)')


def _day(v):
    """ERP writes dates as text, DD-MM-YYYY (a real date is taken as it is)."""
    if v is None or isinstance(v, date):
        return v if not isinstance(v, datetime) else v.date()
    t = str(v).strip()
    for fmt in ("%d-%m-%Y", "%Y-%m-%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(t, fmt).date()
        except ValueError:
            pass
    return None


def _plant_challan(no):
    """True when a challan no. is this plant's: FO001/1714/26-27 is unit 10001,
    FO002/1/26-27 Plant 2. A number of another form is kept."""
    from app.utils.erp_unit import unit_segment
    m = _CHALLAN_UNIT.match((no or "").strip().upper())
    return m is None or m.group(1) == unit_segment()


def _num(v):
    try:
        return float(str(v).replace(",", "").strip()) if v not in (None, "") else None
    except ValueError:
        return None


def _txt(v, n):
    t = str(v).strip() if v is not None else ""
    return t[:n] or None


class JobWorkService:

    # ---- reading ERP -------------------------------------------------------------------------

    @staticmethod
    def _read_erp():
        """ERP's returnable challan lines of the store's spare parts as dicts —
        one read-only SELECT."""
        from flask import current_app
        import psycopg2.extras
        from app.services.erp_db_client import ERPDBClient
        codes = [c for (c,) in db.session.query(func.upper(func.trim(Part.part_no)))
                 .filter(Part.store_code == SPARE_STORE) if c]
        if not codes:
            return []
        conn = ERPDBClient()._connect()
        try:
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute(_SQL.format(schema=current_app.config.get("ERP_DB_SCHEMA", "termsdb")),
                        (FOC_TYPE, RETURNABLE, RGP_TYPE, codes))
            return [dict(r) for r in cur.fetchall()]
        finally:
            conn.close()

    @staticmethod
    def _read_returns(parties, items):
        """ERP's GRN lines of these parties and parts, all dates — one read-only
        SELECT on the SRV register: [[party, item, grn no., grn date, receipt qty]]."""
        if not parties or not items:
            return []
        from flask import current_app
        from app.services.erp_db_client import ERPDBClient
        conn = ERPDBClient()._connect()
        try:
            cur = conn.cursor()
            cur.execute(
                'SELECT vendor_cd, upper(trim(item_cd)), grn_no, grn_date, receipt_qty FROM "{s}"."srv_report" '
                "WHERE vendor_cd = ANY(%s) AND upper(trim(item_cd)) = ANY(%s)".format(
                    s=current_app.config.get("ERP_DB_SCHEMA", "termsdb")),
                (sorted(parties), sorted(items)))
            return [list(r) for r in cur.fetchall()]
        finally:
            conn.close()

    def _keep_returns(self, rows, grns=None):
        """Read and keep the GRNs of the parties and parts on issue-slip
        challans (rgp_summary). A failed read keeps the last good one."""
        parties = {_txt(r.get("party_cd"), 40) for r in rows if _ISSUE_SLIP.search(str(r.get("doc_no") or "").upper())}
        items = {(_txt(r.get("item_cd"), 40) or "").upper() for r in rows
                 if _ISSUE_SLIP.search(str(r.get("doc_no") or "").upper())}
        parties.discard(None)
        items.discard("")
        try:
            got = self._read_returns(parties, items) if grns is None else grns
        except Exception as exc:  # noqa: BLE001 — the challans still count; the old GRNs stay
            logger.warning("ERP RGP GRN read failed: %s: %s", type(exc).__name__, exc)
            return None
        keep = self._clean_returns(got)
        AppSetting.set_value(RECEIPTS_KEY, {"read_at": utcnow().isoformat(), "grns": keep}, "SYSTEM")
        return len(keep)

    @staticmethod
    def _clean_returns(got):
        """ERP's GRN rows as kept: [party, ITEM, grn no., ISO date, qty], blanks left out."""
        keep = []
        for party, item, grn_no, grn_date, qty in got:
            day = _day(grn_date)
            q = _num(qty)
            if not grn_no or day is None or not q:
                continue
            keep.append([str(party).strip(), str(item).strip().upper(), str(grn_no).strip(), day.isoformat(), q])
        return keep

    def sync(self, rows=None, grns=None):
        """Read ERP's challan lines and bring ErpRgpLine in line: new lines
        added, known ones updated (status, qty …), lines gone from the read and
        on no return dropped — never a second line for the same challan + item,
        never a link touched. Then waiting returns are linked (auto_link()).
        Returns the sync status; a failure is kept (with the last good time)
        and logged, not raised."""
        state = AppSetting.get_value(SETTING_KEY, {}) or {}
        try:
            from_erp = rows is None
            rows = self._read_erp() if from_erp else rows
            now = utcnow()
            known = {(l.challan_no, l.item_cd): l for l in ErpRgpLine.query.all()}
            added = updated = 0
            seen = set()
            with atomic():
                for r in rows:
                    key = (_txt(r.get("challan_no"), 40), _txt(r.get("item_cd"), 40))
                    if not all(key):
                        continue
                    seen.add(key)
                    want = {
                        "challan_date": _day(r.get("challan_dt")), "challan_type": _txt(r.get("challan_type"), 40),
                        "party_cd": _txt(r.get("party_cd"), 40), "party_name": _txt(r.get("party_name"), 160),
                        "item_desc": _txt(r.get("item_desc"), 255), "uom": _txt(r.get("uom"), 20),
                        "qty": _num(r.get("qty")), "status": (_txt(r.get("status"), 20) or "").upper() or None,
                        "target_date": _day(r.get("target_date")), "gate_exit_no": _txt(r.get("gate_exit_no"), 40),
                        "doc_no": _txt(r.get("doc_no"), 60), "erp_id": r.get("id"),
                    }
                    line = known.get(key)
                    if line is None:
                        line = ErpRgpLine(challan_no=key[0], item_cd=key[1], synced_at=now, **want)
                        db.session.add(line)
                        known[key] = line
                        added += 1
                        continue
                    if any((float(getattr(line, k)) if k == "qty" and getattr(line, k) is not None else getattr(line, k)) != v
                           for k, v in want.items()):
                        for k, v in want.items():
                            setattr(line, k, v)
                        updated += 1
                    line.synced_at = now
                # Out of scope now (the RGP type's non-spare lines read before
                # 27 Oct 2026) or gone from ERP: dropped unless a return holds it
                # (a new part's move out of stock is put back by post_stock_out).
                held = self._linked_ids()
                dropped = 0
                for key, line in known.items():
                    if key not in seen and line.id is not None and line.id not in held:
                        db.session.delete(line)
                        dropped += 1
            linked = self.auto_link()
            moved = self.post_stock_out()
            # Rows handed in (a test) read no GRNs from ERP unless they are handed in too.
            returns = self._keep_returns(rows, grns) if (from_erp or grns is not None) else None
            state = {**state, "ok": True, "last_ok_at": now.isoformat(), "last_error": None, "last_error_at": None,
                     "lines": len(rows), "added": added, "updated": updated, "dropped": dropped, "auto_linked": linked,
                     "stock_out": moved["out"], "stock_back": moved["back"], "rgp_grns": returns}
        except Exception as exc:  # noqa: BLE001 — ERP down, not set up, table renamed: shown, not fatal
            db.session.rollback()
            logger.warning("ERP RGP read failed: %s: %s", type(exc).__name__, exc)
            state = {**state, "ok": False, "last_error": f"{type(exc).__name__}: {str(exc)[:200]}",
                     "last_error_at": utcnow().isoformat()}
        AppSetting.set_value(SETTING_KEY, state, "SYSTEM")
        return self.status()

    def status(self):
        state = AppSetting.get_value(SETTING_KEY, {}) or {}
        return {"ok": state.get("ok"), "last_ok_at": state.get("last_ok_at"), "last_error": state.get("last_error"),
                "last_error_at": state.get("last_error_at"), "added": state.get("added"), "updated": state.get("updated"),
                "lines": ErpRgpLine.query.count(),
                "linked": RgpReturnLink.query.count(),
                "newest_rgp": _iso(db.session.query(func.max(ErpRgpLine.challan_date)).scalar())}

    def auto_link(self):
        """Link each waiting job work return (oldest first) to the first
        unlinked challan line of its part made on / after it — the same
        quantity first, then the earliest. A return a store person has unlinked
        is left to the person. Returns how many were linked."""
        manual = set(AppSetting.get_value(MANUAL_KEY, []) or [])
        done = {r for (r,) in db.session.query(RgpReturnLink.return_id)}
        waiting = (SpareReturn.query.filter(SpareReturn.return_type == "JOB_WORK_RETURN")
                   .order_by(SpareReturn.created_at.asc(), SpareReturn.id.asc()).all())
        linked = self._linked_ids()
        n = 0
        for ret in waiting:
            if ret.id in done or ret.id in manual or ret.part is None:
                continue
            qty = float(ret.qty)
            lines = self._suggest_query(ret, linked).all()
            if not lines:
                continue
            line = min(lines, key=lambda l: (l.qty is None or float(l.qty) != qty,
                                             l.challan_date or date.max, l.id))
            try:
                with atomic():
                    db.session.add(RgpReturnLink(return_id=ret.id, rgp_line_id=line.id, linked_by=AUTO_BY))
            except IntegrityError:
                db.session.rollback()
                continue
            linked.add(line.id)
            n += 1
            logger.info("Job work return %s linked by itself to challan %s · %s", ret.return_no, line.challan_no, line.item_cd)
        return n

    # ---- a new part out of store stock -------------------------------------------------------

    @staticmethod
    def _key(challan_no):
        return (challan_no or "").strip().upper()

    @classmethod
    def _out_so_far(cls, part_ids):
        """(part_id, CHALLAN NO.) -> (qty out of store stock now, plant date of
        the latest move) from the JOB_WORK_OUT rows."""
        if not part_ids:
            return {}
        from app.services.erp_grn_posting_service import _plant_date
        L = SpareStockLedger
        rows = (db.session.query(L.part_id, L.reference, func.sum(L.qty_delta), func.max(L.created_at))
                .filter(L.part_id.in_(part_ids), L.txn_type == JOB_WORK_OUT)
                .group_by(L.part_id, L.reference))
        out = {}
        for pid, ref, total, last in rows:
            key = (pid, cls._key(ref))
            qty, prev = out.get(key, (0.0, None))
            dates = [d for d in (prev, _plant_date(last)) if d]
            out[key] = (round(qty - float(total or 0), 2), max(dates) if dates else None)
        return out

    def _stock_plan(self):
        """What each challan line should have done to store stock, and what it
        has: [{line, part, state, want, have, last}] plus the moves left behind by
        lines no longer read ({line: None}). `want` None = leave as it is."""
        from app.services.erp_grn_posting_service import ErpGrnPostingService, _as_date
        grn = ErpGrnPostingService()
        cfg = grn.settings()
        from_date = _as_date(cfg.get("from_date"))
        lines = ErpRgpLine.query.all()
        # Only the parts a challan names, or that something already went out for.
        codes = {self._key(l.item_cd) for l in lines} or {""}
        moved_ids = {pid for (pid,) in db.session.query(SpareStockLedger.part_id)
                     .filter(SpareStockLedger.txn_type == JOB_WORK_OUT).distinct()}
        parts = {self._key(p.part_no): p for p in Part.query.filter(
            Part.store_code == SPARE_STORE,
            or_(func.upper(func.trim(Part.part_no)).in_(codes), Part.id.in_(moved_ids or {-1})))}
        part_ids = [p.id for p in parts.values()]
        base = grn._baseline(part_ids)
        done = self._out_so_far(part_ids)
        plan, seen = [], set()
        for l in lines:
            p = parts.get(self._key(l.item_cd))
            qty = float(l.qty or 0)
            want = None
            if p is None:
                state = "NOT_IN_MASTER"
            elif (l.status or "") == "CANCEL":
                state, want = "CANCELLED", 0.0
            elif not _ISSUE_SLIP.search((l.doc_no or "").upper()):
                state, want = "NO_SLIP", 0.0
            else:
                day, counted = base.get(p.id, (None, False))
                if not counted:
                    state = "NOT_COUNTED"
                elif day and l.challan_date and l.challan_date <= day:
                    state = "BEFORE_COUNT"
                elif from_date and l.challan_date and l.challan_date < from_date:
                    state = "BEFORE_FROM"
                elif not cfg.get("enabled"):
                    state = "OFF"
                else:
                    state, want = "OUT", qty
            have, last = done.get((p.id, self._key(l.challan_no)), (0.0, None)) if p else (0.0, None)
            if p is not None:
                seen.add((p.id, self._key(l.challan_no)))
            plan.append({"line": l, "part": p, "state": state, "want": want, "have": have, "last": last,
                         "counted_on": base.get(p.id, (None, False))[0] if p else None})
        by_id = {p.id: p for p in parts.values()}
        for (pid, key), (have, last) in done.items():
            if (pid, key) not in seen and have:
                plan.append({"line": None, "challan_no": key, "part": by_id.get(pid), "state": "GONE",
                             "want": 0.0, "have": have, "last": last, "counted_on": base.get(pid, (None, False))[0]})
        return plan

    def post_stock_out(self, user=OUT_BY):
        """Bring store stock in line with the challans: take a new part out
        (want > have), put back what should not be out (want < have) unless a
        count since the move has taken it in. Each part is its own transaction,
        re-read inside it. Store stock is never taken below zero: such a line
        waits as SHORT. Returns {"out": n, "back": n}."""
        moved = {"out": 0, "back": 0}
        for item in self._stock_plan():
            p, want, have = item["part"], item["want"], item["have"]
            if p is None or want is None:
                continue
            diff = round(want - have, 2)
            if diff == 0:
                continue
            if diff < 0 and item["last"] and item["counted_on"] and item["counted_on"] >= item["last"]:
                continue   # counted after it went out: the count holds it now
            l = item["line"]
            challan = l.challan_no if l is not None else item["challan_no"]
            try:
                with atomic():
                    first = SpareStock.query.filter_by(part_id=p.id).first()
                    if first is None:
                        continue
                    self.stock_svc._lock(SpareStock, first.id)
                    now_have = self._out_so_far([p.id]).get((p.id, self._key(challan)), (0.0, None))[0]
                    diff = round(want - now_have, 2)
                    row = SpareStock.query.filter_by(part_id=p.id).first()
                    on_hand = float(row.qty_on_hand or 0)
                    if diff == 0 or (diff > 0 and on_hand + 1e-9 < diff):
                        continue
                    if diff > 0:
                        why = (f"Sent for job work on ERP challan {challan}"
                               + (f" to {l.party_name}" if l is not None and l.party_name else "")
                               + (f" — issue slip {l.doc_no}" if l is not None and l.doc_no else ""))
                    else:
                        why = (f"Back to store stock: ERP challan {challan} "
                               + {"CANCELLED": "was cancelled in ERP",
                                  "NO_SLIP": "has no issue slip any more",
                                  "GONE": "is no longer in ERP"}.get(item["state"], "changed qty in ERP"))
                    self.stock_svc._write(p.id, round(on_hand - diff, 2), JOB_WORK_OUT,
                                          reference=_txt(challan, 80), remarks=why[:255], user=user)
                moved["out" if diff > 0 else "back"] += 1
            except BadRequestError as exc:   # e.g. stock held in labelled packets
                db.session.rollback()
                logger.info("Job work stock move for %s on %s left: %s", p.part_no, challan, exc)
        return moved

    @property
    def stock_svc(self):
        from app.services.spare_stock_service import SpareStockService
        return SpareStockService()

    # ---- the returns and their RGP ------------------------------------------------------------

    @staticmethod
    def _linked_ids():
        return {l for (l,) in db.session.query(RgpReturnLink.rgp_line_id)}

    @staticmethod
    def _suggest_query(ret, linked):
        part_no = (ret.part.part_no or "").strip().upper()
        since = (ret.created_at.date() if ret.created_at else date.today()) - DATE_SLACK
        q = ErpRgpLine.query.filter(func.upper(func.trim(ErpRgpLine.item_cd)) == part_no,
                                    or_(ErpRgpLine.status.is_(None), ErpRgpLine.status != "CANCEL"),
                                    or_(ErpRgpLine.challan_date.is_(None), ErpRgpLine.challan_date >= since))
        if linked:
            q = q.filter(~ErpRgpLine.id.in_(linked))
        return q

    def returns(self, store_code, state=None, q=None):
        """Job work returns, newest first, each with its RGP state, its link (if
        any) and how many RGP lines are suggested for it."""
        query = (SpareReturn.query.join(Part, Part.id == SpareReturn.part_id)
                 .filter(SpareReturn.store_code == store_code, SpareReturn.return_type == "JOB_WORK_RETURN"))
        text = (q or "").strip()
        if text:
            like = f"%{text}%"
            query = query.filter(or_(Part.part_no.ilike(like), Part.part_name.ilike(like),
                                     SpareReturn.return_no.ilike(like), SpareReturn.returned_by.ilike(like),
                                     SpareReturn.department.ilike(like)))
        rets = query.order_by(SpareReturn.created_at.desc(), SpareReturn.id.desc()).all()
        links = {l.return_id: l for l in RgpReturnLink.query.filter(
            RgpReturnLink.return_id.in_([r.id for r in rets] or [-1]))}
        linked = self._linked_ids()
        failed = (AppSetting.get_value(SETTING_KEY, {}) or {}).get("ok") is False
        out = []
        for r in rets:
            link = links.get(r.id)
            n = 0 if link else self._suggest_query(r, linked).count()
            st = "RGP_LINKED" if link else "RGP_AVAILABLE" if n else "SYNC_FAILED" if failed else "PENDING_RGP"
            if state and st != state:
                continue
            out.append({**self._return_dict(r), "state": st, "state_label": STATES[st], "suggested": n,
                        "link": self._link_dict(link)})
        return {"rows": out, "sync": self.status(),
                "counts": {k: sum(1 for x in out if x["state"] == k) for k in STATES}}

    def candidates(self, return_id, q=None):
        """The RGP lines to pick from for a job work return: the suggested ones
        (same item, not cancelled, made on / after the return, not linked to
        another return), and — with `q` — any unlinked RGP line by challan no.,
        item, description or party."""
        ret = self._job(return_id)
        linked = self._linked_ids()
        suggested = self._suggest_query(ret, linked).order_by(ErpRgpLine.challan_date.desc()).limit(50).all()
        found = []
        text = (q or "").strip()
        if text:
            like = f"%{text}%"
            found = (ErpRgpLine.query.filter(~ErpRgpLine.id.in_(linked or {-1}),
                                             or_(ErpRgpLine.status.is_(None), ErpRgpLine.status != "CANCEL"),
                                             or_(ErpRgpLine.challan_no.ilike(like), ErpRgpLine.item_cd.ilike(like),
                                                 ErpRgpLine.item_desc.ilike(like), ErpRgpLine.party_name.ilike(like)))
                     .order_by(ErpRgpLine.challan_date.desc()).limit(50).all())
        qty = float(ret.qty)
        return {"return": self._return_dict(ret),
                "suggested": [{**self._line_dict(l), "qty_matches": l.qty is not None and float(l.qty) == qty}
                              for l in suggested],
                "found": [self._line_dict(l) for l in found if l not in suggested],
                "sync": self.status()}

    def link(self, return_id, rgp_line_id, user=None):
        """Save the RGP line a store person picked for a job work return. Only
        then is the return RGP Linked."""
        ret = self._job(return_id)
        line = db.session.get(ErpRgpLine, rgp_line_id)
        if line is None:
            raise NotFoundError(f"RGP line {rgp_line_id} not found — refresh from ERP")
        if (line.status or "") == "CANCEL":
            raise BadRequestError(f"RGP {line.challan_no} is cancelled in ERP")
        if RgpReturnLink.query.filter_by(return_id=ret.id).first():
            raise BadRequestError(f"{ret.return_no} is already linked to an RGP — unlink it first")
        other = RgpReturnLink.query.filter_by(rgp_line_id=line.id).first()
        if other is not None:
            taken = db.session.get(SpareReturn, other.return_id)
            raise BadRequestError(f"RGP {line.challan_no} · {line.item_cd} is already linked to "
                                  f"{taken.return_no if taken else 'another return'}")
        try:
            with atomic():
                db.session.add(RgpReturnLink(return_id=ret.id, rgp_line_id=line.id, linked_by=_txt(user, 60)))
        except IntegrityError:
            db.session.rollback()
            raise BadRequestError("That RGP or this return was just linked from another screen") from None
        self.post_stock_out()      # a line taken out as a new part goes back at once
        return {**self._return_dict(ret), "link": self._link_dict(RgpReturnLink.query.filter_by(return_id=ret.id).first())}

    def unlink(self, return_id, user=None):
        ret = self._job(return_id)
        link = RgpReturnLink.query.filter_by(return_id=ret.id).first()
        if link is None:
            raise BadRequestError(f"{ret.return_no} is not linked to an RGP")
        with atomic():
            logger.info("RGP link of %s to %s removed by %s", ret.return_no, link.rgp.challan_no if link.rgp else "?", user)
            db.session.delete(link)
        # From now on this return is the person's to link, never auto_link()'s.
        manual = list(AppSetting.get_value(MANUAL_KEY, []) or [])
        if ret.id not in manual:
            AppSetting.set_value(MANUAL_KEY, manual + [ret.id], _txt(user, 60) or "STORE")
        self.post_stock_out()      # the line is a new part's now, if it has an issue slip
        return self._return_dict(ret)

    def lines(self, q=None, limit=200):
        """ERP's RGP lines as last read, newest first, each with the return it is linked to."""
        query = ErpRgpLine.query
        text = (q or "").strip()
        if text:
            like = f"%{text}%"
            query = query.filter(or_(ErpRgpLine.challan_no.ilike(like), ErpRgpLine.item_cd.ilike(like),
                                     ErpRgpLine.item_desc.ilike(like), ErpRgpLine.party_name.ilike(like)))
        rows = query.order_by(ErpRgpLine.challan_date.desc().nullslast(), ErpRgpLine.id.desc()).limit(limit).all()
        links = {l.rgp_line_id: l for l in RgpReturnLink.query.filter(
            RgpReturnLink.rgp_line_id.in_([r.id for r in rows] or [-1]))}
        rets = {r.id: r.return_no for r in SpareReturn.query.filter(
            SpareReturn.id.in_([l.return_id for l in links.values()] or [-1]))}
        stock = {}
        for item in self._stock_plan():
            if item["line"] is None:
                continue
            state = item["state"]
            if state == "OUT" and item["have"] < (item["want"] or 0):
                on_hand = (SpareStock.query.filter_by(part_id=item["part"].id).with_entities(SpareStock.qty_on_hand)
                           .scalar() or 0)
                state = "SHORT" if float(on_hand) + 1e-9 < item["want"] - item["have"] else "WILL_OUT"
            stock[item["line"].id] = {"stock_state": state, "stock_label": STOCK_STATES.get(state, state),
                                      "stock_out_qty": item["have"]}
        return {"rows": [{**self._line_dict(r), **stock.get(r.id, {}),
                          "linked_return": rets.get(links[r.id].return_id) if r.id in links else None}
                         for r in rows], "sync": self.status()}

    # ---- RGP status (12 Nov 2026) ------------------------------------------------------------

    def _returns(self, lines=()):
        """{(party, ITEM): [[grn no., grn date, qty], ...]} oldest first — the GRNs
        kept with the last RGP read, plus any newer line of the GRN mirror.
        Before any read was kept (a machine whose ERP read has not run this
        code yet), ERP is read here for `lines`' parties and parts — read only,
        nothing saved — so old RGPs do not show as pending."""
        from app.models.receiving_register import ReceivingRegister
        saved = AppSetting.get_value(RECEIPTS_KEY, {}) or {}
        seen, pool = set(), {}
        rows = [tuple(g) for g in (saved.get("grns") or []) if len(g) == 5]
        if not saved.get("read_at") and lines:
            try:
                got = self._read_returns({(l.party_cd or "").strip() for l in lines} - {""},
                                         {(l.item_cd or "").strip().upper() for l in lines} - {""})
                rows += [tuple(g) for g in self._clean_returns(got)]
                saved = {"read_at": utcnow().isoformat()}
            except Exception as exc:  # noqa: BLE001 — ERP not reachable: the mirror alone
                logger.warning("ERP RGP GRN read for the RGP status failed: %s: %s", type(exc).__name__, exc)
        for r in ReceivingRegister.query.filter(ReceivingRegister.ven_cd.isnot(None)).with_entities(
                ReceivingRegister.ven_cd, ReceivingRegister.item_cd, ReceivingRegister.grn_no,
                ReceivingRegister.grn_date, ReceivingRegister.receipt_qty):
            if r[2] and r[3] and r[4]:
                rows.append((r[0].strip(), (r[1] or "").strip().upper(), r[2].strip(), r[3].isoformat(), float(r[4])))
        for party, item, grn_no, day, qty in rows:
            key = (party, item, grn_no.upper())
            if key in seen:
                continue
            seen.add(key)
            pool.setdefault((party, item), []).append([grn_no, date.fromisoformat(str(day)[:10]), float(qty)])
        for grns in pool.values():
            grns.sort(key=lambda g: (g[1], g[0]))
        return pool, saved.get("read_at")

    def rgp_summary(self, today=None):
        """Every RGP of this plant made from an issue slip for a spare-store
        part, any party: when made, parts, qty sent, qty back on the party's
        GRNs (matched, oldest challan first), pending, days open — each with its
        lines and the GRNs matched to them. Open RGPs first, oldest first."""
        from app.services.erp_grn_posting_service import _plant_date
        today = today or _plant_date(utcnow())
        spare = {(c or "").upper(): (pid, name) for c, pid, name in db.session.query(
            func.upper(func.trim(Part.part_no)), Part.id, Part.part_name).filter(Part.store_code == SPARE_STORE)}
        lines = [l for l in ErpRgpLine.query.all()
                 if (l.status or "") != "CANCEL" and _ISSUE_SLIP.search((l.doc_no or "").upper())
                 and (l.item_cd or "").strip().upper() in spare and _plant_challan(l.challan_no)]
        lines.sort(key=lambda l: (l.challan_date or date.min, l.challan_no or "", l.id))
        pool, read_at = self._returns(lines)
        left = {k: [list(g) for g in v] for k, v in pool.items()}
        rgps = {}
        for l in lines:
            item = l.item_cd.strip().upper()
            sent = float(l.qty or 0)
            need, got = sent, []
            for g in left.get(((l.party_cd or "").strip(), item), []):
                if need <= 1e-9:
                    break
                if g[2] <= 1e-9 or (l.challan_date and g[1] < l.challan_date):
                    continue
                take = round(min(need, g[2]), 2)
                g[2] = round(g[2] - take, 2)
                need = round(need - take, 2)
                got.append({"grn_no": g[0], "grn_date": g[1].isoformat(), "qty": take})
            back = round(sent - need, 2)
            rgp = rgps.setdefault(l.challan_no, {
                "challan_no": l.challan_no, "challan_date": _iso(l.challan_date), "party_cd": l.party_cd,
                "party_name": l.party_name, "issue_slips": [], "gate_status": l.status, "lines": []})
            slip = _ISSUE_SLIP_FULL.search((l.doc_no or "").upper())
            slip = slip.group(0) if slip else l.doc_no
            if slip and slip not in rgp["issue_slips"]:
                rgp["issue_slips"].append(slip)
            rgp["lines"].append({"part_id": spare[item][0], "part_no": l.item_cd, "part_name": spare[item][1] or l.item_desc,
                                 "uom": l.uom, "qty": sent, "back": back, "pending": round(need, 2), "grns": got})
        out = []
        for rgp in rgps.values():
            sent = round(sum(x["qty"] for x in rgp["lines"]), 2)
            back = round(sum(x["back"] for x in rgp["lines"]), 2)
            pending = round(sent - back, 2)
            day = date.fromisoformat(rgp["challan_date"]) if rgp["challan_date"] else None
            last = max((g["grn_date"] for x in rgp["lines"] for g in x["grns"]), default=None)
            state = "CLOSED" if pending <= 1e-9 else ("PART_BACK" if back > 0 else "OPEN")
            rgp.update({"parts": len(rgp["lines"]), "qty": sent, "back": back, "pending": pending, "state": state,
                        "last_return": last,
                        "days_open": (today - day).days if (day and state != "CLOSED") else None,
                        "days_taken": ((date.fromisoformat(last) - day).days if (day and last and state == "CLOSED")
                                       else None)})
            out.append(rgp)
        # Open ones first, the oldest on top; then the closed ones, newest first.
        waiting = sorted((r for r in out if r["state"] != "CLOSED"), key=lambda r: (r["challan_date"] or "", r["challan_no"]))
        closed = sorted((r for r in out if r["state"] == "CLOSED"), key=lambda r: (r["challan_date"] or "", r["challan_no"]),
                        reverse=True)
        out = waiting + closed
        parties = {}
        for r in out:
            p = parties.setdefault(r["party_cd"], {"party_cd": r["party_cd"], "party_name": r["party_name"],
                                                   "rgps": 0, "open": 0, "qty": 0.0, "back": 0.0, "pending": 0.0})
            p["rgps"] += 1
            p["open"] += r["state"] != "CLOSED"
            p["qty"] = round(p["qty"] + r["qty"], 2)
            p["back"] = round(p["back"] + r["back"], 2)
            p["pending"] = round(p["pending"] + r["pending"], 2)
        open_ = [r for r in out if r["state"] != "CLOSED"]
        return {"rows": out,
                "parties": sorted(parties.values(), key=lambda p: (-p["open"], -p["rgps"], p["party_name"] or "")),
                "totals": {"rgps": len(out), "open": len(open_), "pending_qty": round(sum(r["pending"] for r in open_), 2),
                           "oldest_days": max((r["days_open"] for r in open_), default=None)},
                "grns_read_at": read_at, "today": today.isoformat(), "sync": self.status()}

    # ---- shapes ---------------------------------------------------------------------------------

    @staticmethod
    def _job(return_id):
        ret = db.session.get(SpareReturn, return_id)
        if ret is None:
            raise NotFoundError(f"Return {return_id} not found")
        if ret.return_type != "JOB_WORK_RETURN":
            raise BadRequestError(f"{ret.return_no} is not a job work return")
        return ret

    @staticmethod
    def _return_dict(r):
        part, issue = r.part, r.issue
        return {"id": r.id, "return_no": r.return_no, "part_id": r.part_id,
                "part_no": part.part_no if part else None, "part_name": part.part_name if part else None,
                "uom": part.uom if part else None, "qty": float(r.qty), "reason": r.reason, "remarks": r.remarks,
                "returned_by": r.returned_by, "received_by": r.received_by, "department": r.department,
                "issued_to": r.issued_to, "issue_id": r.issue_id,
                "issue_date": _iso(issue.created_at) if issue else None,
                "issued_qty": abs(float(issue.qty_delta)) if issue else None,
                "identified_by": r.identified_by, "scanned_code": r.scanned_code, "created_at": _iso(r.created_at)}

    @staticmethod
    def _line_dict(l):
        return {"id": l.id, "challan_no": l.challan_no, "challan_date": _iso(l.challan_date), "item_cd": l.item_cd,
                "item_desc": l.item_desc, "uom": l.uom, "qty": float(l.qty) if l.qty is not None else None,
                "party_name": l.party_name, "status": l.status, "target_date": _iso(l.target_date),
                "gate_exit_no": l.gate_exit_no, "doc_no": l.doc_no, "synced_at": _iso(l.synced_at)}

    def _link_dict(self, link):
        if link is None:
            return None
        return {"rgp": self._line_dict(link.rgp), "linked_by": link.linked_by, "linked_at": _iso(link.created_at)}


def _iso(v):
    return v.isoformat() if v is not None else None
