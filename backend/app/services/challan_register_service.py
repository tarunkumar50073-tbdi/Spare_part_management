"""Urgent Challan Register: register urgent challans, link the original invoice
when it comes, link the GRN that followed, and follow each line to GRN
Completed (models/challan_register.py says what the tables hold and why).

THE REGISTER NEVER TOUCHES STOCK. Nothing here writes spare_stock, its ledger
or the journal. Material counts into stock only through the existing ERP GRN
after quality clearance (erp_grn_posting_service: an ERP GRN line whose accept
qty is set posts a RECEIPT once per part and GRN). A challan line becomes GRN
Completed only when the GRN line linked to each of its invoices carries an
accepted qty — the same moment that posting adds it — so the register follows
the stock, it never makes it.

Workflow status, worked out from the line and its links (_recompute):
    Pending Invoice    less invoiced than the challan qty (none, or part)
    Invoice Received   fully invoiced, a GRN not yet linked to every invoice
    GRN Pending        every invoice has its GRN, quality not yet OK on all
                       (still pending, or rejected — quality_status says which)
    GRN Completed      every invoice's GRN line accepted by quality, nothing rejected
    Cancelled          kept for the audit, with who / when / why
Quality comes from the ERP GRN line (accept_qty / reject_qty), never typed.
While ERP is not reachable a GRN no. may be typed; its line is attached, and
its quality read, as soon as the GRN register has it (refresh_from_erp).

Duplicates: one active line per supplier + challan no. + part (a partial
delivery comes on its own challan no.); a repeated submit with the same
request_id returns the first record; an invoice is linked to a line once and
never beyond the challan qty; a GRN (its no. + Part No.) is linked to one
challan only.

A GRN is named by its no. and the Part No. (and the vendor, when the challan
has an ERP vendor code), and its lines in the ERP GRN register are found again
by them on every read: the ERP sync rewrites that register on each run, so a
line's id is never a reference. Quality is read over all of a GRN's lines for
the part (accepted / rejected summed).
"""
import io
import json
import re
from collections import Counter
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from openpyxl import Workbook
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError

from app.extensions import db
from app.models.base import utcnow
from app.models.challan_register import (
    CHALLAN_STATUSES, INVOICE_STATUSES, OPEN_STATUSES, PO_STATUSES, QUALITY_STATUSES, URGENCY_REASONS,
    ChallanHistory, ChallanLink, ChallanRegister,
)
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.supplier import Supplier
from app.utils.db_tx import atomic
from app.utils.excel_io import _append_safe_row, format_table
from app.utils.exceptions import BadRequestError, ConflictError, NotFoundError

SUPPLIER_SOURCES = ("GATE_ENTRY", "ERP_GRN", "SUPPLIER_MASTER", "NAME_ONLY")
ERP_SUPPLIER_SOURCES = ("GATE_ENTRY", "ERP_GRN")
MAX_QTY = Decimal("1000000")
PAGE_SIZE, MAX_PAGE_SIZE = 25, 100
# "invoice aane k baad po pending nhi dikhayega kyunki po banne k baad hi
# supplier k paas jaayega" (the store, 21 Oct 2026): an invoice is made only
# against a PO, so a line with an invoice never shows the PO as pending.
NO_INVOICE_WITHOUT_PO = ("An invoice comes only against a PO — enter the PO No. from the invoice "
                         "(PO status Approved) to link it")
# How long open lines have waited since the material came in.
AGEING = (("0-7 days", 0, 7), ("8-15 days", 8, 15), ("16-30 days", 16, 30), ("Over 30 days", 31, None))
EXPORT_COLUMNS = ("Challan ID", "Challan No", "Challan Date", "Receipt Date", "Supplier", "Vendor Code", "Part No",
                  "Description", "Challan Qty", "UOM", "PO Reference", "PO Status", "Urgency", "Invoice No",
                  "Invoice Date", "Invoiced Qty", "Invoice Status", "GRN", "Quality", "Status", "Days Open",
                  "Remarks", "Created By")


# ---- small helpers -------------------------------------------------------------

def _today():
    from app.services.spare_report_service import plant_today
    return plant_today()


def _clean(value, limit=None, label="Value"):
    text = str(value).strip() if value is not None else ""
    if not text:
        return None
    if limit and len(text) > limit:
        raise BadRequestError(f"{label} is too long (at most {limit} characters)")
    return text


def _need(data, key, limit, label):
    value = _clean(data.get(key), limit, label)
    if value is None:
        raise BadRequestError(f"{label} is required")
    return value


def _key(text):
    """The same challan / invoice / GRN no. however it was spaced or cased."""
    return re.sub(r"\s+", "", text or "").upper()


def _date(value, label, required=False):
    if value in (None, ""):
        if required:
            raise BadRequestError(f"{label} is required")
        return None
    if isinstance(value, date):
        return value
    try:
        return datetime.strptime(str(value).strip()[:10], "%Y-%m-%d").date()
    except ValueError:
        raise BadRequestError(f"{label} must be a date (YYYY-MM-DD)") from None


def _qty(value, label):
    try:
        qty = Decimal(str(value).strip())
    except (InvalidOperation, ValueError, AttributeError):
        raise BadRequestError(f"{label} must be a number") from None
    if not qty.is_finite() or qty <= 0:
        raise BadRequestError(f"{label} must be more than 0")
    if qty > MAX_QTY:
        raise BadRequestError(f"{label} is too large")
    if qty != qty.quantize(Decimal("0.01")):
        raise BadRequestError(f"{label} can have at most 2 decimals")
    return qty


def _choice(value, choices, label):
    value = _clean(value)
    if value not in choices:
        raise BadRequestError(f"{label} must be one of: {', '.join(choices)}")
    return value


def _dec(value):
    return Decimal(str(value)) if value is not None else Decimal("0")


def _num(value):
    return float(value) if value is not None else None


def _iso(value):
    return value.isoformat() if value is not None else None


def _who(user):
    return (getattr(user, "username", None) or str(user or "") or "SYSTEM")[:60]


def _quality(accepted, rejected):
    """Quality of an ERP GRN line: rejected if any qty was rejected, OK once an
    accepted qty is set, else still pending."""
    if (rejected or 0) > 0:
        return "Rejected"
    if (accepted or 0) > 0:
        return "OK"
    return "Pending"


class ChallanRegisterService:

    # ---- registering a challan ----------------------------------------------

    def create(self, store_code, data, user=None):
        """Register one urgent challan line. Writes challan_register (and its
        history) only — no GRN, no stock. A repeated submit with the same
        request_id returns the first record."""
        data = data or {}
        request_id = _clean(data.get("request_id"), 64, "request_id")
        if request_id:
            hit = ChallanRegister.query.filter_by(request_id=request_id).first()
            if hit is not None:
                return dict(self.detail(hit.id), replayed=True)
        part = self._part(store_code, data.get("part_id"))
        challan_no = _need(data, "challan_no", 60, "Challan No.")
        today = _today()
        challan_date = _date(data.get("challan_date"), "Challan date", required=True)
        receipt_date = _date(data.get("receipt_date"), "Receipt date") or today
        if challan_date > today:
            raise BadRequestError("Challan date cannot be in the future")
        if receipt_date > today:
            raise BadRequestError("Receipt date cannot be in the future")
        if receipt_date < challan_date:
            raise BadRequestError("Receipt date cannot be before the challan date")
        supplier = self._supplier(part, data)
        qty = _qty(data.get("challan_qty"), "Received quantity")
        uom = _clean(data.get("unit_of_measure"), 20, "Unit") or part.uom
        po_status, po_reference = self._po(data)
        urgency = _choice(data.get("urgency_reason"), URGENCY_REASONS, "Urgency reason")
        remarks = _clean(data.get("remarks"), 255, "Remarks")
        if urgency == "Other" and not remarks:
            raise BadRequestError("Write the reason in Remarks when the urgency is Other")
        key = _key(challan_no)
        self._refuse_duplicate(store_code, supplier["supplier_key"], key, part, supplier["supplier_name"],
                               challan_no)

        row = ChallanRegister(
            store_code=store_code, challan_no=challan_no, challan_key=key, challan_date=challan_date,
            receipt_date=receipt_date, gate_entry_no=_clean(data.get("gate_entry_no"), 60, "Gate entry no."),
            part_id=part.id, part_no=part.part_no, part_description=part.part_name, challan_qty=qty,
            unit_of_measure=uom, po_reference=po_reference, po_status=po_status, urgency_reason=urgency,
            invoiced_qty=0, invoice_status="Pending", quality_status="Pending", status="Pending Invoice",
            remarks=remarks, created_by=_who(user), request_id=request_id, **supplier)
        # Twice at most: a second entry saved in the same instant may take the
        # same CHL number; the unique index refuses it and a fresh number is taken.
        for _ in range(2):
            try:
                with atomic():
                    row.challan_id = self._next_id()
                    db.session.add(row)
                    db.session.flush()
                    self._log(row, "CREATED", None, row.status, {
                        "challan_no": challan_no, "part_no": part.part_no, "qty": str(qty),
                        "supplier": row.supplier_name, "po_status": po_status, "urgency": urgency}, user)
                return self.detail(row.id)
            except IntegrityError:
                db.session.rollback()
                if request_id:
                    hit = ChallanRegister.query.filter_by(request_id=request_id).first()
                    if hit is not None:                    # the same form, submitted twice at once
                        return dict(self.detail(hit.id), replayed=True)
                self._refuse_duplicate(store_code, supplier["supplier_key"], key, part,
                                       supplier["supplier_name"], challan_no)
        raise ConflictError("The challan could not be saved — please try again")

    def update(self, pk, data, user=None):
        """Change what may change on an open line: PO reference / status, the
        urgency, the gate entry no., remarks, the receipt date — and the
        challan qty while no invoice is linked (never below what is invoiced).
        Supplier, part and challan no. stay: a wrong one is cancelled and
        entered again. Every change is in the history."""
        row = self._get(pk)
        if row.status == "Cancelled":
            raise BadRequestError("A cancelled challan cannot be changed")
        data = data or {}
        before = {}
        if "po_status" in data or "po_reference" in data:
            po_status, po_reference = self._po({"po_status": data.get("po_status", row.po_status),
                                               "po_reference": data.get("po_reference", row.po_reference)})
            if row.links and po_status == "Pending Approval":
                raise BadRequestError(NO_INVOICE_WITHOUT_PO)
            before.update(po_status=row.po_status, po_reference=row.po_reference)
            row.po_status, row.po_reference = po_status, po_reference
        if "urgency_reason" in data:
            before["urgency_reason"] = row.urgency_reason
            row.urgency_reason = _choice(data.get("urgency_reason"), URGENCY_REASONS, "Urgency reason")
        if "remarks" in data:
            before["remarks"] = row.remarks
            row.remarks = _clean(data.get("remarks"), 255, "Remarks")
        if row.urgency_reason == "Other" and not row.remarks:
            raise BadRequestError("Write the reason in Remarks when the urgency is Other")
        if "gate_entry_no" in data:
            before["gate_entry_no"] = row.gate_entry_no
            row.gate_entry_no = _clean(data.get("gate_entry_no"), 60, "Gate entry no.")
        if "receipt_date" in data:
            receipt = _date(data.get("receipt_date"), "Receipt date", required=True)
            if receipt > _today() or receipt < row.challan_date:
                raise BadRequestError("Receipt date must be between the challan date and today")
            before["receipt_date"] = _iso(row.receipt_date)
            row.receipt_date = receipt
        if "challan_qty" in data:
            qty = _qty(data.get("challan_qty"), "Received quantity")
            if row.links:
                raise BadRequestError("The quantity cannot change once an invoice is linked")
            before["challan_qty"] = str(row.challan_qty)
            row.challan_qty = qty
        changed = {k: v for k, v in before.items() if str(v) != str(self._value(row, k))}
        if not changed:
            return self.detail(row.id)
        with atomic():
            status = row.status
            self._recompute(row)
            self._log(row, "UPDATED", status, row.status,
                      {k: {"from": v, "to": self._value(row, k)} for k, v in changed.items()}, user)
        return self.detail(row.id)

    def cancel(self, pk, data, user=None):
        """Cancel a line (kept, never deleted). Not once it is GRN Completed —
        that material is in stock through its GRN."""
        row = self._get(pk)
        if row.status == "Cancelled":
            return self.detail(row.id)
        if row.status == "GRN Completed":
            raise BadRequestError("A challan whose GRN is completed cannot be cancelled")
        reason = _need(data or {}, "reason", 255, "Cancel reason")
        with atomic():
            status = row.status
            row.status = "Cancelled"
            row.cancel_reason = reason
            row.cancelled_by = _who(user)
            row.cancelled_at = utcnow()
            # A cancelled line gives its GRNs up, so the right challan can take
            # them; their nos. stay on the links and in this history.
            freed = [link.grn_reference for link in row.links if link.grn_key]
            for link in row.links:
                link.grn_key = link.grn_item = None
            self._log(row, "CANCELLED", status, "Cancelled", {"reason": reason, "grns_freed": freed}, user)
        return self.detail(row.id)

    # ---- the original invoice -----------------------------------------------

    def link_invoice(self, pk, data, user=None):
        """Link an original invoice to a challan line: its no., date and how
        much of the challan it covers (the rest by default). Never more than
        the challan qty in all, the same invoice once per line; one invoice may
        cover several challans of the supplier (they are named back). The PO
        may be updated in the same step, as the person sets it — never on its
        own — and it may not still be Pending Approval: a supplier invoices only
        against a PO (the store, 21 Oct 2026). No stock moves."""
        data = data or {}
        row = self._get(pk)
        if row.status == "Cancelled":
            raise BadRequestError("A cancelled challan cannot take an invoice")
        request_id = _clean(data.get("request_id"), 64, "request_id")
        if request_id and ChallanLink.query.filter_by(request_id=request_id).first() is not None:
            return dict(self.detail(row.id), replayed=True)
        invoice_no = _need(data, "invoice_no", 60, "Invoice No.")
        invoice_date = _date(data.get("invoice_date"), "Invoice date", required=True)
        if invoice_date > _today():
            raise BadRequestError("Invoice date cannot be in the future")
        remaining = _dec(row.challan_qty) - _dec(row.invoiced_qty)
        if remaining <= 0:
            raise BadRequestError(f"{row.challan_id} is already fully invoiced")
        qty = _qty(data.get("invoice_qty"), "Invoice quantity") if data.get("invoice_qty") not in (None, "") \
            else remaining
        if qty > remaining:
            raise BadRequestError(
                f"Over-invoicing: {row.challan_id} has {self._q(remaining)} {row.unit_of_measure or ''} "
                f"left to invoice, not {self._q(qty)}".replace("  ", " "))
        key = _key(invoice_no)
        existing = next((link for link in row.links if link.invoice_key == key), None)
        if existing is not None:
            raise ConflictError(f"Invoice {existing.invoice_no} is already linked to {row.challan_id}")
        po = None
        if "po_status" in data or "po_reference" in data:
            po = self._po({"po_status": data.get("po_status", row.po_status),
                           "po_reference": data.get("po_reference", row.po_reference)})
        if (po[0] if po else row.po_status) == "Pending Approval":
            raise BadRequestError(NO_INVOICE_WITHOUT_PO)
        others = [c for c, in db.session.query(ChallanRegister.challan_id)
                  .join(ChallanLink, ChallanLink.challan_ref == ChallanRegister.id)
                  .filter(ChallanLink.invoice_key == key, ChallanRegister.supplier_key == row.supplier_key,
                          ChallanRegister.id != row.id, ChallanRegister.status != "Cancelled")]
        try:
            with atomic():
                status = row.status
                if po is not None and po != (row.po_status, row.po_reference):
                    self._log(row, "PO_UPDATED", status, status,
                              {"from": [row.po_status, row.po_reference], "to": list(po)}, user)
                    row.po_status, row.po_reference = po
                link = ChallanLink(challan_ref=row.id, invoice_no=invoice_no, invoice_key=key,
                                   invoice_date=invoice_date, invoice_qty=qty, linked_by=_who(user),
                                   request_id=request_id, quality_status="Pending")
                db.session.add(link)
                db.session.flush()
                db.session.refresh(row)
                self._recompute(row)
                self._log(row, "INVOICE_LINKED", status, row.status, {
                    "invoice_no": invoice_no, "invoice_date": _iso(invoice_date), "qty": str(qty),
                    "also_on": others}, user)
        except IntegrityError:
            db.session.rollback()
            if request_id and ChallanLink.query.filter_by(request_id=request_id).first() is not None:
                return dict(self.detail(row.id), replayed=True)
            raise ConflictError(f"Invoice {invoice_no} is already linked to {row.challan_id}") from None
        return dict(self.detail(row.id), invoice_also_on=others)

    # ---- the GRN ------------------------------------------------------------------

    def link_grn(self, pk, link_pk, data, user=None):
        """Link the GRN made for an invoice: picked from the ERP GRN register
        (receiving_register_id of one of its lines) — its quality read from it —
        or, while ERP is not reachable, its GRN no. as typed (quality pending
        until its lines arrive). It must be this part's (and this vendor's, when
        the challan has an ERP vendor code) and not linked to any other
        challan. The GRN itself, its stock and its quality stay ERP's —
        nothing is posted here."""
        data = data or {}
        row = self._get(pk)
        if row.status == "Cancelled":
            raise BadRequestError("A cancelled challan cannot take a GRN")
        link = db.session.get(ChallanLink, link_pk)
        if link is None or link.challan_ref != row.id:
            raise NotFoundError(f"Invoice link {link_pk} not found on {row.challan_id}")
        rr_id = data.get("receiving_register_id")
        typed = _clean(data.get("grn_no"), 60, "GRN No.")
        if rr_id not in (None, ""):
            try:
                rr = db.session.get(ReceivingRegister, int(rr_id))
            except (TypeError, ValueError):
                rr = None
            if rr is None:
                raise NotFoundError("That GRN line is no longer in the ERP GRN register — refresh the list")
            if (rr.item_cd or "").strip().upper() != row.part_no.strip().upper():
                raise BadRequestError(f"GRN {rr.grn_no} is for item {rr.item_cd}, not {row.part_no}")
            if row.ven_cd and rr.ven_cd and rr.ven_cd.strip().upper() != row.ven_cd.strip().upper():
                raise BadRequestError(f"GRN {rr.grn_no} is from vendor {rr.ven_cd}; the challan is from "
                                      f"{row.ven_cd}")
            grn_no = rr.grn_no
        elif typed:
            grn_no = typed
        else:
            raise BadRequestError("Pick the GRN line, or type the GRN No.")
        key, item = _key(grn_no), row.part_no.strip().upper()
        if link.grn_key and link.receiving_register_id and link.grn_key != key:
            raise ConflictError(f"Invoice {link.invoice_no} already has GRN {link.grn_reference} from the ERP "
                                f"register — that link cannot be replaced")
        taken = (db.session.query(ChallanRegister.challan_id)
                 .join(ChallanLink, ChallanLink.challan_ref == ChallanRegister.id)
                 .filter(ChallanLink.grn_key == key, ChallanLink.grn_item == item, ChallanLink.id != link.id)
                 .first())
        if taken:
            raise ConflictError(f"GRN {grn_no} for {row.part_no} is already linked to {taken[0]}")
        lines = self._erp_lines(row, grn_no)
        new = self._grn_facts(lines, grn_no, _date(data.get("grn_date"), "GRN date"))
        new.update(grn_key=key, grn_item=item)
        if all(str(getattr(link, k)) == str(v) for k, v in new.items()):
            return self.detail(row.id)                     # the same GRN again: nothing to do
        try:
            with atomic():
                status = row.status
                for k, v in new.items():
                    setattr(link, k, v)
                link.grn_linked_by = _who(user)
                link.grn_linked_at = utcnow()
                db.session.flush()
                self._recompute(row)
                self._log(row, "GRN_LINKED", status, row.status, {
                    "invoice_no": link.invoice_no, "grn_no": link.grn_reference,
                    "from_erp_register": bool(lines), "quality": link.quality_status,
                    "accepted": _num(link.grn_accepted_qty), "rejected": _num(link.grn_rejected_qty)}, user)
        except IntegrityError:
            db.session.rollback()
            raise ConflictError(f"GRN {grn_no} for {row.part_no} is already linked to another challan") from None
        return self.detail(row.id)

    def grn_candidates(self, pk):
        """ERP GRNs that may be this challan's — one per GRN no., its lines for
        this part summed: this vendor's (when the challan has an ERP code), not
        linked to another challan, dated from a month before the challan; the
        ones naming this challan no. first, then the newest."""
        row = self._get(pk)
        item = row.part_no.strip().upper()
        q = ReceivingRegister.query.filter(func.upper(func.trim(ReceivingRegister.item_cd)) == item)
        if row.ven_cd:
            q = q.filter(func.upper(func.trim(ReceivingRegister.ven_cd)) == row.ven_cd.strip().upper())
        own = {link.grn_key for link in row.links if link.grn_key}
        taken = {k for k, in db.session.query(ChallanLink.grn_key)
                 .filter(ChallanLink.grn_item == item, ChallanLink.grn_key.isnot(None),
                         ChallanLink.challan_ref != row.id)}
        floor = date.fromordinal(row.challan_date.toordinal() - 31)
        groups = {}
        for rr in q.order_by(ReceivingRegister.grn_date.desc(), ReceivingRegister.id.desc()).limit(500):
            key = _key(rr.grn_no)
            if not key or key in taken or (rr.grn_date is not None and rr.grn_date < floor):
                continue
            groups.setdefault(key, []).append(rr)
        out = []
        for key, lines in groups.items():
            first = lines[0]
            facts = self._grn_facts(lines, first.grn_no, None)
            out.append({
                "id": first.id, "grn_no": first.grn_no, "grn_date": _iso(first.grn_date), "ven_cd": first.ven_cd,
                "ven_name": first.ven_name, "challan_no": first.challan_no, "challan_dt": _iso(first.challan_dt),
                "gate_entry_no": first.gate_entry_no, "po_no": first.po_no, "lines": len(lines),
                "receipt_qty": _num(facts["grn_receipt_qty"]), "accept_qty": _num(facts["grn_accepted_qty"]),
                "reject_qty": _num(facts["grn_rejected_qty"]), "quality": facts["quality_status"],
                "matches_challan_no": any(_key(rr.challan_no) == row.challan_key for rr in lines),
                "linked_here": key in own,
            })
        out.sort(key=lambda c: not c["matches_challan_no"])           # stable: newest first within each
        return out[:30]

    def refresh_from_erp(self, store_code, user=None, pk=None):
        """Read the ERP GRN register again for every open line (or one): find
        each linked GRN's lines by its no. + Part No., take their latest
        accepted / rejected qty. Returns how many lines changed."""
        q = ChallanRegister.query.filter(ChallanRegister.store_code == store_code,
                                         ChallanRegister.status.in_(OPEN_STATUSES))
        if pk is not None:
            q = q.filter(ChallanRegister.id == pk)
        changed = 0
        for row in q.all():
            moved = []
            for link in row.links:
                if not link.grn_key:
                    continue
                lines = self._erp_lines(row, link.grn_reference)
                if not lines:
                    continue
                new = self._grn_facts(lines, link.grn_reference, link.grn_date)
                if any(str(getattr(link, k)) != str(v) for k, v in new.items()):
                    for k, v in new.items():
                        setattr(link, k, v)
                    moved.append({"invoice_no": link.invoice_no, "grn_no": link.grn_reference,
                                  "quality": link.quality_status})
            if moved:
                with atomic():
                    status = row.status
                    db.session.flush()
                    self._recompute(row)
                    self._log(row, "GRN_REFRESHED", status, row.status, {"lines": moved}, user)
                changed += 1
        return {"changed": changed}

    # ---- reading ------------------------------------------------------------------

    def detail(self, pk):
        row = self._get(pk)
        out = self.to_dict(row)
        out["links"] = [self._link_dict(link) for link in row.links]
        out["history"] = [{
            "id": h.id, "action": h.action, "from_status": h.from_status, "to_status": h.to_status,
            "details": json.loads(h.details) if h.details else None, "by": h.by, "at": _iso(h.created_at),
        } for h in row.history]
        out["remaining_to_invoice"] = _num(max(_dec(row.challan_qty) - _dec(row.invoiced_qty), Decimal("0")))
        out["can"] = {
            "edit": row.status != "Cancelled",
            "link_invoice": row.status != "Cancelled" and _dec(row.invoiced_qty) < _dec(row.challan_qty),
            "link_grn": row.status in ("Invoice Received", "GRN Pending", "Pending Invoice")
            and any(not link.receiving_register_id for link in row.links),
            "refresh_grn": row.status in OPEN_STATUSES and any(link.grn_key for link in row.links),
            "cancel": row.status not in ("Cancelled", "GRN Completed"),
        }
        return out

    def list(self, store_code, filters=None, page=1, page_size=PAGE_SIZE):
        q = self._filtered(store_code, filters or {})
        total = q.count()
        page_size = max(1, min(int(page_size or PAGE_SIZE), MAX_PAGE_SIZE))
        pages = max(1, -(-total // page_size))
        page = max(1, min(int(page or 1), pages))
        rows = (q.order_by(ChallanRegister.receipt_date.desc(), ChallanRegister.id.desc())
                .offset((page - 1) * page_size).limit(page_size).all())
        return {"rows": [self.to_dict(r) for r in rows], "total": total, "page": page, "pages": pages,
                "page_size": page_size}

    def dashboard(self, store_code, filters=None):
        """The tiles over the date / supplier / part filters (not the status
        ones — the tiles ARE the statuses), and the ageing of open lines."""
        f = {k: v for k, v in (filters or {}).items() if k in ("date_from", "date_to", "supplier", "part", "q")}
        rows = self._filtered(store_code, f).all()
        status = Counter(r.status for r in rows)
        live = [r for r in rows if r.status != "Cancelled"]
        today = _today()
        open_rows = [r for r in rows if r.status in OPEN_STATUSES]
        ageing = []
        for label, low, high in AGEING:
            hit = [r for r in open_rows if (today - r.receipt_date).days >= low
                   and (high is None or (today - r.receipt_date).days <= high)]
            ageing.append({"label": label, "count": len(hit),
                           "challan_ids": [r.challan_id for r in sorted(hit, key=lambda r: r.receipt_date)[:5]]})
        oldest = min(open_rows, key=lambda r: (r.receipt_date, r.id), default=None)
        return {
            "tiles": {
                "total": len(rows),
                "pending_invoice": status["Pending Invoice"],
                "po_approval_pending": sum(1 for r in live if r.po_status == "Pending Approval"
                                           and r.status != "GRN Completed"),
                "invoice_received_grn_pending": status["Invoice Received"] + status["GRN Pending"],
                "quality_pending": sum(1 for r in live if r.status == "GRN Pending" and r.quality_status == "Pending"),
                "quality_rejected": sum(1 for r in live if r.quality_status == "Rejected"),
                "grn_completed": status["GRN Completed"],
                "cancelled": status["Cancelled"],
            },
            "ageing": ageing,
            "oldest_open": {"challan_id": oldest.challan_id, "days": (today - oldest.receipt_date).days,
                            "supplier": oldest.supplier_name, "part_no": oldest.part_no} if oldest else None,
            "as_of": today.isoformat(),
        }

    def export(self, store_code, filters=None):
        rows = (self._filtered(store_code, filters or {})
                .order_by(ChallanRegister.receipt_date.desc(), ChallanRegister.id.desc()).all())
        today = _today()
        wb = Workbook()
        ws = wb.active
        ws.title = "Urgent Challans"
        ws.append(list(EXPORT_COLUMNS))
        for r in rows:
            _append_safe_row(ws, [
                r.challan_id, r.challan_no, r.challan_date, r.receipt_date, r.supplier_name, r.ven_cd, r.part_no,
                r.part_description, _num(r.challan_qty), r.unit_of_measure, r.po_reference, r.po_status,
                r.urgency_reason, r.invoice_no, r.invoice_date, _num(r.invoiced_qty), r.invoice_status,
                r.grn_reference, r.quality_status, r.status,
                (today - r.receipt_date).days if r.status in OPEN_STATUSES else None, r.remarks, r.created_by])
        format_table(ws)
        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        return buf, f"Urgent Challan Register {today:%d.%m.%Y}.xlsx"

    def options(self):
        return {"po_statuses": list(PO_STATUSES), "urgency_reasons": list(URGENCY_REASONS),
                "statuses": list(CHALLAN_STATUSES), "invoice_statuses": list(INVOICE_STATUSES),
                "quality_statuses": list(QUALITY_STATUSES), "today": _today().isoformat()}

    def search_parts(self, store_code, q, limit=20):
        """The store's active parts by Part No. / old / new no. / description /
        specification, for the entry form."""
        text = (q or "").strip()
        if len(text) < 2:
            return []
        like = f"%{text}%"
        rows = (Part.query.filter(Part.store_code == store_code, Part.is_active.is_(True),
                                  or_(Part.part_no.ilike(like), Part.old_part_no.ilike(like),
                                      Part.new_part_no.ilike(like), Part.part_name.ilike(like),
                                      Part.specification.ilike(like)))
                .order_by(func.length(Part.part_no), Part.part_no).limit(max(1, min(int(limit), 50))).all())
        return [{"id": p.id, "part_no": p.part_no, "part_name": p.part_name, "uom": p.uom,
                 "location": p.location, "specification": p.specification} for p in rows]

    @staticmethod
    def to_dict(r):
        today = _today()
        return {
            "id": r.id, "challan_id": r.challan_id, "store_code": r.store_code, "challan_no": r.challan_no,
            "challan_date": _iso(r.challan_date), "receipt_date": _iso(r.receipt_date),
            "gate_entry_no": r.gate_entry_no, "supplier_id": r.supplier_id, "ven_cd": r.ven_cd,
            "supplier_name": r.supplier_name, "supplier_source": r.supplier_source, "part_id": r.part_id,
            "part_no": r.part_no, "part_description": r.part_description, "challan_qty": _num(r.challan_qty),
            "unit_of_measure": r.unit_of_measure, "po_reference": r.po_reference, "po_status": r.po_status,
            "urgency_reason": r.urgency_reason, "invoice_no": r.invoice_no, "invoice_date": _iso(r.invoice_date),
            "invoiced_qty": _num(r.invoiced_qty), "invoice_status": r.invoice_status,
            "grn_reference": r.grn_reference, "quality_status": r.quality_status, "status": r.status,
            "remarks": r.remarks, "cancel_reason": r.cancel_reason, "cancelled_by": r.cancelled_by,
            "cancelled_at": _iso(r.cancelled_at), "completed_at": _iso(r.completed_at),
            "created_by": r.created_by, "created_at": _iso(r.created_at), "updated_at": _iso(r.updated_at),
            "days_open": (today - r.receipt_date).days if r.status in OPEN_STATUSES else None,
        }

    @staticmethod
    def _link_dict(link):
        return {
            "id": link.id, "invoice_no": link.invoice_no, "invoice_date": _iso(link.invoice_date),
            "invoice_qty": _num(link.invoice_qty), "linked_by": link.linked_by, "linked_at": _iso(link.created_at),
            "grn_reference": link.grn_reference, "grn_date": _iso(link.grn_date),
            "grn_from_erp": link.receiving_register_id is not None,
            "receiving_register_id": link.receiving_register_id, "grn_receipt_qty": _num(link.grn_receipt_qty),
            "grn_accepted_qty": _num(link.grn_accepted_qty), "grn_rejected_qty": _num(link.grn_rejected_qty),
            "quality_status": link.quality_status, "grn_linked_by": link.grn_linked_by,
            "grn_linked_at": _iso(link.grn_linked_at),
        }

    # ---- internals ----------------------------------------------------------------

    def _filtered(self, store_code, f):
        q = ChallanRegister.query.filter(ChallanRegister.store_code == store_code)
        date_from = _date(f.get("date_from"), "From date")
        date_to = _date(f.get("date_to"), "To date")
        if date_from and date_to and date_to < date_from:
            raise BadRequestError("The To date is before the From date")
        if date_from:
            q = q.filter(ChallanRegister.receipt_date >= date_from)
        if date_to:
            q = q.filter(ChallanRegister.receipt_date <= date_to)
        for key, col, choices in (("po_status", ChallanRegister.po_status, PO_STATUSES),
                                  ("invoice_status", ChallanRegister.invoice_status, INVOICE_STATUSES),
                                  ("status", ChallanRegister.status, CHALLAN_STATUSES),
                                  ("quality_status", ChallanRegister.quality_status, QUALITY_STATUSES)):
            # A status may be a comma list ("Invoice Received,GRN Pending"), so a
            # dashboard tile opens exactly the lines it counts.
            values = [_choice(v, choices, key.replace("_", " ").capitalize())
                      for v in (_clean(f.get(key)) or "").split(",") if v.strip()]
            if values:
                q = q.filter(col.in_(values))
        supplier = _clean(f.get("supplier"), 160)
        if supplier:
            like = f"%{supplier}%"
            q = q.filter(or_(ChallanRegister.supplier_name.ilike(like), ChallanRegister.ven_cd.ilike(like)))
        part = _clean(f.get("part"), 120)
        if part:
            like = f"%{part}%"
            q = q.filter(or_(ChallanRegister.part_no.ilike(like), ChallanRegister.part_description.ilike(like)))
        text = _clean(f.get("q"), 120)
        if text:
            like = f"%{text}%"
            q = q.filter(or_(*(col.ilike(like) for col in (
                ChallanRegister.challan_id, ChallanRegister.challan_no, ChallanRegister.supplier_name,
                ChallanRegister.ven_cd, ChallanRegister.part_no, ChallanRegister.part_description,
                ChallanRegister.invoice_no, ChallanRegister.grn_reference, ChallanRegister.po_reference))))
        return q

    @staticmethod
    def _get(pk):
        row = db.session.get(ChallanRegister, pk)
        if row is None:
            raise NotFoundError(f"Challan {pk} not found")
        return row

    @staticmethod
    def _part(store_code, part_id):
        try:
            part = db.session.get(Part, int(part_id))
        except (TypeError, ValueError):
            part = None
        if part is None:
            raise BadRequestError("Pick the part from the Part No. search")
        if part.store_code != store_code:
            raise BadRequestError(f"Part {part.part_no} is not in this store")
        if not part.is_active:
            raise BadRequestError(f"Part {part.part_no} is inactive")
        return part

    @staticmethod
    def _po(data):
        po_status = _choice(data.get("po_status"), PO_STATUSES, "PO status")
        po_reference = _clean(data.get("po_reference"), 60, "PO reference")
        if po_status == "Approved" and not po_reference:
            raise BadRequestError("PO reference is required when the PO is approved")
        return po_status, po_reference

    @staticmethod
    def _supplier(part, data):
        """The supplier as the receipt / RGP screens take it (SupplierPicker): an
        ERP vendor of this part (its code checked against ERP's gate entries /
        GRNs), the supplier master, or a name only. Never a new master record."""
        from app.services.spare_rgp_service import SpareRgpService
        source = _clean(data.get("supplier_source"))
        if source not in SUPPLIER_SOURCES:
            raise BadRequestError("Select the supplier")
        supplier = None
        if data.get("supplier_id") not in (None, ""):
            try:
                supplier = db.session.get(Supplier, int(data.get("supplier_id")))
            except (TypeError, ValueError):
                supplier = None
            if supplier is None:
                raise BadRequestError("That supplier is not in the supplier master")
        elif source == "SUPPLIER_MASTER":
            raise BadRequestError("Pick the supplier from the supplier master")
        ven_cd = _clean(data.get("ven_cd"), 60, "Vendor code")
        erp_name = None
        if ven_cd:
            if source not in ERP_SUPPLIER_SOURCES:
                raise BadRequestError("A vendor code comes only from ERP — pick the supplier from the list")
            hit = SpareRgpService._erp_vendor(part.part_no, ven_cd)
            if hit is None:
                raise BadRequestError(f"Vendor code '{ven_cd}' is not an ERP vendor for {part.part_no} — "
                                      f"pick the supplier from the list")
            ven_cd, erp_name = hit
        name = _clean(data.get("supplier_name") or data.get("ven_name"), 160, "Supplier name") or erp_name or (
            supplier.supplier_name if supplier else None)
        if not name:
            raise BadRequestError("Supplier name is required")
        if ven_cd:
            key = f"VEN:{ven_cd.strip().upper()}"
        elif supplier is not None:
            key = f"SUP:{supplier.id}"
        else:
            key = f"NAME:{_key(name)}"
        return {"supplier_id": supplier.id if supplier else None, "ven_cd": ven_cd, "supplier_name": name,
                "supplier_source": source, "supplier_key": key}

    @staticmethod
    def _refuse_duplicate(store_code, supplier_key, challan_key, part, supplier_name, challan_no):
        dup = (ChallanRegister.query
               .filter(ChallanRegister.store_code == store_code, ChallanRegister.supplier_key == supplier_key,
                       ChallanRegister.challan_key == challan_key, ChallanRegister.part_id == part.id,
                       ChallanRegister.status != "Cancelled").first())
        if dup is not None:
            raise ConflictError(
                f"Challan {challan_no} for {part.part_no} from {supplier_name} is already registered as "
                f"{dup.challan_id}. A later lot comes on its own challan no.; if {dup.challan_id} was entered "
                f"wrongly, cancel it first.")

    @staticmethod
    def _next_id():
        from app.services.spare_report_service import plant_today
        prefix = f"CHL-{plant_today():%Y%m%d}-"
        last = (db.session.query(ChallanRegister.challan_id)
                .filter(ChallanRegister.challan_id.like(f"{prefix}%"))
                .order_by(ChallanRegister.challan_id.desc()).first())
        seq = 0
        if last and last[0]:
            try:
                seq = int(last[0].rsplit("-", 1)[1])
            except (ValueError, IndexError):
                seq = 0
        return f"{prefix}{seq + 1:03d}"

    @staticmethod
    def _erp_lines(row, grn_no):
        """The ERP GRN register's lines of this GRN no. for this part (and
        vendor, when the challan has one), first line first."""
        q = (ReceivingRegister.query
             .filter(func.upper(func.replace(ReceivingRegister.grn_no, " ", "")) == _key(grn_no),
                     func.upper(func.trim(ReceivingRegister.item_cd)) == row.part_no.strip().upper()))
        if row.ven_cd:
            q = q.filter(func.upper(func.trim(ReceivingRegister.ven_cd)) == row.ven_cd.strip().upper())
        return q.order_by(ReceivingRegister.id).all()

    @staticmethod
    def _grn_facts(lines, grn_no, grn_date):
        """A GRN as the link keeps it, from its register lines (summed), or the
        typed no. and date when ERP has none yet."""
        if not lines:
            return {"grn_reference": grn_no, "grn_date": grn_date, "receiving_register_id": None,
                    "grn_receipt_qty": None, "grn_accepted_qty": None, "grn_rejected_qty": None,
                    "quality_status": "Pending"}

        def total(col):
            values = [getattr(rr, col) for rr in lines if getattr(rr, col) is not None]
            return sum((_dec(v) for v in values), Decimal("0")) if values else None

        accepted, rejected = total("accept_qty"), total("reject_qty")
        return {"grn_reference": lines[0].grn_no, "grn_date": lines[0].grn_date,
                "receiving_register_id": lines[0].id, "grn_receipt_qty": total("receipt_qty"),
                "grn_accepted_qty": accepted, "grn_rejected_qty": rejected,
                "quality_status": _quality(accepted, rejected)}

    @staticmethod
    def _recompute(row):
        """The line's summaries and workflow status from its links (see the
        module docstring). A cancelled line keeps its status."""
        links = list(row.links)
        invoiced = sum((_dec(link.invoice_qty) for link in links), Decimal("0"))
        row.invoiced_qty = invoiced
        row.invoice_status = "Received" if links and invoiced >= _dec(row.challan_qty) else "Pending"
        invoices = list(dict.fromkeys(link.invoice_no for link in links))
        row.invoice_no = ", ".join(invoices)[:255] or None
        row.invoice_date = max((link.invoice_date for link in links), default=None)
        grns = list(dict.fromkeys(link.grn_reference for link in links if link.grn_reference))
        row.grn_reference = ", ".join(grns)[:255] or None
        graded = [link for link in links if link.grn_reference]
        if any(link.quality_status == "Rejected" for link in graded):
            row.quality_status = "Rejected"
        elif links and len(graded) == len(links) and all(link.quality_status == "OK" for link in graded):
            row.quality_status = "OK"
        else:
            row.quality_status = "Pending"
        if row.status == "Cancelled":
            return
        if invoiced < _dec(row.challan_qty):
            status = "Pending Invoice"
        elif any(not link.grn_reference for link in links):
            status = "Invoice Received"
        elif all(link.quality_status == "OK" for link in links):
            status = "GRN Completed"
        else:
            status = "GRN Pending"
        if status == "GRN Completed" and row.status != "GRN Completed":
            row.completed_at = utcnow()
        elif status != "GRN Completed":
            row.completed_at = None
        row.status = status

    @staticmethod
    def _log(row, action, from_status, to_status, details, user):
        db.session.add(ChallanHistory(challan_ref=row.id, action=action, from_status=from_status,
                                      to_status=to_status, details=json.dumps(details, default=str),
                                      by=_who(user)))

    @staticmethod
    def _value(row, key):
        value = getattr(row, key)
        return _iso(value) if isinstance(value, date) else (str(value) if isinstance(value, Decimal) else value)

    @staticmethod
    def _q(value):
        value = _dec(value)
        return f"{value:f}".rstrip("0").rstrip(".") if "." in f"{value:f}" else f"{value:f}"
