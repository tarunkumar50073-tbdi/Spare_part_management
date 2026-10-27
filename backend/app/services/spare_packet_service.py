"""Spare receipts, packets, QR labels and FIFO — the store's spec of 27 Oct 2026
(ERP gate entry -> physical verification -> packet creation -> unique QR labels
-> FIFO stock -> issue of whole packets). The models say what each thing is
(models/spare_packet.py); this is what may be done with them.

The store chose (27 Oct 2026):
  * stock comes in as today, when ERP accepts the GRN (ErpGrnPostingService);
    verifying, packing and printing never add stock — "ERP accept pe (abhi jaisa)";
  * stock already on the shelf stays loose and is issued by quantity, and the
    supervisor may make an OPENING batch of it to pack — "loose rahe, chaho to
    packet bana sako";
  * packet or individual unit is chosen when the labels are made, receipt by
    receipt — "label banate waqt supervisor chune".

Invariants kept here and in SpareStockService:
  * a receipt's packets never hold more than it was verified at (nor than it
    received), and all AVAILABLE packets of a part never more than its on hand;
  * a packet is issued whole, once (a conditional UPDATE: two scans of the same
    QR cannot both win), in the same transaction as the ISSUE ledger row;
  * FIFO is by receipt — received_on, then receipt id — not by the day a label
    was printed; issuing from a newer receipt while an older one still has
    packets needs a recorded reason.
"""
import math
import secrets
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation

from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError

from app.extensions import db
from app.models.base import utcnow
from app.models.label_print_audit import LabelPrintAudit
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.spare_packet import SpareBatch, SparePacket
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.models.store import Section
from app.utils.db_tx import atomic
from app.utils.exceptions import BadRequestError, NotFoundError

STORE = "MAINTENANCE"
CODE_PREFIX = "SPK-"
_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"     # no 0 / O / 1 / I to misread
MAX_PER_CALL = 500
MAX_QTY = Decimal("1000000")
PAGE_SIZE, MAX_PAGE_SIZE = 25, 100


def _token(n=8):
    return "".join(secrets.choice(_ALPHABET) for _ in range(n))


def _n(v):
    if v is None:
        return None
    v = float(v)
    return int(v) if v.is_integer() else round(v, 2)


def _iso(v):
    return v.isoformat() if v is not None else None


def _plant_date(stamp):
    if stamp is None:
        return None
    if isinstance(stamp, date) and not isinstance(stamp, datetime):
        return stamp
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone().date()


def _qty(value, label, allow_zero=False):
    try:
        q = Decimal(str(value).strip())
    except (InvalidOperation, ValueError, AttributeError):
        raise BadRequestError(f"{label} must be a number") from None
    if not q.is_finite() or q < 0 or (q == 0 and not allow_zero):
        raise BadRequestError(f"{label} must be {'0 or more' if allow_zero else 'more than 0'}")
    if q > MAX_QTY:
        raise BadRequestError(f"{label} is too large")
    if q != q.quantize(Decimal("0.01")):
        raise BadRequestError(f"{label} can have at most 2 decimals")
    return q


def _text(value, limit, label):
    t = str(value).strip() if value is not None else ""
    if len(t) > limit:
        raise BadRequestError(f"{label} is too long (at most {limit} characters)")
    return t or None


def _who(user):
    return (str(user) if user else "SYSTEM")[:60]


def normalize_code(code):
    return (code or "").strip().upper()


def is_packet_code(code):
    return normalize_code(code).startswith(CODE_PREFIX)


class SparePacketService:

    # ---- figures --------------------------------------------------------------------

    @staticmethod
    def packed_available(part_id):
        """The part's quantity sitting in AVAILABLE packets."""
        v = (db.session.query(func.coalesce(func.sum(SparePacket.qty), 0))
             .filter(SparePacket.part_id == part_id, SparePacket.status == "AVAILABLE").scalar())
        return float(v or 0)

    @staticmethod
    def _packed_of(receipt_id):
        """What a receipt's packets hold, issued or not (cancelled ones freed theirs)."""
        v = (db.session.query(func.coalesce(func.sum(SparePacket.qty), 0))
             .filter(SparePacket.batch_id == receipt_id, SparePacket.status != "CANCELLED").scalar())
        return float(v or 0)

    def _on_hand(self, part_id):
        row = SpareStock.query.filter_by(part_id=part_id).first()
        return float(row.qty_on_hand or 0) if row and row.qty_on_hand is not None else 0.0

    def figures(self, part_id):
        on_hand = self._on_hand(part_id)
        packed = self.packed_available(part_id)
        return {"on_hand": _n(on_hand), "packed_available": _n(packed),
                "loose": _n(round(on_hand - packed, 2))}

    # ---- receipts ---------------------------------------------------------------------

    @staticmethod
    def _new_receipt_no():
        for _ in range(10):
            no = f"RCP-{_token(6)}"
            if not SpareBatch.query.filter_by(receipt_no=no).first():
                return no
        raise BadRequestError("Could not make a receipt number — try again")

    def receipt_for_ledger(self, ledger, user=None):
        """The receipt (batch) for a RECEIPT ledger row, made once. An ERP GRN
        row takes its GRN date, gate entry and supplier from the ERP GRN
        register; any other receipt row the plant date it was written."""
        found = SpareBatch.query.filter_by(ledger_id=ledger.id).first()
        if found is not None:
            return found
        part = ledger.part if getattr(ledger, "part", None) is not None else db.session.get(Part, ledger.part_id)
        erp = (ledger.status or "") == "ERP_GRN"
        rr = None
        if erp and ledger.reference:
            key = ledger.reference.strip().upper()
            rr = (ReceivingRegister.query
                  .filter(func.upper(func.trim(ReceivingRegister.grn_no)) == key,
                          func.upper(func.trim(ReceivingRegister.item_cd)) == (part.part_no or "").strip().upper())
                  .order_by(ReceivingRegister.grn_date).first())
        received_on = (rr.grn_date if rr and rr.grn_date else None) or _plant_date(ledger.created_at) or date.today()
        receipt = SpareBatch(
            receipt_no=self._new_receipt_no(), store_code=part.store_code, part_id=part.id,
            source="ERP_GRN" if erp else "RECEIPT", ledger_id=ledger.id, received_on=received_on,
            qty=ledger.qty_delta, uom=part.uom,
            grn_no=ledger.reference if erp else None,
            gate_entry_no=rr.gate_entry_no if rr else None, gate_entry_dt=rr.gate_entry_dt if rr else None,
            invoice_no=getattr(ledger, "invoice_no", None) or (rr.challan_no if rr else None),
            supplier_name=rr.ven_name if rr else None, ven_cd=rr.ven_cd if rr else None,
            created_by=_who(user or ledger.created_by),
        )
        db.session.add(receipt)
        db.session.flush()
        return receipt

    def sync_receipts(self, store_code):
        """A receipt for every RECEIPT ledger row of the store's parts that has
        none yet — the ones posted before receipts existed, and any other
        receipt row. Safe to run again and again (one receipt per ledger row)."""
        missing = (SpareStockLedger.query
                   .join(Part, Part.id == SpareStockLedger.part_id)
                   .outerjoin(SpareBatch, SpareBatch.ledger_id == SpareStockLedger.id)
                   .filter(Part.store_code == store_code, SpareStockLedger.txn_type == "RECEIPT",
                           SpareStockLedger.qty_delta > 0, SpareBatch.id.is_(None))
                   .order_by(SpareStockLedger.id).limit(2000).all())
        made = 0
        for ledger in missing:
            try:
                with atomic():
                    self.receipt_for_ledger(ledger)
                made += 1
            except IntegrityError:
                db.session.rollback()       # made by a concurrent request a moment ago
        return made

    def opening_receipt(self, part_id, qty, user=None, remarks=None):
        """A batch of the stock already on the shelf, so it can be packed — the
        store's "loose rahe, chaho to packet bana sako". It is counted by the
        supervisor making it, so it is verified at once; its date is when the
        shelf was last counted (it is the oldest stock there is). No stock
        moves: it can take no more than is loose."""
        part = db.session.get(Part, part_id)
        if part is None or not part.is_active:
            raise NotFoundError(f"Part {part_id} not found")
        q = _qty(qty, "Quantity")
        with atomic():
            self._lock_stock(part.id)
            figs = self.figures(part.id)
            if float(q) > figs["loose"]:
                raise BadRequestError(f"Only {figs['loose']:g} {part.uom or ''} of {part.part_no} is loose "
                                      f"(on hand {figs['on_hand']:g}, in packets {figs['packed_available']:g})")
            row = SpareStock.query.filter_by(part_id=part.id).first()
            when = (_plant_date(row.last_counted_at) or _plant_date(row.created_at)) if row else None
            now = utcnow()
            receipt = SpareBatch(
                receipt_no=self._new_receipt_no(), store_code=part.store_code, part_id=part.id, source="OPENING",
                received_on=when or date.today(), qty=q, uom=part.uom,
                verify_status="VERIFIED", verified_qty=q, verified_by=_who(user), verified_at=now,
                verify_remarks=_text(remarks, 255, "Remarks") or "Stock on the shelf, counted when the batch was made",
                created_by=_who(user),
            )
            db.session.add(receipt)
            db.session.flush()
        return self.receipt_dict(receipt)

    def verify(self, receipt_id, counted_qty, user=None, remarks=None):
        """The supervisor's physical count of a receipt. Counted = received is
        VERIFIED; anything else is a MISMATCH and needs a remark. Labels can be
        made only after, and never for more than was counted."""
        receipt = self._receipt(receipt_id)
        counted = _qty(counted_qty, "Counted quantity", allow_zero=True)
        remarks = _text(remarks, 255, "Remarks")
        mismatch = counted != Decimal(str(receipt.qty))
        if mismatch and not remarks:
            raise BadRequestError(f"Counted {_n(counted)} but {_n(receipt.qty)} was received — say why in Remarks")
        with atomic():
            packed = self._packed_of(receipt.id)
            if float(counted) < packed:
                raise BadRequestError(f"{packed:g} of this receipt is already in packets — the count cannot be less")
            receipt.verified_qty = counted
            receipt.verify_status = "MISMATCH" if mismatch else "VERIFIED"
            receipt.verified_by = _who(user)
            receipt.verified_at = utcnow()
            receipt.verify_remarks = remarks
        return self.receipt_dict(receipt)

    # ---- packets ----------------------------------------------------------------------

    @staticmethod
    def _new_code():
        for _ in range(20):
            code = CODE_PREFIX + _token(8)
            if not SparePacket.query.filter_by(code=code).first():
                return code
        raise BadRequestError("Could not make a unique packet code — try again")

    def plan(self, receipt, kind, packet_qty=None, count=None, last_smaller=False):
        """How a receipt's remaining verified quantity would be packed: the
        packets' quantities, and what stays loose. Nothing is written."""
        if receipt.verify_status not in ("VERIFIED", "MISMATCH"):
            raise BadRequestError("Verify the receipt physically first — labels come after the count")
        verified = float(receipt.verified_qty if receipt.verified_qty is not None else 0)
        packable = round(min(verified, float(receipt.qty)) - self._packed_of(receipt.id), 2)
        if packable <= 0:
            raise BadRequestError("Everything verified on this receipt is already packed")
        if kind == "UNIT":
            size = Decimal("1")
        elif kind == "PACKET":
            size = _qty(packet_qty, "Quantity per packet")
        else:
            raise BadRequestError("Choose Small Parts Packet or Individual Part")
        full = math.floor(round(packable / float(size), 6))
        n = full if count in (None, "") else int(_qty(count, "Number of packets"))
        if n > full:
            raise BadRequestError(f"Only {full} full packet(s) of {_n(size)} fit in the {packable:g} left to pack")
        sizes = [size] * n
        rest = round(packable - n * float(size), 2)
        if last_smaller:
            if kind == "UNIT":
                raise BadRequestError("An individual part is one piece — no smaller last label")
            if n != full or rest <= 0:
                raise BadRequestError("A smaller last packet is made only when packing all that is left")
            sizes.append(Decimal(str(rest)))
            rest = 0.0
        if not sizes:
            raise BadRequestError(f"{packable:g} is left — less than one packet of {_n(size)}"
                                  + ("" if kind == "UNIT" else "; tick the smaller last packet to pack it"))
        if len(sizes) > MAX_PER_CALL:
            raise BadRequestError(f"At most {MAX_PER_CALL} labels at a time")
        return {"packable": packable, "sizes": sizes, "loose_after": rest}

    def pack(self, receipt_id, kind, packet_qty=None, count=None, last_smaller=False, user=None):
        """Make the receipt's packets (or individual units), each with its own
        QR code. Stock does not change: the packets are part of what is on
        hand, never more than is loose."""
        kind = (kind or "").upper()
        receipt = self._receipt(receipt_id)
        with atomic():
            self._lock_stock(receipt.part_id)
            db.session.refresh(receipt)
            plan = self.plan(receipt, kind, packet_qty, count, last_smaller)
            total = float(sum(plan["sizes"]))
            figs = self.figures(receipt.part_id)
            if total > figs["loose"] + 1e-9:
                raise BadRequestError(
                    f"Only {figs['loose']:g} of {receipt.part.part_no} is loose on the shelf "
                    f"(on hand {figs['on_hand']:g}, in packets {figs['packed_available']:g}) — "
                    f"{total:g} cannot be packed")
            seq = (db.session.query(func.coalesce(func.max(SparePacket.seq), 0))
                   .filter(SparePacket.batch_id == receipt.id).scalar() or 0)
            made = []
            for size in plan["sizes"]:
                seq += 1
                p = SparePacket(code=self._new_code(), kind=kind, batch_id=receipt.id, part_id=receipt.part_id,
                                seq=seq, qty=size, uom=receipt.uom or receipt.part.uom,
                                location=receipt.part.location, status="AVAILABLE", created_by=_who(user))
                db.session.add(p)
                made.append(p)
            db.session.flush()
        return {"receipt": self.receipt_dict(receipt), "packets": [self.packet_dict(p) for p in made],
                "loose_after": _n(plan["loose_after"])}

    def cancel(self, code, reason, user=None):
        """Take back a packet made by mistake (AVAILABLE only). Its quantity is
        loose again; the code is never reused."""
        reason = _text(reason, 255, "Reason")
        if not reason:
            raise BadRequestError("Say why the packet is cancelled")
        packet = self._packet(code)
        with atomic():
            done = (SparePacket.query.filter_by(id=packet.id, status="AVAILABLE")
                    .update({"status": "CANCELLED", "cancelled_at": utcnow(), "cancelled_by": _who(user),
                             "cancel_reason": reason}, synchronize_session=False))
            if not done:
                raise BadRequestError(f"Packet {packet.code} is {packet.status.lower()} — only an available one "
                                      "can be cancelled")
        db.session.refresh(packet)
        return self.packet_dict(packet)

    # ---- FIFO and issue ---------------------------------------------------------------------

    @staticmethod
    def _fifo_query(part_id):
        return (SparePacket.query.join(SpareBatch, SpareBatch.id == SparePacket.batch_id)
                .filter(SparePacket.part_id == part_id, SparePacket.status == "AVAILABLE")
                .order_by(SpareBatch.received_on, SpareBatch.id, SparePacket.seq, SparePacket.id))

    def fifo_check(self, packet):
        """None when the packet is from the oldest receipt that still has
        packets; otherwise that oldest packet — issuing this one would skip it."""
        first = self._fifo_query(packet.part_id).first()
        if first is None or first.batch_id == packet.batch_id:
            return None
        a, b = first.batch, packet.batch
        if (a.received_on, a.id) < (b.received_on, b.id):
            return first
        return None

    def fifo(self, part_id):
        """The part's available packets in issue order, with its figures."""
        part = db.session.get(Part, part_id)
        if part is None:
            raise NotFoundError(f"Part {part_id} not found")
        rows = self._fifo_query(part_id).all()
        first_receipt = rows[0].batch_id if rows else None
        return {
            "part": self._part_dict(part), **self.figures(part_id),
            "packets": [{**self.packet_dict(p), "rank": i + 1, "issue_first": p.batch_id == first_receipt}
                        for i, p in enumerate(rows)],
        }

    def issue(self, code, department, user=None, employee_id=None, issued_to_mobile=None, issued_to=None,
              remarks=None, override_reason=None, scan_source=None):
        """Issue a whole packet (or one individual unit): its full quantity,
        once, to a department + person, through the same issue as Scan Part's
        (ISSUE ledger row, journal). Skipping an older receipt's packets needs
        a reason, kept on the packet."""
        from app.services.spare_stock_service import SpareStockService
        packet = self._packet(code)
        if packet.status != "AVAILABLE":
            when = packet.issued_at.astimezone().strftime("%d-%b-%Y %H:%M") if packet.issued_at else ""
            raise BadRequestError(
                f"Packet {packet.code} was already issued{(' on ' + when) if when else ''}"
                f"{(' to ' + packet.department) if packet.department else ''}"
                if packet.status == "ISSUED" else f"Packet {packet.code} was cancelled — it cannot be issued")
        reason = _text(override_reason, 255, "FIFO reason")
        older = self.fifo_check(packet)
        if older is not None and not reason:
            raise BadRequestError(
                f"Older stock first: packet {older.code} (received {older.batch.received_on:%d-%b-%Y}) "
                f"should go before this one (received {packet.batch.received_on:%d-%b-%Y}). "
                "Issue that one, or give a reason to issue this one.",
                errors={"code": "FIFO", "oldest": self.packet_dict(older)})
        stock = SpareStockService()
        with atomic():
            won = (SparePacket.query.filter_by(id=packet.id, status="AVAILABLE")
                   .update({"status": "ISSUED", "issued_at": utcnow(), "issued_by": _who(user),
                            "department": _text(department, 60, "Department"),
                            "fifo_override_reason": reason if older is not None else None},
                           synchronize_session=False))
            if not won:
                raise BadRequestError(f"Packet {packet.code} was just issued from another screen")
            note = f"Packet {packet.code} ({packet.kind.lower()}, receipt {packet.batch.receipt_no})"
            if older is not None:
                note += f" — FIFO skipped: {reason}"
            if remarks:
                note += f" · {remarks}"
            result = stock.issue(
                packet.part_id, float(packet.qty), department, reference=packet.code, remarks=note[:255],
                user=user, issued_to=issued_to, employee_id=employee_id, issued_to_mobile=issued_to_mobile,
                scanned_code=packet.code, scan_source=scan_source, from_packet=True,
            )
            SparePacket.query.filter_by(id=packet.id).update(
                {"issue_ledger_id": result["issue"]["id"], "issued_to": (result["issue"].get("issued_to") or "")[:120]},
                synchronize_session=False)
        db.session.refresh(packet)
        result["packet"] = self.packet_dict(packet)
        return result

    # ---- labels -------------------------------------------------------------------------------

    def record_print(self, codes, reprint=False, reason=None, user=None):
        """The labels came out of the printer: one print-audit row per packet
        (Part, the code printed, the location printed, the receipt), and the
        packet's print count. A reprint needs a reason. Never touches stock."""
        codes = [normalize_code(c) for c in (codes or []) if normalize_code(c)]
        if not codes:
            raise BadRequestError("No labels to record")
        if len(codes) > MAX_PER_CALL:
            raise BadRequestError(f"At most {MAX_PER_CALL} labels at a time")
        reason = _text(reason, 255, "Reason")
        if reprint and not reason:
            raise BadRequestError("Say why the label is printed again (torn, lost, faded …)")
        packets = SparePacket.query.filter(SparePacket.code.in_(codes)).all()
        found = {p.code for p in packets}
        missing = [c for c in codes if c not in found]
        if missing:
            raise NotFoundError(f"No packet {missing[0]}")
        not_available = [p.code for p in packets if p.status != "AVAILABLE"]
        if not_available:
            raise BadRequestError(f"Packet {not_available[0]} is not available — its label is not printed")
        printed = [p.code for p in packets if p.print_count and not reprint]
        if printed:
            raise BadRequestError(f"The label of {printed[0]} is printed already — reprint it, with a reason")
        with atomic():
            now = utcnow()
            for p in packets:
                db.session.add(LabelPrintAudit(
                    part_id=p.part_id, barcode_value=p.code, copies=1, printed_by=_who(user),
                    is_reprint=bool(reprint), reason=reason, source="PACKET",
                    symbology="QR", location_printed=(p.location or "")[:40] or None,
                    reference=p.batch.receipt_no))
                p.print_count = (p.print_count or 0) + 1
                p.last_printed_at = now
        return {"recorded": len(packets)}

    # ---- reading ---------------------------------------------------------------------------------

    def receipts(self, store_code, status=None, q=None, page=1, page_size=PAGE_SIZE):
        """Receipts newest first, each with what is verified, packed, issued
        and still to pack. status: PENDING (not verified), TO_PACK (verified,
        something left to pack), PACKED, or blank for all."""
        self.sync_receipts(store_code)
        query = SpareBatch.query.join(Part, Part.id == SpareBatch.part_id).filter(
            SpareBatch.store_code == store_code)
        text = (q or "").strip()
        if text:
            like = f"%{text}%"
            query = query.filter(or_(Part.part_no.ilike(like), Part.part_name.ilike(like),
                                     SpareBatch.grn_no.ilike(like), SpareBatch.gate_entry_no.ilike(like),
                                     SpareBatch.receipt_no.ilike(like), SpareBatch.supplier_name.ilike(like)))
        if status == "PENDING":
            query = query.filter(SpareBatch.verify_status == "PENDING")
        rows = query.order_by(SpareBatch.received_on.desc(), SpareBatch.id.desc()).all()
        out = [self.receipt_dict(r) for r in rows]
        if status == "TO_PACK":
            out = [r for r in out if r["verify_status"] != "PENDING" and r["to_pack"] > 0]
        elif status == "PACKED":
            out = [r for r in out if r["verify_status"] != "PENDING" and r["to_pack"] <= 0]
        size = max(1, min(int(page_size or PAGE_SIZE), MAX_PAGE_SIZE))
        page = max(1, int(page or 1))
        return {"rows": out[(page - 1) * size: page * size], "total": len(out), "page": page,
                "pages": -(-len(out) // size), "page_size": size}

    def packets(self, store_code, status=None, q=None, page=1, page_size=PAGE_SIZE, issued=False,
                date_from=None, date_to=None):
        """Packets of the store: AVAILABLE in FIFO order, or (issued=True) the
        issue history newest first with department, person and who issued."""
        query = (SparePacket.query.join(SpareBatch, SpareBatch.id == SparePacket.batch_id)
                 .join(Part, Part.id == SparePacket.part_id).filter(Part.store_code == store_code))
        if issued:
            query = query.filter(SparePacket.status == "ISSUED")
            if date_from:
                query = query.filter(SparePacket.issued_at >= datetime.combine(date.fromisoformat(date_from),
                                                                              datetime.min.time()).astimezone())
            if date_to:
                query = query.filter(SparePacket.issued_at < datetime.combine(
                    date.fromordinal(date.fromisoformat(date_to).toordinal() + 1), datetime.min.time()).astimezone())
        elif status:
            query = query.filter(SparePacket.status == status)
        text = (q or "").strip()
        if text:
            like = f"%{text}%"
            query = query.filter(or_(Part.part_no.ilike(like), Part.part_name.ilike(like),
                                     SparePacket.code.ilike(like), SpareBatch.receipt_no.ilike(like),
                                     SpareBatch.grn_no.ilike(like), SparePacket.department.ilike(like),
                                     SparePacket.issued_to.ilike(like)))
        order = ((SparePacket.issued_at.desc(), SparePacket.id.desc()) if issued else
                 (Part.part_no, SpareBatch.received_on, SpareBatch.id, SparePacket.seq))
        total = query.count()
        size = max(1, min(int(page_size or PAGE_SIZE), MAX_PAGE_SIZE))
        page = max(1, int(page or 1))
        rows = query.order_by(*order).offset((page - 1) * size).limit(size).all()
        return {"rows": [self.packet_dict(p) for p in rows], "total": total, "page": page,
                "pages": -(-total // size), "page_size": size}

    def get(self, code):
        p = self._packet(code)
        out = self.packet_dict(p)
        older = self.fifo_check(p) if p.status == "AVAILABLE" else None
        out["fifo"] = {"ok": older is None, "oldest": self.packet_dict(older) if older else None}
        return out

    def parts(self, store_code, q, limit=20):
        """Parts to make an opening batch of: the store's, with what is loose."""
        text = (q or "").strip()
        if len(text) < 2:
            return []
        like = f"%{text}%"
        rows = (Part.query.filter(Part.store_code == store_code, Part.is_active.is_(True),
                                  or_(Part.part_no.ilike(like), Part.part_name.ilike(like),
                                      Part.specification.ilike(like), Part.model_no.ilike(like)))
                .order_by(func.length(Part.part_no), Part.part_no).limit(max(1, min(int(limit), 50))).all())
        return [{**self._part_dict(p), **self.figures(p.id)} for p in rows]

    # ---- shapes --------------------------------------------------------------------------------

    @staticmethod
    def _part_dict(part):
        section = db.session.get(Section, part.section_id) if part.section_id else None
        return {"id": part.id, "part_no": part.part_no, "part_name": part.part_name, "uom": part.uom,
                "location": part.location, "rework_location": part.rework_location,
                "specification": part.specification, "model_no": getattr(part, "model_no", None),
                "section": section.name if section else None}

    def receipt_dict(self, r):
        packed = self._packed_of(r.id)
        counts = dict(db.session.query(SparePacket.status, func.count(SparePacket.id))
                      .filter(SparePacket.batch_id == r.id).group_by(SparePacket.status).all())
        issued_qty = float(db.session.query(func.coalesce(func.sum(SparePacket.qty), 0))
                           .filter(SparePacket.batch_id == r.id, SparePacket.status == "ISSUED").scalar() or 0)
        verified = float(r.verified_qty) if r.verified_qty is not None else None
        limit = min(verified, float(r.qty)) if verified is not None else 0.0
        return {
            "id": r.id, "receipt_no": r.receipt_no, "source": r.source, "store_code": r.store_code,
            "part": SparePacketService._part_dict(r.part), "received_on": _iso(r.received_on),
            "qty": _n(r.qty), "uom": r.uom or r.part.uom, "grn_no": r.grn_no, "gate_entry_no": r.gate_entry_no,
            "gate_entry_dt": _iso(r.gate_entry_dt), "invoice_no": r.invoice_no, "supplier_name": r.supplier_name,
            "verify_status": r.verify_status, "verified_qty": _n(r.verified_qty), "verified_by": r.verified_by,
            "verified_at": _iso(r.verified_at), "verify_remarks": r.verify_remarks,
            "packed_qty": _n(packed), "issued_qty": _n(issued_qty),
            "to_pack": _n(round(max(limit - packed, 0), 2)),
            "packets": {"available": counts.get("AVAILABLE", 0), "issued": counts.get("ISSUED", 0),
                        "cancelled": counts.get("CANCELLED", 0)},
            "created_by": r.created_by, "created_at": _iso(r.created_at),
        }

    @staticmethod
    def packet_dict(p):
        if p is None:
            return None
        r = p.batch
        return {
            "id": p.id, "code": p.code, "kind": p.kind, "seq": p.seq, "qty": _n(p.qty), "uom": p.uom,
            "location": p.location, "status": p.status, "part": SparePacketService._part_dict(p.part),
            "receipt": {"id": r.id, "receipt_no": r.receipt_no, "source": r.source, "received_on": _iso(r.received_on),
                        "grn_no": r.grn_no, "gate_entry_no": r.gate_entry_no, "supplier_name": r.supplier_name},
            "created_by": p.created_by, "created_at": _iso(p.created_at),
            "issued_at": _iso(p.issued_at), "issued_by": p.issued_by, "department": p.department,
            "issued_to": p.issued_to, "issue_ledger_id": p.issue_ledger_id,
            "fifo_override_reason": p.fifo_override_reason,
            "cancelled_at": _iso(p.cancelled_at), "cancelled_by": p.cancelled_by, "cancel_reason": p.cancel_reason,
            "print_count": p.print_count or 0, "last_printed_at": _iso(p.last_printed_at),
        }

    # ---- helpers ------------------------------------------------------------------------------

    @staticmethod
    def _receipt(receipt_id):
        r = db.session.get(SpareBatch, receipt_id)
        if r is None:
            raise NotFoundError(f"Receipt {receipt_id} not found")
        return r

    @staticmethod
    def _packet(code):
        p = SparePacket.query.filter_by(code=normalize_code(code)).first()
        if p is None:
            raise NotFoundError(f"No packet {normalize_code(code) or '(blank)'}")
        return p

    @staticmethod
    def _lock_stock(part_id):
        """The part's stock row locked, so packing and issuing the same part
        can't race (SpareStockService._lock)."""
        from app.services.spare_stock_service import SpareStockService
        row = SpareStock.query.filter_by(part_id=part_id).first()
        if row is not None:
            SpareStockService._lock(SpareStock, row.id)
