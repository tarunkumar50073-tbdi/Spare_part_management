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

And on 27 Oct 2026, later:
  * the stock already on the shelf gets labels too, rack by rack — the Old
    stock list (old_stock): count, pack, print. A receipt row from before the
    receipts were first read is old stock, never a receipt to verify;
  * a box that comes with the supplier's own QR / barcode gets no label of
    ours — "uske qr/bar ko map karenge apne part k saath". If every box's code
    differs, each box is a packet carrying that code (supplier_code: FIFO and
    one issue, as our labels); if the code is the same on every box, a box
    cannot be told apart, so the code is mapped to the part (Map to Part) and
    the stock stays loose, issued by scanning it with a quantity.

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
import re
import secrets
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation

from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError

from app.extensions import db
from app.models.base import utcnow
from app.models.app_setting import AppSetting
from app.models.label_print_audit import LabelPrintAudit
from app.models.part import Part
from app.models.part_barcode import PartBarcode
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
# When receipts started being kept (app_settings): the first time the receipts
# were read. A receipt row from before is old stock on the shelf.
SINCE_KEY = "spare_packets_receipts_since"
SUPPLIER_CODE_MAX = 255
# A box's code that is the same on every box (it names the part already, or two
# boxes were scanned alike): the screen offers to map it to the part instead.
SAME_CODE = "SAME_CODE"
# The Old stock list's states: nothing labelled yet; some labelled, more left;
# all of it labelled (or waiting in a receipt to be packed); and the part's
# supplier code is mapped, so its loose stock scans as it is.
OLD_TODO, OLD_PARTLY, OLD_DONE, OLD_RECEIPT, OLD_SUPPLIER = "TODO", "PARTLY", "DONE", "RECEIPT", "SUPPLIER"
OLD_SHOW = {"todo": (OLD_TODO, OLD_PARTLY), "done": (OLD_DONE, OLD_RECEIPT, OLD_SUPPLIER)}


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


def rack_of(location):
    """The rack a location is on — its first part: "R14-S1-B1 (2)" -> "R14"."""
    text = (location or "").strip().upper()
    return re.split(r"[-/ ]", text)[0] if text else "No location"


def _natural(text):
    """"R2" before "R10": the digits compared as numbers."""
    return [(0, int(t), "") if t.isdigit() else (1, 0, t) for t in re.split(r"(\d+)", (text or "").upper()) if t]


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

    @staticmethod
    def receipts_since():
        """When receipts started being kept on this database: saved the first
        time it is asked (the receipts list's first read), or the first receipt
        batch made, if that was earlier. Stock received before is old stock —
        packed from the Old stock list, never a receipt to verify (it may be
        long issued)."""
        saved = AppSetting.get_value(SINCE_KEY)
        if saved:
            return datetime.fromisoformat(saved)
        first = (db.session.query(func.min(SpareBatch.created_at))
                 .filter(SpareBatch.source != "OPENING").scalar())
        now = utcnow()
        if first is not None and first.tzinfo is None:
            first = first.replace(tzinfo=timezone.utc)
        since = min(first, now) if first is not None else now
        AppSetting.set_value(SINCE_KEY, since.isoformat(), "SYSTEM")
        return since

    def sync_receipts(self, store_code):
        """A receipt for every RECEIPT ledger row of the store's parts that has
        none yet and came in since receipts are kept (receipts_since) — one an
        ERP GRN post missed, or another receipt row. Safe to run again and
        again (one receipt per ledger row)."""
        since = self.receipts_since()
        missing = (SpareStockLedger.query
                   .join(Part, Part.id == SpareStockLedger.part_id)
                   .outerjoin(SpareBatch, SpareBatch.ledger_id == SpareStockLedger.id)
                   .filter(Part.store_code == store_code, SpareStockLedger.txn_type == "RECEIPT",
                           SpareStockLedger.qty_delta > 0, SpareBatch.id.is_(None),
                           SpareStockLedger.created_at >= since)
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
        if receipt.loose_note:
            raise BadRequestError(f"This receipt is kept loose: {receipt.loose_note}")
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

    def pack(self, receipt_id, kind, packet_qty=None, count=None, last_smaller=False, user=None,
             supplier_codes=None):
        """Make the receipt's packets (or individual units), each with its own
        QR code. Stock does not change: the packets are part of what is on
        hand, never more than is loose. `supplier_codes`: the boxes came with
        the supplier's own label — one code read off each box, in packet
        order; no label of ours is printed for them."""
        kind = (kind or "").upper()
        receipt = self._receipt(receipt_id)
        with atomic():
            self._lock_stock(receipt.part_id)
            db.session.refresh(receipt)
            plan = self.plan(receipt, kind, packet_qty, count, last_smaller)
            boxes = (self._box_codes(supplier_codes, len(plan["sizes"]), receipt.part)
                     if supplier_codes is not None else None)
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
            for i, size in enumerate(plan["sizes"]):
                seq += 1
                p = SparePacket(code=self._new_code(), kind=kind, batch_id=receipt.id, part_id=receipt.part_id,
                                seq=seq, qty=size, uom=receipt.uom or receipt.part.uom,
                                location=receipt.part.location, status="AVAILABLE", created_by=_who(user),
                                supplier_code=boxes[i] if boxes else None)
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

    # ---- the supplier's own label ----------------------------------------------------------

    @staticmethod
    def _names_part(code):
        """The part a whole read names today — an active mapping, a Part No. or
        a part's own barcode — or None."""
        from app.services.barcode_service import BarcodeService
        bs = BarcodeService()
        mapping = bs.pb_repo.get_active_by_code(code)
        return mapping.part if mapping else bs.part_repo.get_by_scan_code(code)

    def _code_problem(self, code, part):
        """(message, same) when a box's code cannot be that box's own code:
        `same` = it is the part's code (the same on every box: keep it loose)."""
        if is_packet_code(code):
            return "That is one of our packet labels (SPK-…), not the supplier's code", False
        if len(code) > SUPPLIER_CODE_MAX:
            return f"The code is longer than {SUPPLIER_CODE_MAX} characters", False
        boxed = SparePacket.query.filter_by(supplier_code=code, status="AVAILABLE").first()
        if boxed is not None:
            return f"This code is already on packet {boxed.code} ({boxed.part.part_no}) on the shelf", False
        named = self._names_part(code)
        if named is not None:
            if named.id == part.id:
                return (f"This code is {part.part_no}'s own code (its Part No. or a code mapped to it) — the same on "
                        "every box, so a box cannot be told apart. Keep the stock loose: it is issued by scanning "
                        "this code with a quantity.", True)
            return f"This code belongs to another part, {named.part_no}", False
        return None, False

    def check_box_code(self, part_id, code):
        """What the screen says as each box's code is scanned: ok, or why not
        (same = the part's own code, so keep the stock loose instead)."""
        part = self._part(part_id)
        code = (code or "").strip()
        if not code:
            raise BadRequestError("Scan the code on the box")
        message, same = self._code_problem(code, part)
        return {"code": code, "ok": message is None, "message": message, "same": same,
                "fields": self._mappable(code)}

    def _box_codes(self, codes, n, part):
        """The boxes' codes, one per packet, each its box's own."""
        codes = [str(c).strip() if c is not None else "" for c in (codes or [])]
        if len(codes) != n or not all(codes):
            raise BadRequestError(f"Scan the supplier's code on every box: {n} box{'es' if n != 1 else ''}, "
                                  f"{sum(1 for c in codes if c)} scanned")
        first = {}
        for i, code in enumerate(codes):
            if code in first:
                raise BadRequestError(
                    f"Box {i + 1} has the same code as box {first[code] + 1} — the supplier's code is the same on "
                    "every box, so a box cannot be told apart. Keep the stock loose (the code is mapped to the "
                    "part and issued with a quantity), or print our labels.",
                    errors={"code": SAME_CODE, "scanned": code, "fields": self._mappable(code)})
            first[code] = i
            message, same = self._code_problem(code, part)
            if message:
                raise BadRequestError(f"Box {i + 1}: {message}",
                                      errors={"code": SAME_CODE if same else "BAD_CODE", "scanned": code,
                                              "fields": self._mappable(code)})
        return codes

    @staticmethod
    def _mappable(code):
        """What of a read can be mapped to a part: the whole read, and each of
        its fields (a supplier QR "ITEM|LOT|QTY") — none longer than a mapping
        holds."""
        from app.services.barcode_service import SCAN_CODE_MAX, scan_fields
        out = [code] if len(code) <= SCAN_CODE_MAX else []
        out += [f for f in scan_fields(code) if f != code and len(f) <= SCAN_CODE_MAX]
        return out

    def keep_loose(self, part_id, scanned, map_code=None, receipt_id=None, user=None):
        """The supplier's code is the same on every box: map it to the part, so
        scanning it names the part (Map to Part) — the stock stays loose and is
        issued with a quantity. A code that names the part already needs no
        mapping; one naming another part is refused. With `receipt_id`, that
        receipt is marked kept loose — nothing left to pack."""
        from app.services.barcode_service import BarcodeService
        part = self._part(part_id)
        scanned = (scanned or "").strip()
        if not scanned:
            raise BadRequestError("Scan the code on the box")
        if is_packet_code(scanned):
            raise BadRequestError("That is one of our packet labels (SPK-…), not the supplier's code")
        receipt = None
        if receipt_id is not None:
            receipt = self._receipt(receipt_id)
            if receipt.part_id != part.id:
                raise BadRequestError("That receipt is of another part")
            if receipt.verify_status not in ("VERIFIED", "MISMATCH"):
                raise BadRequestError("Verify the receipt physically first — labels come after the count")
        bs = BarcodeService()
        named = self._names_part(scanned)
        if named is None:
            field = bs._field_match(scanned)
            named = self._names_part(field) if field else None
        if named is not None and named.id != part.id:
            raise BadRequestError(f"This code belongs to another part, {named.part_no} — it cannot be "
                                  f"mapped to {part.part_no}")
        mapped = None
        with atomic():
            if named is None:
                fields = self._mappable(scanned)
                # A read of one field maps as it is; of several (ITEM|LOT|QTY), the
                # item code is picked — the whole read would change lot to lot.
                choice = (map_code or "").strip() or (fields[0] if len(fields) == 1 else "")
                if choice not in fields:
                    raise BadRequestError("Pick the part's item code out of the scanned code",
                                          errors={"code": "PICK_FIELD", "fields": fields})
                bs.map_supplier_barcode(part.id, choice, user=_who(user))
                mapped = choice
            if receipt is not None:
                shown = mapped or scanned
                receipt.loose_note = (f"Supplier code {shown[:80]} is the same on every box — kept loose, "
                                      "issued by scanning it with a quantity")[:255]
        return {"mapped": mapped, "already": named is not None, "part": self._part_dict(part),
                "receipt": self.receipt_dict(receipt) if receipt is not None else None}

    def reopen(self, receipt_id):
        """Undo keep_loose on a receipt: it can be packed again (the code stays mapped)."""
        receipt = self._receipt(receipt_id)
        with atomic():
            receipt.loose_note = None
        return self.receipt_dict(receipt)

    # ---- old stock on the shelf -------------------------------------------------------------

    def _old_figures(self, part_ids=None, store_code=None):
        """{part id: (packed available, packets ever, waiting in receipts)} —
        waiting = what open receipts (not OPENING, not kept loose) still have
        to pack: that stock gets its labels in the Receipts tab."""
        def scope(q, col):
            if part_ids is not None:
                return q.filter(col.in_(part_ids))
            return q.join(Part, Part.id == col).filter(Part.store_code == store_code)

        packed = dict(scope(db.session.query(SparePacket.part_id, func.sum(SparePacket.qty))
                            .filter(SparePacket.status == "AVAILABLE"), SparePacket.part_id)
                      .group_by(SparePacket.part_id).all())
        ever = dict(scope(db.session.query(SparePacket.part_id, func.count(SparePacket.id))
                          .filter(SparePacket.status != "CANCELLED"), SparePacket.part_id)
                    .group_by(SparePacket.part_id).all())
        in_batch = dict(scope(db.session.query(SparePacket.batch_id, func.sum(SparePacket.qty))
                              .filter(SparePacket.status != "CANCELLED"), SparePacket.part_id)
                        .group_by(SparePacket.batch_id).all())
        waiting = {}
        batches = scope(SpareBatch.query.filter(SpareBatch.source != "OPENING", SpareBatch.loose_note.is_(None)),
                        SpareBatch.part_id).all()
        for b in batches:
            limit = float(b.qty) if b.verify_status == "PENDING" else min(float(b.verified_qty or 0), float(b.qty))
            left = round(limit - float(in_batch.get(b.id) or 0), 2)
            if left > 0:
                waiting[b.part_id] = round(waiting.get(b.part_id, 0) + left, 2)
        ids = set(packed) | set(ever) | set(waiting)
        return {pid: (float(packed.get(pid) or 0), int(ever.get(pid) or 0), float(waiting.get(pid) or 0))
                for pid in ids}

    @staticmethod
    def _old_row(on_hand, packed, ever, waiting, supplier):
        loose = max(round(on_hand - packed, 2), 0.0)
        wait = min(waiting, loose)
        todo = round(loose - wait, 2)
        if todo > 0:
            state = OLD_PARTLY if ever else (OLD_SUPPLIER if supplier else OLD_TODO)
        else:
            state = OLD_RECEIPT if wait > 0 else OLD_DONE
        return {"on_hand": _n(on_hand), "packed_available": _n(packed), "loose": _n(loose),
                "waiting_in_receipts": _n(wait), "to_label": _n(todo), "packets_made": ever, "state": state}

    def old_figures(self, part_id):
        part = self._part(part_id)
        packed, ever, waiting = self._old_figures([part.id]).get(part.id, (0.0, 0, 0.0))
        supplier = PartBarcode.query.filter_by(part_id=part.id, source="SUPPLIER", is_active=True).first()
        return self._old_row(self._on_hand(part.id), packed, ever, waiting, supplier is not None)

    def old_stock(self, store_code, section_id=None, rack=None, q=None, show="todo", page=1, page_size=50):
        """The Old stock list: every active part with stock on the shelf, rack
        by rack (section, rack, location, Part No.), what of it has no label
        yet (to_label = loose - what waits in a receipt) and its state, with
        the progress of the section / rack picked. `show`: todo (nothing or
        part labelled), done, or all."""
        query = (db.session.query(Part, SpareStock.qty_on_hand)
                 .join(SpareStock, SpareStock.part_id == Part.id)
                 .filter(Part.store_code == store_code, Part.is_active.is_(True), SpareStock.qty_on_hand > 0))
        if section_id not in (None, ""):
            if not str(section_id).strip().isdigit():
                raise BadRequestError("section_id must be a whole number")
            query = query.filter(Part.section_id == int(section_id))
        text = (q or "").strip()
        if text:
            like = f"%{text}%"
            query = query.filter(or_(Part.part_no.ilike(like), Part.part_name.ilike(like),
                                     Part.location.ilike(like), Part.specification.ilike(like)))
        found = query.all()
        figs = self._old_figures(store_code=store_code)
        supplier = {pid for (pid,) in db.session.query(PartBarcode.part_id)
                    .join(Part, Part.id == PartBarcode.part_id)
                    .filter(Part.store_code == store_code, PartBarcode.source == "SUPPLIER",
                            PartBarcode.is_active.is_(True)).distinct()}
        sections = {s.id: s.name for s in Section.query.all()}
        rows, racks = [], {}
        wanted_rack = (rack or "").strip().upper() or None
        for part, on_hand in found:
            packed, ever, waiting = figs.get(part.id, (0.0, 0, 0.0))
            row = self._old_row(float(on_hand or 0), packed, ever, waiting, part.id in supplier)
            r = rack_of(part.location)
            tally = racks.setdefault(r, {"rack": r, "parts": 0, "to_do": 0})
            tally["parts"] += 1
            tally["to_do"] += row["state"] in OLD_SHOW["todo"]
            if wanted_rack and r != wanted_rack:
                continue
            rows.append({"part": {"id": part.id, "part_no": part.part_no, "part_name": part.part_name,
                                  "uom": part.uom, "location": part.location,
                                  "section": sections.get(part.section_id), "section_id": part.section_id},
                         "rack": r, **row})
        rows.sort(key=lambda x: ((x["part"]["section"] or "~").lower(), _natural(x["rack"]),
                                 _natural(x["part"]["location"]), x["part"]["part_no"] or ""))
        summary = {"parts": len(rows),
                   "to_do": sum(1 for x in rows if x["state"] == OLD_TODO),
                   "partly": sum(1 for x in rows if x["state"] == OLD_PARTLY),
                   "done": sum(1 for x in rows if x["state"] in OLD_SHOW["done"]),
                   "qty_to_label": _n(round(sum(x["to_label"] for x in rows), 2))}
        if show in OLD_SHOW:
            rows = [x for x in rows if x["state"] in OLD_SHOW[show]]
        size = max(1, min(int(page_size or 50), MAX_PAGE_SIZE))
        page = max(1, int(page or 1))
        return {"rows": rows[(page - 1) * size: page * size], "total": len(rows), "page": page,
                "pages": -(-len(rows) // size), "page_size": size, "summary": summary,
                "racks": sorted(racks.values(), key=lambda t: _natural(t["rack"]))}

    @staticmethod
    def old_stock_sections(store_code):
        """[{id, name}] of the sections holding the store's shelf stock."""
        rows = (db.session.query(Section.id, Section.name)
                .join(Part, Part.section_id == Section.id)
                .join(SpareStock, SpareStock.part_id == Part.id)
                .filter(Part.store_code == store_code, Part.is_active.is_(True), SpareStock.qty_on_hand > 0)
                .distinct().all())
        return [{"id": i, "name": n} for i, n in sorted(rows, key=lambda r: (r[1] or "").lower())]

    def _old_plan(self, part, counted, kind, packet_qty, last_smaller):
        """How `counted` of the part's unlabelled shelf stock would be packed —
        a plan of an opening batch not yet made."""
        figs = self.old_figures(part.id)
        if float(counted) > figs["to_label"] + 1e-9:
            wait = figs["waiting_in_receipts"]
            raise BadRequestError(
                f"Counted {_n(counted)} but the app has {figs['to_label']:g} {part.uom or ''} of {part.part_no} "
                f"without a label (on hand {figs['on_hand']:g}, in packets {figs['packed_available']:g}"
                + (f", waiting in receipts {wait:g}" if wait else "")
                + ") — put the extra stock right first (stock count), then label it")
        draft = SpareBatch(verify_status="VERIFIED", verified_qty=counted, qty=counted, part_id=part.id)
        return self.plan(draft, kind, packet_qty, None, last_smaller), figs

    def old_stock_plan(self, part_id, counted_qty, kind, packet_qty=None, last_smaller=False):
        part = self._part(part_id)
        counted = _qty(counted_qty, "Counted on the shelf")
        plan, figs = self._old_plan(part, counted, (kind or "").upper(), packet_qty, last_smaller)
        return {"figures": figs, **self._plan_out(plan)}

    @staticmethod
    def _plan_out(plan):
        sizes = plan["sizes"]
        last = sizes[-1] if len(sizes) > 1 and sizes[-1] != sizes[0] else None
        return {"packable": _n(plan["packable"]), "count": len(sizes), "packet_qty": _n(sizes[0]),
                "last_qty": _n(last), "total": _n(sum(sizes)), "loose_after": _n(plan["loose_after"])}

    def old_stock_pack(self, part_id, counted_qty, kind, packet_qty=None, last_smaller=False, user=None,
                       supplier_codes=None, remarks=None):
        """Label old stock: what was counted on the shelf is packed as an
        OPENING batch of exactly what goes into packets (so nothing of it is
        left "to pack" in the Receipts tab); the rest stays loose. No stock
        moves."""
        part = self._part(part_id)
        counted = _qty(counted_qty, "Counted on the shelf")
        kind = (kind or "").upper()
        with atomic():
            self._lock_stock(part.id)
            plan, _ = self._old_plan(part, counted, kind, packet_qty, last_smaller)
            sizes = plan["sizes"]
            smaller = len(sizes) > 1 and sizes[-1] != sizes[0]
            note = _text(remarks, 120, "Remarks")
            opening = self.opening_receipt(
                part.id, sum(sizes), user=user,
                remarks=f"Old stock on the shelf: counted {_n(counted)}, packed {_n(sum(sizes))}"
                        + (f" — {note}" if note else ""))
            out = self.pack(opening["id"], kind, packet_qty=sizes[0], count=len(sizes) - smaller,
                            last_smaller=smaller, user=user, supplier_codes=supplier_codes)
        out["counted"] = _n(counted)
        out["figures"] = self.old_figures(part.id)
        return out

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
                                     SparePacket.supplier_code.ilike(like),
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
        limit = min(verified, float(r.qty)) if verified is not None and not r.loose_note else 0.0
        return {
            "id": r.id, "receipt_no": r.receipt_no, "source": r.source, "store_code": r.store_code,
            "part": SparePacketService._part_dict(r.part), "received_on": _iso(r.received_on),
            "qty": _n(r.qty), "uom": r.uom or r.part.uom, "grn_no": r.grn_no, "gate_entry_no": r.gate_entry_no,
            "gate_entry_dt": _iso(r.gate_entry_dt), "invoice_no": r.invoice_no, "supplier_name": r.supplier_name,
            "verify_status": r.verify_status, "verified_qty": _n(r.verified_qty), "verified_by": r.verified_by,
            "verified_at": _iso(r.verified_at), "verify_remarks": r.verify_remarks, "loose_note": r.loose_note,
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
            "location": p.location, "status": p.status, "supplier_code": p.supplier_code,
            "part": SparePacketService._part_dict(p.part),
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
    def _part(part_id):
        part = db.session.get(Part, int(part_id)) if str(part_id).strip().isdigit() else None
        if part is None or not part.is_active:
            raise NotFoundError(f"Part {part_id} not found")
        return part

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
