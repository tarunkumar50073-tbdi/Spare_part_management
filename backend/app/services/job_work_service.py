"""Job work returns and ERP's RGPs (the store's spec of 27 Oct 2026: "Part
Return, Job Work Return & Pending RGP Integration").

A job work return (SpareReturnService.job_work_return) waits in the store, not
stock, for the RGP another store employee makes in ERP. This service:
  * reads ERP's RGP lines, READ ONLY — termsdb.challan_register rows of
    challan_type "Returnable Gate Pass (RGP)" (the store chose that type only,
    not "Job Work (Tooling)") — through the same ERP database login the GRN
    sync uses, and keeps them as ErpRgpLine, keyed by challan no. + item code,
    so reading again never makes a second line (sync());
  * says, per job work return, where it stands — RGP Linked, RGP Available –
    Pending Match (unlinked RGP lines of the same item made on / after the
    return), Pending RGP, or API Sync Failed when the last read failed;
  * links the RGP line a store person picks to the return (link()), never by
    itself: ERP's RGP carries no reference to the return, and none of today's
    RGP item codes is a spare Part No., so the suggestion is only a suggestion.
    One RGP line belongs to one return (unique), the link names who saved it.

The app never creates, edits, approves or cancels an RGP. When ERP cannot be
read, the returns and links stay as they are and the failure is shown (and
logged) with when the last good read was.
"""
import logging
from datetime import date, datetime, timedelta

from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.base import utcnow
from app.models.job_work import ErpRgpLine, RgpReturnLink
from app.models.part import Part
from app.models.spare_flow import SpareReturn
from app.utils.db_tx import atomic
from app.utils.exceptions import BadRequestError, NotFoundError

logger = logging.getLogger("dxstore.job_work")

RGP_TYPE = "Returnable Gate Pass (RGP)"
SETTING_KEY = "erp_rgp_sync"
# An RGP made a day before the return is booked (the return written late) still matches.
DATE_SLACK = timedelta(days=1)
STATES = {
    "RGP_LINKED": "RGP Linked",
    "RGP_AVAILABLE": "RGP Available – Pending Match",
    "PENDING_RGP": "Pending RGP",
    "SYNC_FAILED": "API Sync Failed",
}
_SQL = ('SELECT id, challan_no, challan_dt, challan_type, party_cd, party_name, status, target_date, gate_exit_no, '
        'doc_no, item_cd, item_desc, uom, qty FROM "{schema}"."challan_register" WHERE challan_type = %s')


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
        """ERP's RGP lines as dicts — one read-only SELECT."""
        from flask import current_app
        import psycopg2.extras
        from app.services.erp_db_client import ERPDBClient
        conn = ERPDBClient()._connect()
        try:
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute(_SQL.format(schema=current_app.config.get("ERP_DB_SCHEMA", "termsdb")), (RGP_TYPE,))
            return [dict(r) for r in cur.fetchall()]
        finally:
            conn.close()

    def sync(self, rows=None):
        """Read ERP's RGP lines and bring ErpRgpLine in line: new lines added,
        known ones updated (status, qty …) — never a second line for the same
        challan + item, never a link touched. Returns the sync status; a
        failure is kept (with the last good time) and logged, not raised."""
        state = AppSetting.get_value(SETTING_KEY, {}) or {}
        try:
            rows = self._read_erp() if rows is None else rows
            now = utcnow()
            known = {(l.challan_no, l.item_cd): l for l in ErpRgpLine.query.all()}
            added = updated = 0
            with atomic():
                for r in rows:
                    key = (_txt(r.get("challan_no"), 40), _txt(r.get("item_cd"), 40))
                    if not all(key):
                        continue
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
            state = {**state, "ok": True, "last_ok_at": now.isoformat(), "last_error": None, "last_error_at": None,
                     "lines": len(rows), "added": added, "updated": updated}
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
        return {**self._return_dict(ret), "link": self._link_dict(RgpReturnLink.query.filter_by(return_id=ret.id).first())}

    def unlink(self, return_id, user=None):
        ret = self._job(return_id)
        link = RgpReturnLink.query.filter_by(return_id=ret.id).first()
        if link is None:
            raise BadRequestError(f"{ret.return_no} is not linked to an RGP")
        with atomic():
            logger.info("RGP link of %s to %s removed by %s", ret.return_no, link.rgp.challan_no if link.rgp else "?", user)
            db.session.delete(link)
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
        return {"rows": [{**self._line_dict(r), "linked_return": rets.get(links[r.id].return_id) if r.id in links else None}
                         for r in rows], "sync": self.status()}

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
