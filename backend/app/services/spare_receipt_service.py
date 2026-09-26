"""Supplier receiving for the Spare Parts Store — spec 1 / 9.

The plant's receiving is ONE business flow, not an SRV step and a GRN step:

    material received in the store  -> RECEIVED          (no stock yet)
    supervisor creates the ERP GRN  -> QUALITY_PENDING   (with Maintenance / Tool Room)
    physical quality inspection     -> STOCK_AVAILABLE   (accepted qty is issuable)
                                       | REJECTED        (nothing reaches stock)

A receipt never touches ``spare_stock.qty_on_hand`` until the quality clearance:
only then is the ACCEPTED quantity written as a RECEIPT ledger row (through
SpareStockService._write, so the cache and balance_after stay right). The
rejected quantity never reaches stock. Printing a QR label for the material
touches none of this (spec 9).

ERP stays read-only. The GRN is created in ERP by the supervisor and only its
number is RECORDED here — nothing in this module claims ERP was updated. A
vendor code is never typed: it is accepted only when ERP's own gate entries or
GRN lines show that vendor supplying this part.

Every step writes one journal row (SpareJournalService) inside the same
atomic() as the change it describes, and each status move is a compare-and-set
so a double-click or a second terminal can never record the same step twice.
"""
import math
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import joinedload

from app.extensions import db
from app.models.base import utcnow
from app.models.gate_entry import GateEntry
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.spare_flow import RECEIPT_OPEN, RECEIPT_STATUSES, SUPPLIER_SOURCES, SpareReceipt
from app.models.spare_stock import CHECK_RESULTS, SpareStockLedger
from app.models.supplier import Supplier
from app.repositories.part_repository import PartRepository
from app.services.spare_journal_service import SpareJournalService
from app.services.spare_stock_service import SpareStockService
from app.utils.db_tx import atomic
from app.utils.exceptions import BadRequestError, NotFoundError

# The receiving flow belongs to the Spare Parts Store; the Child Parts store
# receives through its own SRV pipeline. The route refuses any other store.
SPARE_STORE_CODE = "MAINTENANCE"

# Who inspects spare material after the GRN (spec 1: "material goes to the
# Maintenance / Tool Room ERP ID"). Only these two ever take material for
# quality, and each only while the live department master has it active — an
# admin who deactivates Tool Room stops it being offered with no code change,
# but activating some other department never makes it a quality inspector.
QUALITY_DEPARTMENTS = ("Maintenance", "Tool Room")

# The ledger status a quality-cleared receipt writes (models/spare_stock.py
# ERP_ORIGIN_RECEIPT_STATUSES: never pushed to ERP again — the GRN put it there).
LEDGER_STATUS_CLEARED = "STOCK_AVAILABLE"

# A number clash on receipt_no means another terminal took the same RCV number
# in the same instant; the whole receive is retried with a fresh one.
_NUMBER_RETRIES = 3

ERP_VENDOR_ONLY = "Vendor code must come from ERP"


def _f(v):
    return float(v) if v is not None else None


def _iso(v):
    return v.isoformat() if v is not None else None


def _text(v, limit=None):
    """Trimmed text or None — a blank field is "not given", never an empty value."""
    if v is None:
        return None
    v = str(v).strip()
    if not v:
        return None
    return v[:limit] if limit else v


def _ref(v, limit, what):
    """A document number (GRN / invoice / vendor code): trimmed, and refused
    rather than silently cut short when it does not fit — a truncated number
    would point at a different document."""
    v = _text(v)
    if v and len(v) > limit:
        raise BadRequestError(f"{what} is longer than {limit} characters")
    return v


def _qty(v, what):
    try:
        q = round(float(v), 2)
    except (TypeError, ValueError):
        raise BadRequestError(f"{what} must be a number")
    if not math.isfinite(q):
        raise BadRequestError(f"{what} must be a number")
    return q


def _date(v, what):
    """A plain date from a date, an ISO string, or nothing."""
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v).strip())
    except ValueError:
        raise BadRequestError(f"{what} must be a date (YYYY-MM-DD)")


def _num_text(n):
    return f"{n:g}"


def _age_days(ts):
    """Whole days since a stored UTC timestamp, on the plant clock — the same
    footing the receiving monitor ages its rows on."""
    if ts is None:
        return None
    if ts.tzinfo is not None:
        ts = ts.astimezone(timezone.utc).replace(tzinfo=None)
    offset = datetime.now().astimezone().utcoffset() or timedelta(0)
    return max((datetime.now().date() - (ts + offset).date()).days, 0)


class SpareReceiptService:
    def __init__(self):
        self.parts = PartRepository()
        self.journal = SpareJournalService()
        self.stock = SpareStockService()

    # ------------------------------------------------------------ receive

    def receive(self, part_id, qty, *, user, supplier_id=None, ven_cd=None, ven_name=None,
                supplier_source=None, invoice_no=None, invoice_date=None, check_result=None,
                remarks=None, scanned_code=None, scan_source=None):
        """Step 1-3: material physically received and checked (Part No +
        Quantity + Invoice). Creates a RECEIVED receipt; available stock does
        NOT move — the material is not issuable until quality clears it."""
        part = self.parts.get_by_id(part_id)
        if not part:
            raise NotFoundError(f"Part {part_id} not found")
        if not part.is_active:
            raise BadRequestError(f"Part '{part.part_no}' is inactive")
        qty = _qty(qty, "Receive quantity")
        if qty <= 0:
            raise BadRequestError("Receive quantity must be greater than zero")
        check_result = _text(check_result)
        if check_result:
            check_result = check_result.upper()
            if check_result not in CHECK_RESULTS:
                raise BadRequestError(f"Check result must be one of {', '.join(CHECK_RESULTS)}")
        supplier = self._supplier(part, supplier_id, ven_cd, ven_name, supplier_source)
        values = dict(
            part_id=part.id, store_code=part.store_code, status="RECEIVED",
            qty_received=qty, **supplier,
            invoice_no=_ref(invoice_no, 60, "Invoice no."), invoice_date=_date(invoice_date, "Invoice date"),
            check_result=check_result, received_by=user, remarks=_text(remarks, 255),
            scanned_code=_text(scanned_code, 80), scan_source=_text(scan_source, 20),
        )

        for attempt in range(_NUMBER_RETRIES):
            try:
                with atomic():
                    receipt = SpareReceipt(receipt_no=self.journal.next_receipt_no(), **values)
                    db.session.add(receipt)
                    db.session.flush()
                    self.journal.record(
                        part.id, "RECEIVE", qty, store_code=part.store_code, user=user,
                        prev_status=None, new_status="RECEIVED",
                        from_bucket="SUPPLIER", to_bucket="QUALITY_PENDING",
                        receipt_id=receipt.id, supplier_name=receipt.ven_name,
                        ven_cd=receipt.ven_cd, invoice_no=receipt.invoice_no,
                        remarks=receipt.remarks, scanned_code=receipt.scanned_code,
                        scan_source=receipt.scan_source,
                    )
                break
            except IntegrityError:
                # Only a receipt-number clash is worth another go; anything else
                # would fail the same way again.
                if attempt == _NUMBER_RETRIES - 1:
                    raise
        return self.to_dict(receipt)

    def _supplier(self, part, supplier_id, ven_cd, ven_name, source_hint):
        """Resolve who supplied the material, without ever inventing a vendor.

        * a vendor code is accepted only when ERP's gate entries or GRN lines
          show that code supplying THIS part (the source recorded is where it was
          actually found);
        * a supplier-master id must exist;
        * a bare name is kept as NAME_ONLY unless ERP shows that name for this
          part under the source the form picked it from;
        * nothing at all leaves the supplier unknown (None), not guessed."""
        source_hint = _text(source_hint)
        if source_hint is not None and source_hint not in SUPPLIER_SOURCES:
            raise BadRequestError(f"Supplier source must be one of {', '.join(SUPPLIER_SOURCES)}")
        ven_cd, ven_name = _ref(ven_cd, 30, "Vendor code"), _text(ven_name, 160)

        master = None
        if supplier_id is not None:
            master = db.session.get(Supplier, supplier_id)
            if master is None:
                raise BadRequestError(f"Supplier {supplier_id} not found in the supplier master")

        if ven_cd:
            seen = self.erp_vendor(part.part_no, ven_cd=ven_cd)
            if not seen:
                raise BadRequestError(ERP_VENDOR_ONLY)
            source = source_hint if source_hint in seen else next(iter(seen))
            erp_cd, erp_name = seen[source]
            # ERP's own name for the code wins over whatever the form sent.
            return {"supplier_id": master.id if master else None, "ven_cd": erp_cd,
                    "ven_name": erp_name or ven_name or erp_cd, "supplier_source": source}
        if master is not None:
            return {"supplier_id": master.id, "ven_cd": None,
                    "ven_name": ven_name or master.supplier_name, "supplier_source": "SUPPLIER_MASTER"}
        if ven_name:
            source = "NAME_ONLY"
            if source_hint in ("GATE_ENTRY", "ERP_GRN") and \
                    source_hint in self.erp_vendor(part.part_no, ven_name=ven_name):
                source = source_hint
            return {"supplier_id": None, "ven_cd": None, "ven_name": ven_name, "supplier_source": source}
        return {"supplier_id": None, "ven_cd": None, "ven_name": None, "supplier_source": None}

    @staticmethod
    def erp_vendor(part_no, ven_cd=None, ven_name=None):
        """Where ERP has seen a vendor supply this part: {source: (ven_cd, ven_name)}
        with source GATE_ENTRY (gate entries, item_code = part_no) and/or ERP_GRN
        (GRN lines, item_cd = part_no), newest row first, gate entries first.
        Matched by vendor code, or by name when there is no code. The part match
        is the same case-insensitive one the part's gate history uses."""
        key = (part_no or "").strip().upper()
        if not key or not (ven_cd or ven_name):
            return {}
        found = {}
        for source, model, item_col, date_col in (
            ("GATE_ENTRY", GateEntry, GateEntry.item_code, GateEntry.gate_entry_dt),
            ("ERP_GRN", ReceivingRegister, ReceivingRegister.item_cd, ReceivingRegister.grn_date),
        ):
            q = db.session.query(model.ven_cd, model.ven_name).filter(func.upper(item_col) == key)
            if ven_cd:
                q = q.filter(func.upper(func.trim(model.ven_cd)) == ven_cd.strip().upper())
            else:
                q = q.filter(func.upper(func.trim(model.ven_name)) == ven_name.strip().upper())
            row = q.order_by(date_col.desc(), model.id.desc()).first()
            if row:
                found[source] = ((row.ven_cd or "").strip() or None, (row.ven_name or "").strip() or None)
        return found

    # ---------------------------------------------------------------- GRN

    def record_grn(self, receipt_id, grn_no, grn_date=None, quality_by=None, remarks=None, user=None):
        """Step 5-6: the supervisor created the GRN in ERP; record its number and
        which department inspects the material. The receipt moves to
        QUALITY_PENDING — still not stock."""
        receipt = self._get(receipt_id)
        self._require(receipt, "RECEIVED", "record a GRN")
        grn_no = _ref(grn_no, 40, "GRN no.")
        if not grn_no:
            raise BadRequestError("GRN no. is required — the number ERP gave the GRN")
        grn_date = _date(grn_date, "GRN date")
        quality_by = self._quality_department(quality_by)
        remarks = _text(remarks, 255)
        with atomic():
            self._move(receipt, "RECEIVED", status="QUALITY_PENDING", grn_no=grn_no,
                       grn_date=grn_date, grn_recorded_by=user, grn_recorded_at=utcnow(),
                       quality_by=quality_by)
            self.journal.record(
                receipt.part_id, "GRN", receipt.qty_received, store_code=receipt.store_code,
                user=user, prev_status="RECEIVED", new_status="QUALITY_PENDING",
                receipt_id=receipt.id, department=quality_by, grn_no=grn_no,
                supplier_name=receipt.ven_name, ven_cd=receipt.ven_cd,
                invoice_no=receipt.invoice_no, remarks=remarks,
            )
        return self.to_dict(receipt)

    def _quality_department(self, name):
        """Maintenance or Tool Room, and only while the department master has
        it active — spelled as the master spells it. Any other department, even
        an active one (Press Shop, Purchase…), is refused: spare material goes
        to the Maintenance / Tool Room ERP ID for inspection, nowhere else."""
        name = _text(name)
        if not name:
            raise BadRequestError(f"Choose who inspects the material ({' / '.join(QUALITY_DEPARTMENTS)})")
        wanted = name.lower()
        if wanted not in {d.lower() for d in QUALITY_DEPARTMENTS}:
            raise BadRequestError(f"Quality is inspected by {' or '.join(QUALITY_DEPARTMENTS)}")
        for known in self.stock._valid_department_names():
            if known.strip().lower() == wanted:
                return known.strip()
        raise BadRequestError(f"'{name}' is not an active department in the department master")

    # ------------------------------------------------------------ quality

    def quality_clear(self, receipt_id, accepted_qty, rejected_qty, remarks=None, user=None):
        """Step 7-8: Maintenance / Tool Room inspected the material. The accepted
        quantity becomes available stock (one RECEIPT ledger row, reference =
        the GRN no.); the rejected quantity never reaches stock."""
        receipt = self._get(receipt_id)
        self._require(receipt, "QUALITY_PENDING", "clear quality")
        accepted = _qty(accepted_qty, "Accepted quantity")
        rejected = _qty(rejected_qty if rejected_qty is not None else 0, "Rejected quantity")
        if accepted < 0 or rejected < 0:
            raise BadRequestError("Accepted and rejected quantities cannot be negative")
        received = round(float(receipt.qty_received), 2)
        if round(accepted + rejected, 2) != received:
            raise BadRequestError(
                f"Accepted + rejected must equal the received quantity ({_num_text(received)}); "
                f"got {_num_text(accepted)} + {_num_text(rejected)}")
        remarks = _text(remarks, 255)
        new_status = "STOCK_AVAILABLE" if accepted > 0 else "REJECTED"
        common = dict(store_code=receipt.store_code, user=user, prev_status="QUALITY_PENDING",
                      receipt_id=receipt.id, department=receipt.quality_by, grn_no=receipt.grn_no,
                      supplier_name=receipt.ven_name, ven_cd=receipt.ven_cd,
                      invoice_no=receipt.invoice_no, remarks=remarks)
        with atomic():
            # The compare-and-set comes first: once it lands this transaction
            # holds the write lock, so the stock read below cannot go stale and
            # a second clearance of the same receipt is refused, never added.
            self._move(receipt, "QUALITY_PENDING", status=new_status, qty_accepted=accepted,
                       qty_rejected=rejected, cleared_by=user, cleared_at=utcnow(),
                       quality_remarks=remarks)
            if accepted > 0:
                ledger_id = self._add_to_stock(receipt, accepted, remarks, user)
                receipt.ledger_id = ledger_id
                db.session.flush()
                self.journal.record(
                    receipt.part_id, "QUALITY_CLEARANCE", accepted, new_status="STOCK_AVAILABLE",
                    from_bucket="QUALITY_PENDING", to_bucket="AVAILABLE", ledger_id=ledger_id,
                    **common,
                )
            if rejected > 0:
                self.journal.record(
                    receipt.part_id, "QUALITY_CLEARANCE", rejected, new_status="REJECTED",
                    from_bucket="QUALITY_PENDING", to_bucket="REJECTED",
                    inspection_result="REJECTED", **common,
                )
        return self.to_dict(receipt)

    def _add_to_stock(self, receipt, qty, remarks, user):
        """Write the RECEIPT ledger row for the accepted quantity and return its
        id. Goes through SpareStockService._write so on-hand, balance_after and
        the stock-list cache move together."""
        row = self.stock.repo.get_or_create(receipt.part_id)
        new_qty = round(float(row.qty_on_hand or 0) + qty, 2)
        note = f"{receipt.receipt_no} · quality cleared"
        if receipt.quality_by:
            note += f" by {receipt.quality_by}"
        if remarks:
            note += f" · {remarks}"
        self.stock._write(
            receipt.part_id, new_qty, "RECEIPT", reference=receipt.grn_no,
            remarks=note[:255], user=user,
            extra={"status": LEDGER_STATUS_CLEARED, "supplier_id": receipt.supplier_id,
                   "invoice_no": receipt.invoice_no, "invoice_date": receipt.invoice_date,
                   "check_result": receipt.check_result},
        )
        # _write does not hand the ledger row back. This transaction already
        # holds the write lock (the receipt's compare-and-set), so the newest
        # RECEIPT row of this part is the one just written.
        ledger = (SpareStockLedger.query
                  .filter_by(part_id=receipt.part_id, txn_type="RECEIPT")
                  .order_by(SpareStockLedger.id.desc()).first())
        return ledger.id

    # ------------------------------------------------------------- cancel

    def cancel(self, receipt_id, reason, user=None):
        """A receipt recorded by mistake, taken back before any GRN. After the
        GRN the material is ERP's and quality decides it; history is never
        rewritten, so the cancellation is its own journal row."""
        receipt = self._get(receipt_id)
        self._require(receipt, "RECEIVED", "cancel it", after_grn=True)
        reason = _text(reason, 255)
        if not reason:
            raise BadRequestError("A reason is required to cancel a receipt")
        with atomic():
            self._move(receipt, "RECEIVED", status="CANCELLED", cancelled_by=user,
                       cancelled_at=utcnow(), cancel_reason=reason)
            self.journal.record(
                receipt.part_id, "CANCEL", receipt.qty_received, store_code=receipt.store_code,
                user=user, prev_status="RECEIVED", new_status="CANCELLED",
                from_bucket="QUALITY_PENDING", to_bucket="CANCELLED", receipt_id=receipt.id,
                supplier_name=receipt.ven_name, ven_cd=receipt.ven_cd,
                invoice_no=receipt.invoice_no, remarks=reason,
            )
        return self.to_dict(receipt)

    # ----------------------------------------------------------- plumbing

    @staticmethod
    def get(receipt_id):
        return db.session.get(SpareReceipt, receipt_id)

    def _get(self, receipt_id):
        receipt = self.get(receipt_id)
        if receipt is None:
            raise NotFoundError(f"Receipt {receipt_id} not found")
        return receipt

    @staticmethod
    def _require(receipt, status, doing, after_grn=False):
        if receipt.status == status:
            return
        now = receipt.status.replace("_", " ").lower()
        msg = f"Cannot {doing}: receipt {receipt.receipt_no} is {now}"
        if after_grn and receipt.grn_no:
            msg += f" (GRN {receipt.grn_no} already recorded)"
        raise BadRequestError(msg)

    @staticmethod
    def _move(receipt, expected, **values):
        """Compare-and-set on the receipt row: the UPDATE only lands while the
        receipt is still in `expected`, so two terminals (or a double-click)
        can never record the same GRN twice or add one clearance to stock
        twice — the loser gets a clear 400 instead."""
        values.setdefault("updated_at", utcnow())
        n = (SpareReceipt.query
             .filter(SpareReceipt.id == receipt.id, SpareReceipt.status == expected)
             .update(values, synchronize_session=False))
        if n != 1:
            raise BadRequestError(
                f"Receipt {receipt.receipt_no} was just changed on another screen — reload it and try again")
        db.session.refresh(receipt)

    # ------------------------------------------------------------ reading

    @staticmethod
    def to_dict(r):
        part = r.part
        return {
            "id": r.id, "receipt_no": r.receipt_no, "status": r.status,
            "part_id": r.part_id,
            "part_no": part.part_no if part else None,
            "part_name": part.part_name if part else None,
            "uom": part.uom if part else None,
            "store_code": r.store_code,
            "qty_received": _f(r.qty_received),
            "qty_accepted": _f(r.qty_accepted),
            "qty_rejected": _f(r.qty_rejected),
            "supplier_id": r.supplier_id,
            "supplier_master_name": r.supplier.supplier_name if r.supplier else None,
            "ven_cd": r.ven_cd, "ven_name": r.ven_name, "supplier_source": r.supplier_source,
            "invoice_no": r.invoice_no, "invoice_date": _iso(r.invoice_date),
            "check_result": r.check_result, "received_by": r.received_by, "remarks": r.remarks,
            "grn_no": r.grn_no, "grn_date": _iso(r.grn_date),
            "grn_recorded_by": r.grn_recorded_by, "grn_recorded_at": _iso(r.grn_recorded_at),
            "quality_by": r.quality_by,
            "cleared_by": r.cleared_by, "cleared_at": _iso(r.cleared_at),
            "quality_remarks": r.quality_remarks, "ledger_id": r.ledger_id,
            "scanned_code": r.scanned_code, "scan_source": r.scan_source,
            "cancelled_by": r.cancelled_by, "cancelled_at": _iso(r.cancelled_at),
            "cancel_reason": r.cancel_reason,
            "created_at": _iso(r.created_at), "updated_at": _iso(r.updated_at),
            # Days since the material was received — how long it has been
            # waiting while open, or how long the flow took once closed.
            "age_days": _age_days(r.created_at),
        }

    def list(self, store_code, status=None, limit=None):
        """A store's receipts, newest first. `status` is one status, a
        comma-separated list, or OPEN (received + quality pending)."""
        q = (SpareReceipt.query.options(joinedload(SpareReceipt.part), joinedload(SpareReceipt.supplier))
             .join(Part, Part.id == SpareReceipt.part_id)
             .filter(Part.store_code == store_code))
        statuses = self._statuses(status)
        if statuses:
            q = q.filter(SpareReceipt.status.in_(statuses))
        q = q.order_by(SpareReceipt.created_at.desc(), SpareReceipt.id.desc())
        if limit:
            q = q.limit(limit)
        return [self.to_dict(r) for r in q.all()]

    @staticmethod
    def _statuses(status):
        status = _text(status)
        if not status:
            return None
        if status.upper() == "OPEN":
            return list(RECEIPT_OPEN)
        wanted = [s.strip().upper() for s in status.split(",") if s.strip()]
        unknown = [s for s in wanted if s not in RECEIPT_STATUSES]
        if unknown:
            raise BadRequestError(
                f"Unknown receipt status {', '.join(unknown)} — use OPEN or {', '.join(RECEIPT_STATUSES)}")
        return wanted
