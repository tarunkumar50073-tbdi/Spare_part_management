"""Quarterly physical inventory (the 15 Nov 2026 spec): plan a section's count,
take ERP's stock as a dated snapshot, count the shelf, reconcile, approve, lock.

Rules the spec set and the store chose (15 Nov 2026):
- ERP qty only from ERP (the app's own erp_stock read, every 2 min) or an
  approved ERP Excel; physical qty only from counting; the app's own stock is
  NOT read and NOT changed ("App stock mat chhuo").
- A count never copies ERP's figure. A part already counted is not counted
  again unless a supervisor allows a recount.
- After the manager's approval the result is frozen; a later correction is a
  new revision with its own approval line, the original stays.
- Accuracy % = matched parts / counted parts (part-count accuracy); the
  quantity difference is reported apart from it.
"""
import io
import re
from collections import defaultdict
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from sqlalchemy import func

from app.extensions import db
from app.models.base import utcnow
from app.models.erp_stock import ERPStock
from app.models.inventory_count import (
    QUARTERS, InventoryAudit, InventoryCount, InventoryResult, InventorySession,
    InventorySnapshotLine,
)
from app.models.part import Part
from app.models.store import Section
from app.utils.db_tx import atomic
from app.utils.exceptions import BadRequestError, NotFoundError

STATUS_WORD = {"PLANNED": "Planned", "IN_PROGRESS": "In Progress", "RECON_PENDING": "Reconciliation Pending",
               "COMPLETED": "Completed"}
_FY = re.compile(r"^(\d{4})-(\d{2})$")


def fiscal_year_of(day):
    """April–March: 15 Nov 2026 is in 2026-27."""
    start = day.year if day.month >= 4 else day.year - 1
    return f"{start}-{str(start + 1)[-2:]}"


def quarter_of(day):
    return QUARTERS[((day.month - 4) % 12) // 3]


def _n(v):
    if v is None:
        return None
    f = float(v)
    return int(f) if f == int(f) else round(f, 3)


def _qty(value, label="Quantity"):
    try:
        q = Decimal(str(value).strip())
    except (InvalidOperation, AttributeError):
        raise BadRequestError(f"{label} must be a number")
    if not q.is_finite() or q < 0:
        raise BadRequestError(f"{label} must be 0 or more")
    if q > Decimal("99999999"):
        raise BadRequestError(f"{label} is too large")
    return q


def _text(value, limit):
    t = str(value).strip() if value is not None else ""
    return t[:limit] or None


WHOLE_STORE = "All sections"


def scope_name(s):
    """What a session counts: its section, or the whole store."""
    return s.section.name if s.section else WHOLE_STORE


def _who(user):
    return (str(user) if user else "SYSTEM")[:60]


def _date(value, label):
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value).strip()[:10])
    except ValueError:
        raise BadRequestError(f"{label} must be a date (YYYY-MM-DD)")


def status_of(erp_qty, physical_qty):
    if physical_qty is None:
        return "NOT_COUNTED"
    erp = Decimal(str(erp_qty or 0))
    phy = Decimal(str(physical_qty))
    if phy == erp:
        return "MATCH"
    return "SHORT" if phy < erp else "EXCESS"


def summarize(rows):
    """The spec's totals over reconciliation rows (dicts with erp_qty,
    physical_qty, variance_qty, status, rate)."""
    total = len(rows)
    counted = [r for r in rows if r["status"] != "NOT_COUNTED"]
    by = defaultdict(int)
    for r in rows:
        by[r["status"]] += 1
    short_qty = sum(-(r["variance_qty"] or 0) for r in counted if r["status"] == "SHORT")
    excess_qty = sum(r["variance_qty"] or 0 for r in counted if r["status"] == "EXCESS")
    erp_total = sum(r["erp_qty"] or 0 for r in rows)
    phy_total = sum(r["physical_qty"] or 0 for r in counted)
    short_value = sum(-(r["variance_qty"] or 0) * (r["rate"] or 0) for r in counted if r["status"] == "SHORT")
    excess_value = sum((r["variance_qty"] or 0) * (r["rate"] or 0) for r in counted if r["status"] == "EXCESS")
    return {
        "total_parts": total, "counted_parts": len(counted), "matched_parts": by["MATCH"],
        "shortage_parts": by["SHORT"], "excess_parts": by["EXCESS"], "not_counted_parts": by["NOT_COUNTED"],
        "variance_parts": by["SHORT"] + by["EXCESS"],
        "erp_qty": _n(erp_total), "physical_qty": _n(phy_total),
        # Counted parts only: an uncounted part is not a shortage.
        "net_difference_qty": _n(sum(r["variance_qty"] or 0 for r in counted)),
        "shortage_qty": _n(short_qty), "excess_qty": _n(excess_qty),
        "shortage_value": round(short_value, 2), "excess_value": round(excess_value, 2),
        "completion_pct": round(len(counted) / total * 100, 1) if total else 0.0,
        "accuracy_pct": round(by["MATCH"] / len(counted) * 100, 1) if counted else None,
    }


class InventoryCountService:
    # ---- sessions ---------------------------------------------------------------------------------
    def _session(self, session_id, store_code=None):
        s = db.session.get(InventorySession, int(session_id)) if str(session_id).isdigit() else None
        if s is None or (store_code and s.store_code != store_code):
            raise NotFoundError(f"Inventory session {session_id} not found")
        return s

    def session_dict(self, s, with_summary=True):
        out = {
            "id": s.id, "store_code": s.store_code, "fiscal_year": s.fiscal_year, "quarter": s.quarter,
            "section_id": s.section_id, "section": scope_name(s), "whole_store": s.section_id is None,
            "attempt": s.attempt, "duplicate_reason": s.duplicate_reason,
            "start_date": s.start_date.isoformat(), "close_date": s.close_date.isoformat(),
            "status": s.status, "status_label": STATUS_WORD[s.status], "remarks": s.remarks,
            "planned_by": s.planned_by,
            "snapshot_at": s.snapshot_at.isoformat() if s.snapshot_at else None,
            "snapshot_erp_as_of": s.snapshot_erp_as_of.isoformat() if s.snapshot_erp_as_of else None,
            "snapshot_source": s.snapshot_source, "snapshot_file": s.snapshot_file, "snapshot_by": s.snapshot_by,
            "submitted_at": s.submitted_at.isoformat() if s.submitted_at else None, "submitted_by": s.submitted_by,
            "approved_at": s.approved_at.isoformat() if s.approved_at else None, "approved_by": s.approved_by,
            "revision": s.revision, "locked": s.status == "COMPLETED",
        }
        if with_summary:
            out["summary"] = summarize(self.reconcile(s)) if s.status != "PLANNED" else None
        return out

    def sessions(self, store_code, fiscal_year=None, quarter=None):
        q = InventorySession.query.filter_by(store_code=store_code)
        if fiscal_year:
            q = q.filter_by(fiscal_year=fiscal_year)
        if quarter:
            q = q.filter_by(quarter=quarter)
        rows = q.order_by(InventorySession.fiscal_year.desc(), InventorySession.quarter.desc(),
                          InventorySession.id.desc()).all()
        return [self.session_dict(s) for s in rows]

    def plan(self, store_code, fiscal_year, quarter, section_id, start_date, close_date, user,
             remarks=None, duplicate_reason=None):
        fy = (fiscal_year or "").strip()
        m = _FY.match(fy)
        if not m or int(m.group(2)) != (int(m.group(1)) + 1) % 100:
            raise BadRequestError("Financial year must look like 2026-27")
        if quarter not in QUARTERS:
            raise BadRequestError("Quarter must be Q1, Q2, Q3 or Q4")
        section = None
        if str(section_id or "").strip() not in ("", "0", "None", "null"):
            section = db.session.get(Section, int(section_id)) if str(section_id).isdigit() else None
            if section is None or section.store.code != store_code:
                raise BadRequestError("Pick a section of this store, or the whole store")
        start, close = _date(start_date, "Start date"), _date(close_date, "Closing date")
        if close < start:
            raise BadRequestError("Closing date cannot be before the start date")
        # The whole store overlaps every section, and a section overlaps the whole store.
        q = InventorySession.query.filter_by(store_code=store_code, fiscal_year=fy, quarter=quarter)
        if section is not None:
            q = q.filter((InventorySession.section_id == section.id) | InventorySession.section_id.is_(None))
        earlier = q.order_by(InventorySession.attempt.desc()).first()
        reason = _text(duplicate_reason, 255)
        if earlier is not None and not reason:
            raise BadRequestError(
                f"{quarter} {fy} already has an inventory covering this ({scope_name(earlier)}, "
                f"{STATUS_WORD[earlier.status]}) — a second one needs a reason")
        with atomic():
            s = InventorySession(store_code=store_code, fiscal_year=fy, quarter=quarter,
                                 section_id=section.id if section else None,
                                 attempt=(earlier.attempt + 1) if earlier else 1,
                                 duplicate_reason=reason if earlier else None,
                                 start_date=start, close_date=close, status="PLANNED",
                                 remarks=_text(remarks, 255), planned_by=_who(user))
            db.session.add(s)
            db.session.flush()
            self._approval(s, "PLAN", user, reason if earlier else None)
        return self.session_dict(s)

    def update_plan(self, session_id, store_code, user, start_date=None, close_date=None, remarks=None):
        s = self._session(session_id, store_code)
        if s.status == "COMPLETED":
            raise BadRequestError("This inventory is approved and locked")
        start = _date(start_date, "Start date") if start_date else s.start_date
        close = _date(close_date, "Closing date") if close_date else s.close_date
        if close < start:
            raise BadRequestError("Closing date cannot be before the start date")
        with atomic():
            s.start_date, s.close_date = start, close
            if remarks is not None:
                s.remarks = _text(remarks, 255)
        return self.session_dict(s)

    def delete_planned(self, session_id, store_code, user):
        s = self._session(session_id, store_code)
        if s.status != "PLANNED":
            raise BadRequestError("Only a planned inventory (not started) can be removed")
        with atomic():
            InventoryAudit.query.filter_by(session_id=s.id).delete()
            db.session.delete(s)
        return {"deleted": s.id}

    def _approval(self, s, action, user, remarks=None):
        db.session.add(InventoryAudit(session_id=s.id, action=action, by=_who(user), at=utcnow(),
                                      revision=s.revision or 0, remarks=_text(remarks, 255)))

    def _audit(self, s, action, user, part_id=None, old=None, new=None, remarks=None):
        db.session.add(InventoryAudit(session_id=s.id, part_id=part_id, action=action, old_qty=old, new_qty=new,
                                      by=_who(user), at=utcnow(), revision=s.revision or 0,
                                      remarks=_text(remarks, 255)))

    # ---- ERP snapshot ------------------------------------------------------------------------------
    def _section_parts(self, s):
        q = Part.query.filter(Part.store_code == s.store_code, Part.is_active.is_(True))
        if s.section_id is not None:
            q = q.filter(Part.section_id == s.section_id)
        return q.order_by(Part.part_no).all()

    def _line(self, s, part, erp_qty):
        return InventorySnapshotLine(
            session_id=s.id, part_id=part.id, part_no=part.part_no, item_description=part.part_name,
            uom=part.uom, section_name=part.section.name if part.section else None,
            category=part.sub_category, location=part.location, erp_qty=erp_qty, rate=part.unit_price)

    def start(self, session_id, store_code, user):
        """Take ERP's stock of every active part of the section as it stands now
        (the app's erp_stock, read from ERP every 2 min) and open counting."""
        s = self._session(session_id, store_code)
        if s.status != "PLANNED":
            raise BadRequestError("This inventory has already started")
        parts = self._section_parts(s)
        if not parts:
            raise BadRequestError(f"{scope_name(s)}: no active parts in the Part Master")
        erp = {r.part_id: r for r in ERPStock.query.filter(ERPStock.part_id.in_([p.id for p in parts])).all()}
        if not erp:
            raise BadRequestError("ERP stock has not been read for this section — upload ERP's stock Excel instead")
        with atomic():
            for p in parts:
                row = erp.get(p.id)
                db.session.add(self._line(s, p, row.qty_on_hand if row else None))
            s.snapshot_at = utcnow()
            s.snapshot_erp_as_of = max(r.synced_at for r in erp.values())
            s.snapshot_source, s.snapshot_by = "ERP_DB", _who(user)
            s.status = "IN_PROGRESS"
            self._approval(s, "START", user, f"ERP snapshot of {len(parts)} parts ({len(erp)} with an ERP figure)")
            self._audit(s, "SNAPSHOT", user, remarks=f"ERP_DB · {len(parts)} parts")
        return self.session_dict(s)

    ERP_ALIASES = {
        "part_no": ("partno", "partnumber", "itemcode", "itemcd", "materialcode", "item"),
        "erp_qty": ("closingstock", "closingqty", "erpqty", "erpstock", "erpquantity", "stock", "stockqty",
                    "currentstock", "qty", "quantity", "balanceqty"),
    }

    def start_from_excel(self, session_id, store_code, file_stream, filename, user):
        """Start with ERP's stock from an ERP stock Excel (Part No + closing
        qty). A section part the file does not have gets no ERP figure."""
        from openpyxl import load_workbook
        s = self._session(session_id, store_code)
        if s.status != "PLANNED":
            raise BadRequestError("This inventory has already started")
        try:
            ws = load_workbook(io.BytesIO(file_stream.read()), read_only=True, data_only=True).active
        except Exception:
            raise BadRequestError("The file is not an Excel workbook (.xlsx)")
        norm = lambda v: re.sub(r"[^a-z0-9]", "", str(v or "").lower())
        rows = ws.iter_rows(values_only=True)
        cols, header_at = None, 0
        for header_at, head in enumerate(rows, 1):
            names = [norm(h) for h in head]
            found = {}
            for key, aliases in self.ERP_ALIASES.items():
                for a in aliases:
                    hit = next((i for i, n in enumerate(names) if n == a or (len(a) > 4 and n.startswith(a))), None)
                    if hit is not None:
                        found[key] = hit
                        break
            if len(found) == 2:
                cols = found
                break
            if header_at >= 15:
                break
        if cols is None:
            raise BadRequestError("Could not find the Part No and stock columns in the first 15 rows")
        figures, bad = {}, 0
        for r in rows:
            pn = str(r[cols["part_no"]] or "").strip().upper() if len(r) > cols["part_no"] else ""
            if not pn:
                continue
            try:
                figures[pn] = figures.get(pn, Decimal(0)) + _qty(r[cols["erp_qty"]] or 0, "Stock")
            except BadRequestError:
                bad += 1
        parts = self._section_parts(s)
        if not parts:
            raise BadRequestError(f"{scope_name(s)}: no active parts in the Part Master")
        with atomic():
            hit = 0
            for p in parts:
                q = figures.get(p.part_no.strip().upper())
                hit += q is not None
                db.session.add(self._line(s, p, q))
            s.snapshot_at = utcnow()
            s.snapshot_source, s.snapshot_by = "EXCEL", _who(user)
            s.snapshot_file = _text(filename, 150)
            s.status = "IN_PROGRESS"
            self._approval(s, "START", user, f"ERP Excel {filename}: {hit} of {len(parts)} parts found"
                                             + (f", {bad} rows unreadable" if bad else ""))
            self._audit(s, "SNAPSHOT", user, remarks=f"EXCEL {filename}")
        return self.session_dict(s)

    # ---- counting -----------------------------------------------------------------------------------
    def _latest(self, session_id, part_id):
        return (InventoryCount.query.filter_by(session_id=session_id, part_id=part_id)
                .order_by(InventoryCount.seq.desc()).first())

    def find_part(self, s, code, user=None):
        """A scanned or typed code -> the part (Part No, a TB label code, a
        supplier QR mapped to the part)."""
        from app.services.barcode_service import BarcodeService
        text = (code or "").strip()
        if not text:
            raise BadRequestError("Scan a QR or type a Part No")
        part = Part.query.filter(func.upper(Part.part_no) == text.upper(), Part.store_code == s.store_code).first()
        if part is None:
            try:
                hit = BarcodeService().resolve(s.store_code, text, "MANUAL_ENTRY", "LOOKUP", user=user)
            except (BadRequestError, NotFoundError):
                hit = None
            pid = (hit or {}).get("part_id") or ((hit or {}).get("part") or {}).get("id")
            pn = (hit or {}).get("part_no")
            part = (db.session.get(Part, pid) if pid else
                    Part.query.filter_by(part_no=pn, store_code=s.store_code).first() if pn else None)
        if part is None:
            raise NotFoundError(f"No part of this store for '{text}'")
        return part

    def line(self, session_id, store_code, code=None, part_id=None, user=None):
        """What the counting screen shows for one part: snapshot figure and its
        count so far. ERP qty is shown for reference, never filled in."""
        s = self._session(session_id, store_code)
        part = db.session.get(Part, int(part_id)) if part_id else self.find_part(s, code, user)
        if part is None or part.store_code != s.store_code:
            raise NotFoundError("Part not found in this store")
        snap = InventorySnapshotLine.query.filter_by(session_id=s.id, part_id=part.id).first()
        latest = self._latest(s.id, part.id)
        return {
            "part_id": part.id, "part_no": part.part_no, "item_description": part.part_name, "uom": part.uom,
            "location": (latest.location if latest else None) or (snap.location if snap else part.location),
            "in_snapshot": snap is not None,
            "other_section": snap is None and s.section_id is not None and part.section_id != s.section_id,
            "erp_qty": _n(snap.erp_qty) if snap else None,
            "count": self._count_dict(latest) if latest else None,
            "can_count": s.status == "IN_PROGRESS" and (latest is None or bool(latest.recount_ok_by)),
        }

    @staticmethod
    def _count_dict(c):
        return {"id": c.id, "seq": c.seq, "kind": c.kind, "counted_qty": _n(c.counted_qty), "location": c.location,
                "counted_by": c.counted_by, "counted_at": c.counted_at.isoformat(), "remarks": c.remarks,
                "source": c.source, "recount_ok_by": c.recount_ok_by, "recount_reason": c.recount_reason}

    def count(self, session_id, store_code, part_id, qty, user, location=None, remarks=None, source="MANUAL"):
        s = self._session(session_id, store_code)
        if s.status != "IN_PROGRESS":
            raise BadRequestError("Counting is closed for this inventory" if s.status != "PLANNED"
                                  else "Start the inventory (ERP snapshot) before counting")
        part = db.session.get(Part, int(part_id)) if str(part_id or "").isdigit() else None
        if part is None or part.store_code != s.store_code:
            raise NotFoundError("Part not found in this store")
        q = _qty(qty, "Counted quantity")
        with atomic():
            latest = self._latest(s.id, part.id)
            if latest is not None and not latest.recount_ok_by:
                raise BadRequestError(
                    f"{part.part_no} is already counted: {_n(latest.counted_qty)} {part.uom} by {latest.counted_by} "
                    f"at {latest.counted_at.astimezone():%d.%m.%Y %H:%M} — a supervisor must allow a recount")
            row = InventoryCount(session_id=s.id, part_id=part.id, seq=(latest.seq + 1) if latest else 1,
                                 kind="RECOUNT" if latest else "COUNT", counted_qty=q,
                                 location=_text(location, 60) or part.location, counted_by=_who(user),
                                 counted_at=utcnow(), remarks=_text(remarks, 255),
                                 source=source if source in ("SCAN", "MANUAL", "EXCEL") else "MANUAL")
            db.session.add(row)
            self._audit(s, row.kind, user, part.id, latest.counted_qty if latest else None, q, remarks)
        return self._count_dict(row)

    def edit_count(self, count_id, store_code, qty, user, reason):
        """The counter fixes a slip in their own latest count while counting is open."""
        c = db.session.get(InventoryCount, int(count_id)) if str(count_id).isdigit() else None
        if c is None:
            raise NotFoundError("Count not found")
        s = self._session(c.session_id, store_code)
        if s.status != "IN_PROGRESS":
            raise BadRequestError("Counting is closed for this inventory")
        if c.counted_by != _who(user):
            raise BadRequestError(f"Only {c.counted_by} can correct this count — or ask for a recount")
        if self._latest(s.id, c.part_id).id != c.id or c.recount_ok_by:
            raise BadRequestError("Only the latest count can be corrected")
        why = _text(reason, 255)
        if not why:
            raise BadRequestError("Give a reason for the correction")
        q = _qty(qty, "Counted quantity")
        with atomic():
            old = c.counted_qty
            c.counted_qty = q
            c.remarks = why
            self._audit(s, "EDIT", user, c.part_id, old, q, why)
        return self._count_dict(c)

    def allow_recount(self, session_id, store_code, part_id, user, reason):
        s = self._session(session_id, store_code)
        if s.status != "IN_PROGRESS":
            raise BadRequestError("A recount is allowed only while counting is open")
        why = _text(reason, 255)
        if not why:
            raise BadRequestError("Give a reason for the recount")
        latest = self._latest(s.id, int(part_id))
        if latest is None:
            raise BadRequestError("This part is not counted yet")
        if latest.recount_ok_by:
            raise BadRequestError("A recount is already allowed for this part")
        with atomic():
            latest.recount_ok_by, latest.recount_ok_at, latest.recount_reason = _who(user), utcnow(), why
            self._approval(s, "RECOUNT_OK", user, f"{latest.part_id}: {why}")
            self._audit(s, "RECOUNT", user, latest.part_id, latest.counted_qty, None, f"Recount allowed: {why}")
        return self._count_dict(latest)

    def import_counts(self, session_id, store_code, file_stream, user):
        """Counts from the count sheet (Part No + Physical / Counted Qty). A part
        already counted is skipped and listed, never overwritten."""
        from openpyxl import load_workbook
        s = self._session(session_id, store_code)
        if s.status != "IN_PROGRESS":
            raise BadRequestError("Counting is not open for this inventory")
        try:
            ws = load_workbook(io.BytesIO(file_stream.read()), read_only=True, data_only=True).active
        except Exception:
            raise BadRequestError("The file is not an Excel workbook (.xlsx)")
        norm = lambda v: re.sub(r"[^a-z0-9]", "", str(v or "").lower())
        rows = ws.iter_rows(values_only=True)
        head = [norm(h) for h in next(rows, [])]
        pn_i = next((i for i, n in enumerate(head) if n in ("partno", "partnumber", "itemcode")), None)
        q_i = next((i for i, n in enumerate(head) if n in ("physicalqty", "countedqty", "totalphysicalqty",
                                                            "physicalquantity", "countqty")), None)
        loc_i = next((i for i, n in enumerate(head) if n in ("location", "storagelocation", "rack")), None)
        rm_i = next((i for i, n in enumerate(head) if n == "remarks"), None)
        if pn_i is None or q_i is None:
            raise BadRequestError("The first row must have 'Part No' and 'Physical Qty' (or 'Counted Qty')")
        done, skipped, errors = 0, [], []
        for n, r in enumerate(rows, 2):
            pn = str(r[pn_i] or "").strip() if len(r) > pn_i else ""
            qv = r[q_i] if len(r) > q_i else None
            if not pn or qv in (None, ""):
                continue
            part = Part.query.filter(func.upper(Part.part_no) == pn.upper(), Part.store_code == s.store_code).first()
            if part is None:
                errors.append(f"Row {n}: {pn} is not in this store")
                continue
            try:
                self.count(s.id, store_code, part.id, qv, user,
                           location=r[loc_i] if loc_i is not None and len(r) > loc_i else None,
                           remarks=r[rm_i] if rm_i is not None and len(r) > rm_i else None, source="EXCEL")
                done += 1
            except BadRequestError as e:
                (skipped if "already counted" in str(e) else errors).append(f"Row {n}: {e}")
        return {"counted": done, "skipped": skipped[:200], "errors": errors[:200]}

    # ---- workflow ------------------------------------------------------------------------------------
    def submit(self, session_id, store_code, user, remarks=None):
        s = self._session(session_id, store_code)
        if s.status != "IN_PROGRESS":
            raise BadRequestError("Only an inventory in progress can be sent for approval")
        if not InventoryCount.query.filter_by(session_id=s.id).count():
            raise BadRequestError("Nothing is counted yet")
        with atomic():
            s.status, s.submitted_at, s.submitted_by = "RECON_PENDING", utcnow(), _who(user)
            self._approval(s, "SUBMIT", user, remarks)
        return self.session_dict(s)

    def reject(self, session_id, store_code, user, reason):
        s = self._session(session_id, store_code)
        if s.status != "RECON_PENDING":
            raise BadRequestError("Only an inventory waiting for approval can be sent back")
        why = _text(reason, 255)
        if not why:
            raise BadRequestError("Say why it goes back for counting")
        with atomic():
            s.status = "IN_PROGRESS"
            self._approval(s, "REJECT", user, why)
        return self.session_dict(s)

    def _freeze(self, s, revision):
        for r in self._live_rows(s):
            db.session.add(InventoryResult(
                session_id=s.id, revision=revision, part_id=r["part_id"], part_no=r["part_no"],
                item_description=r["item_description"], uom=r["uom"], category=r["category"],
                section_name=r["section"],
                location=r["location"], erp_qty=r["_erp"], physical_qty=r["_phy"],
                variance_qty=(r["_phy"] - (r["_erp"] or 0)) if r["_phy"] is not None else None,
                rate=r["_rate"], status=r["status"]))

    def approve(self, session_id, store_code, user, remarks=None):
        s = self._session(session_id, store_code)
        if s.status != "RECON_PENDING":
            raise BadRequestError("Only an inventory waiting for approval can be approved")
        with atomic():
            self._freeze(s, 0)
            s.status, s.approved_at, s.approved_by, s.revision = "COMPLETED", utcnow(), _who(user), 0
            self._approval(s, "APPROVE", user, remarks)
        return self.session_dict(s)

    def revise(self, session_id, store_code, part_id, qty, user, reason):
        """A correction after the lock: a REVISION count, a new frozen result
        set (revision + 1); the approved one stays as it was."""
        s = self._session(session_id, store_code)
        if s.status != "COMPLETED":
            raise BadRequestError("A revision is only for an approved (locked) inventory")
        why = _text(reason, 255)
        if not why:
            raise BadRequestError("Give the reason for the revision")
        part = db.session.get(Part, int(part_id)) if str(part_id or "").isdigit() else None
        if part is None or part.store_code != s.store_code:
            raise NotFoundError("Part not found in this store")
        q = _qty(qty, "Corrected quantity")
        with atomic():
            latest = self._latest(s.id, part.id)
            db.session.add(InventoryCount(session_id=s.id, part_id=part.id, seq=(latest.seq + 1) if latest else 1,
                                          kind="REVISION", counted_qty=q, location=part.location,
                                          counted_by=_who(user), counted_at=utcnow(), remarks=why, source="MANUAL"))
            db.session.flush()
            s.revision = (s.revision or 0) + 1
            self._freeze(s, s.revision)
            self._approval(s, "REVISION", user, f"{part.part_no}: {why}")
            self._audit(s, "REVISION", user, part.id, latest.counted_qty if latest else None, q, why)
        return self.session_dict(s)

    # ---- reconciliation ------------------------------------------------------------------------------
    def _live_rows(self, s):
        snap = {l.part_id: l for l in InventorySnapshotLine.query.filter_by(session_id=s.id).all()}
        latest = {}
        for c in InventoryCount.query.filter_by(session_id=s.id).order_by(InventoryCount.seq).all():
            latest[c.part_id] = c
        extra = [pid for pid in latest if pid not in snap]
        parts = {p.id: p for p in Part.query.filter(Part.id.in_(extra)).all()} if extra else {}
        rows = []
        for pid in list(snap) + extra:
            l, c = snap.get(pid), latest.get(pid)
            p = parts.get(pid)
            erp = Decimal(str(l.erp_qty)) if l is not None and l.erp_qty is not None else None
            phy = Decimal(str(c.counted_qty)) if c is not None else None
            rate = (l.rate if l is not None else (p.unit_price if p else None))
            rows.append({
                "part_id": pid, "part_no": l.part_no if l else p.part_no,
                "item_description": l.item_description if l else p.part_name, "uom": l.uom if l else p.uom,
                "category": l.category if l else p.sub_category,
                "section": l.section_name if l else (p.section.name if p.section else None),
                "location": (c.location if c and c.location else None) or (l.location if l else p.location),
                "_erp": erp, "_phy": phy, "_rate": rate, "status": status_of(erp, phy),
                "in_snapshot": l is not None,
                "counted_by": c.counted_by if c else None,
                "counted_at": c.counted_at.isoformat() if c else None,
                "count_kind": c.kind if c else None, "recount_ok": bool(c and c.recount_ok_by),
                "remarks": c.remarks if c else None,
            })
        return rows

    def reconcile(self, s):
        """Reconciliation rows: live until approved, then the frozen result of
        the current revision."""
        if s.status == "COMPLETED":
            res = InventoryResult.query.filter_by(session_id=s.id, revision=s.revision).all()
            # Who counted each part: its latest count (the frozen result keeps the figures).
            last = {}
            for c in InventoryCount.query.filter_by(session_id=s.id).order_by(InventoryCount.seq).all():
                last[c.part_id] = c
            rows = [{"part_id": r.part_id, "part_no": r.part_no, "item_description": r.item_description,
                     "uom": r.uom, "category": r.category, "location": r.location, "section": r.section_name,
                     "_erp": r.erp_qty, "_phy": r.physical_qty, "_rate": r.rate, "status": r.status,
                     "in_snapshot": True,
                     "counted_by": last[r.part_id].counted_by if r.part_id in last else None,
                     "counted_at": last[r.part_id].counted_at.isoformat() if r.part_id in last else None,
                     "count_kind": last[r.part_id].kind if r.part_id in last else None,
                     "remarks": last[r.part_id].remarks if r.part_id in last else None} for r in res]
        else:
            rows = self._live_rows(s)
        out = []
        for r in rows:
            erp, phy, rate = r.pop("_erp"), r.pop("_phy"), r.pop("_rate")
            r["erp_qty"] = _n(erp)
            r["physical_qty"] = _n(phy)
            r["variance_qty"] = _n(phy - (erp or 0)) if phy is not None else None
            r["rate"] = float(rate) if rate is not None else None
            r["variance_value"] = (round(r["variance_qty"] * r["rate"], 2)
                                   if r["variance_qty"] is not None and r["rate"] is not None else None)
            out.append(r)
        out.sort(key=lambda r: r["part_no"])
        return out

    def detail(self, session_id, store_code, view="parts", status=None, q=None):
        s = self._session(session_id, store_code)
        rows = self.reconcile(s)
        result = {"session": self.session_dict(s, with_summary=False), "summary": summarize(rows)}
        if view == "category":
            result["rows"] = self._grouped(rows, "category")
            return result
        if view == "audit":
            result["rows"] = self.audit(s.id)
            return result
        if view == "uncounted":
            status = "NOT_COUNTED"
        if status:
            rows = [r for r in rows if r["status"] == status or (status == "VARIANCE" and r["status"] in ("SHORT", "EXCESS"))]
        text = (q or "").strip().lower()
        if text:
            rows = [r for r in rows if text in (r["part_no"] or "").lower()
                    or text in (r["item_description"] or "").lower() or text in (r["location"] or "").lower()]
        result["rows"] = rows
        return result

    @staticmethod
    def _grouped(rows, key):
        groups = defaultdict(list)
        for r in rows:
            groups[r.get(key) or "Uncategorised"].append(r)
        return sorted(({"name": k, **summarize(v)} for k, v in groups.items()), key=lambda g: g["name"])

    def audit(self, session_id):
        names = dict(db.session.query(Part.id, Part.part_no).join(
            InventoryAudit, InventoryAudit.part_id == Part.id).filter(InventoryAudit.session_id == session_id).all())
        out = [{"at": a.at.isoformat(), "by": a.by, "action": a.action, "part_no": names.get(a.part_id),
                "old_qty": _n(a.old_qty), "new_qty": _n(a.new_qty), "remarks": a.remarks}
               for a in InventoryAudit.query.filter_by(session_id=session_id).all()]
        out.sort(key=lambda r: r["at"], reverse=True)
        return out

    # ---- quarter level -------------------------------------------------------------------------------
    def _quarter_sessions(self, store_code, fiscal_year, quarter):
        """The sessions of a quarter that count: per scope (a section, or the
        whole store), its latest attempt."""
        latest = {}
        for s in (InventorySession.query.filter_by(store_code=store_code, fiscal_year=fiscal_year, quarter=quarter)
                  .order_by(InventorySession.attempt).all()):
            latest[s.section_id] = s
        return list(latest.values())

    def quarter(self, store_code, fiscal_year, quarter, verified_only=False):
        """A quarter: overview, by section (a whole-store inventory split by
        each part's section), by category; `sessions` lists the inventories."""
        sessions = self._quarter_sessions(store_code, fiscal_year, quarter)
        rows, by_section, listed = [], [], []
        for s in sessions:
            listed.append({"session_id": s.id, "name": scope_name(s), "status": s.status,
                           "status_label": STATUS_WORD[s.status], "whole_store": s.section_id is None})
            if s.status == "PLANNED" or (verified_only and s.status != "COMPLETED"):
                by_section.append({"session_id": s.id, "name": scope_name(s), "status": s.status,
                                   "status_label": STATUS_WORD[s.status], **summarize([])})
                continue
            r = self.reconcile(s)
            rows += r
            groups = defaultdict(list)
            for x in r:
                groups[x.get("section") or "No section"].append(x)
            for name, part_rows in groups.items():
                by_section.append({"session_id": s.id, "name": name, "status": s.status,
                                   "status_label": STATUS_WORD[s.status], **summarize(part_rows)})
        done = sum(1 for s in sessions if s.status == "COMPLETED")
        return {
            "fiscal_year": fiscal_year, "quarter": quarter, "sections": len(sessions), "completed_sections": done,
            "audit_completion_pct": round(done / len(sessions) * 100, 1) if sessions else 0.0,
            "status": ("Completed" if sessions and done == len(sessions) else
                       "Not planned" if not sessions else
                       "Reconciliation Pending" if any(s.status == "RECON_PENDING" for s in sessions) else
                       "In Progress" if any(s.status != "PLANNED" for s in sessions) else "Planned"),
            "summary": summarize(rows), "by_section": sorted(by_section, key=lambda x: x["name"]),
            "sessions": listed,
            "by_category": self._grouped(rows, "category"),
        }

    def history(self, store_code):
        """Every quarter with sessions, newest first, with its verified
        (approved) figures — the Q1–Q4 trend and previous-quarter comparison."""
        periods = (db.session.query(InventorySession.fiscal_year, InventorySession.quarter)
                   .filter_by(store_code=store_code).distinct().all())
        periods.sort(key=lambda p: (p[0], p[1]), reverse=True)
        return [self.quarter(store_code, fy, q, verified_only=True) | {"by_category": None} for fy, q in periods]

    def board_card(self, store_code):
        """The Live Board card: the latest quarter that has an inventory, its
        verified (approved) figures, and how far its audit has got."""
        hist = self.history(store_code)
        if not hist:
            return {"has_data": False}
        latest = hist[0]
        prev = next((h for h in hist[1:] if h["completed_sections"]), None)
        return {"has_data": True, **latest,
                "previous": {"fiscal_year": prev["fiscal_year"], "quarter": prev["quarter"],
                             "accuracy_pct": prev["summary"]["accuracy_pct"]} if prev else None}
