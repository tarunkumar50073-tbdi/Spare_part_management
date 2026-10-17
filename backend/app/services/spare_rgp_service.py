"""Supplier rework under an RGP (Returnable Gate Pass) — spec 15-19.

There is NO direct RGP. Material goes to a supplier for rework only after a
department sent it back and the store inspection held it ("Inspection
Required") or found it damaged (spec 15 / 20): every RGP is drawn from a
SpareReturn's qty_hold / qty_damaged, and nothing in this service can make one
from a part or from available stock.

    return hold / damaged --RGP OUT--> WITH_SUPPLIER --supplier return-->
    RGP_GRN_PENDING --RGP GRN--> AVAILABLE (one RECEIPT ledger row)

While the material is with the supplier, and after it comes back until the RGP
GRN is recorded, it is NOT stock: spare_stock.qty_on_hand moves only at the RGP
GRN, once per GRN, through SpareStockService._write. The GRN itself is made in
ERP by the store supervisor — the app records its number (ERP stays read-only),
so the ledger row is marked RGP_GRN and is never pushed to ERP a second time.

Where it goes back (store rule, 14 Oct 2026): a part such as CNTR3200 keeps
new material in its FRESH location and material back from rework in its REWORK
location. Stock stays one figure; the RGP document and the RGP GRN name the
rework bin (rework_bin) so the store puts reworked material there.

A vendor code is never typed or invented: it must be an ERP vendor this part
has actually come from (a gate entry or GRN whose item code is the part no), or
it stays blank and the RGP carries the supplier name only.

Every write takes the database write lock on the document before re-checking
its quantities (SpareStockService._lock), so two terminals — or a double-click
— can never send, receive or GRN the same piece twice. Each step writes one
journal row inside the same atomic() as the change it describes.
"""
from datetime import date, datetime

from sqlalchemy import func
from sqlalchemy.orm import joinedload

from app.extensions import db
from app.models.base import utcnow
from app.models.gate_entry import GateEntry
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.spare_flow import (
    RGP_OPEN, RGP_STATUSES, SUPPLIER_SOURCES, SpareReturn, SpareRgp,
)
from app.models.supplier import Supplier
from app.services.spare_journal_service import SpareJournalService
from app.services.spare_stock_service import SpareStockService
from app.utils.bin_location import part_bins
from app.utils.db_tx import atomic
from app.utils.exceptions import BadRequestError, NotFoundError

# The only two return buckets an RGP may draw from (spec 14/15). Never
# RETURN_PENDING (not inspected yet) and never AVAILABLE (no direct RGP).
# Order = the default pick: damaged material first, then the held.
RGP_SOURCE_BUCKETS = ("DAMAGED", "RETURN_HOLD")
_BUCKET_WORDS = {"DAMAGED": "damaged", "RETURN_HOLD": "on return hold"}

# Where a vendor code can legitimately come from — the ERP feeds.
ERP_SUPPLIER_SOURCES = ("GATE_ENTRY", "ERP_GRN")


def _iso(v):
    return v.isoformat() if v is not None else None


def _f(v):
    return round(float(v), 2) if v is not None else None


def _clean(v):
    """Trimmed text, or None when blank."""
    if v is None:
        return None
    return str(v).strip() or None


def _qty(value, what):
    try:
        q = round(float(value), 2)
    except (TypeError, ValueError):
        raise BadRequestError(f"{what} must be a number")
    if q <= 0:
        raise BadRequestError(f"{what} must be greater than zero")
    return q


def _as_date(value, what):
    """A plain date from a date / datetime / ISO string; None when blank."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        raise BadRequestError(f"{what} must be a date (YYYY-MM-DD)")


def _join(*parts):
    return " — ".join(p for p in parts if p) or None


def rework_bin(part):
    """The bin reworked material goes back to: the part's REWORK location when
    it keeps one apart from its fresh location (utils/bin_location.part_bins,
    the rule the bin sheets and the bin-scan checks use). None when it has no
    separate rework bin — the material then goes to the part's own location,
    like any other stock."""
    if part is None:
        return None
    return next((loc for kind, loc in part_bins(part.location, part.rework_location)
                 if kind == "rework"), None)


class SpareRgpService:
    """RGP OUT, supplier return, RGP GRN, cancel — and the reads the Scan Part
    workstation and the Work Queue render."""

    def __init__(self):
        self.journal = SpareJournalService()
        self.stock = SpareStockService()

    # ---- writing ----

    def rgp_out(self, return_id, qty, *, user=None, from_bucket=None, supplier_id=None,
                ven_cd=None, ven_name, supplier_source, rework_reason, remarks=None,
                rgp_date=None, expected_return_date=None, erp_challan_no=None,
                scanned_code=None, scan_source=None):
        """RGP OUT - REWORK (spec 16): send returned material the inspection
        held or found damaged to a supplier. Moves the quantity from the
        return's hold / damaged bucket to its qty_rgp and opens an RGP
        (WITH_SUPPLIER). Available stock is not touched — it was never in it."""
        qty = _qty(qty, "RGP quantity")
        ret = db.session.get(SpareReturn, return_id)
        if ret is None:
            raise NotFoundError(f"Return {return_id} not found")
        part = ret.part
        if not part.is_active:
            raise BadRequestError(f"Part '{part.part_no}' is inactive")
        if from_bucket is not None and from_bucket not in RGP_SOURCE_BUCKETS:
            raise BadRequestError(
                "An RGP can only take returned material that the store inspection held or "
                "found damaged — there is no direct RGP")

        supplier_source = _clean(supplier_source)
        if supplier_source not in SUPPLIER_SOURCES:
            raise BadRequestError(f"supplier_source must be one of {list(SUPPLIER_SOURCES)}")
        supplier = None
        if supplier_id is not None:
            supplier = db.session.get(Supplier, supplier_id)
            if supplier is None:
                raise BadRequestError(f"Supplier {supplier_id} not found")
        elif supplier_source == "SUPPLIER_MASTER":
            raise BadRequestError("Pick the supplier from the supplier master")

        # The vendor code is ERP's, never the operator's: it must be a vendor
        # this very part has come from, and it is stored in ERP's own spelling.
        ven_cd = _clean(ven_cd)
        erp_name = None
        if ven_cd:
            if supplier_source not in ERP_SUPPLIER_SOURCES:
                raise BadRequestError(
                    "A vendor code comes only from ERP (gate entry / GRN) — pick the supplier "
                    "from the list, or leave the code blank")
            hit = self._erp_vendor(part.part_no, ven_cd)
            if hit is None:
                raise BadRequestError(
                    f"Vendor code '{ven_cd}' is not an ERP vendor for {part.part_no} "
                    f"(no gate entry or GRN) — pick the supplier from the list")
            ven_cd, erp_name = hit
        ven_name = _clean(ven_name) or erp_name or (supplier.supplier_name if supplier else None)
        if not ven_name:
            raise BadRequestError("Supplier name is required")

        rework_reason = _clean(rework_reason)
        if not rework_reason:
            raise BadRequestError("Rework reason is required")
        today = date.today()   # the server clock is the plant clock
        rgp_date = _as_date(rgp_date, "RGP date") or today
        if rgp_date > today:
            raise BadRequestError("RGP date cannot be in the future")
        expected = _as_date(expected_return_date, "Expected return date")
        if expected and expected < rgp_date:
            raise BadRequestError("Expected return date cannot be before the RGP date")
        remarks = _clean(remarks)

        with atomic():
            # Lock, then re-read the split: a second terminal sending the same
            # return must see this RGP, never the same quantity again.
            self.stock._lock(SpareReturn, ret.id)
            db.session.refresh(ret)
            bucket = from_bucket or ("DAMAGED" if ret.q("qty_damaged") > 0 else "RETURN_HOLD")
            col = SpareReturn.BUCKET_COLUMNS[bucket]
            held = ret.q(col)
            words = _BUCKET_WORDS[bucket]
            if held <= 0:
                what = words if from_bucket else "damaged or on return hold"
                raise BadRequestError(
                    f"Nothing on return {ret.return_no} is {what} — only material the store "
                    f"inspection held or found damaged can go for rework")
            if qty > held:
                raise BadRequestError(
                    f"Cannot send {qty:g} on RGP: only {held:g} {words} on return {ret.return_no}")
            setattr(ret, col, round(held - qty, 2))
            ret.qty_rgp = round(ret.q("qty_rgp") + qty, 2)
            ret.refresh_status()
            rgp = SpareRgp(
                rgp_no=self.journal.next_rgp_no(), erp_challan_no=_clean(erp_challan_no),
                part_id=ret.part_id, store_code=ret.store_code,
                source_return_id=ret.id, source_bucket=bucket, status="WITH_SUPPLIER",
                supplier_id=supplier.id if supplier else None, ven_cd=ven_cd,
                ven_name=ven_name, supplier_source=supplier_source,
                qty_out=qty, qty_returned=0, qty_grn=0,
                rework_reason=rework_reason, remarks=remarks, rgp_date=rgp_date,
                expected_return_date=expected, out_by=user,
            )
            db.session.add(rgp)
            db.session.flush()
            self.journal.record(
                ret.part_id, "RGP_OUT", qty, store_code=ret.store_code, user=user,
                prev_status=bucket, new_status="WITH_SUPPLIER",
                from_bucket=bucket, to_bucket="WITH_SUPPLIER",
                return_id=ret.id, rgp_id=rgp.id, issue_id=ret.issue_id,
                supplier_name=ven_name, ven_cd=ven_cd, rgp_no=rgp.rgp_no,
                remarks=_join(rework_reason, remarks),
                scanned_code=scanned_code, scan_source=scan_source,
            )
        return self.to_dict(rgp)

    def supplier_return(self, rgp_id, qty, remarks=None, user=None, *,
                        scanned_code=None, scan_source=None):
        """RGP RETURN (spec 18): the supplier brought reworked material back.
        It now waits for the RGP GRN — still NOT stock, so no ledger row."""
        qty = _qty(qty, "Returned quantity")
        rgp = self._get(rgp_id)
        with atomic():
            self.stock._lock(SpareRgp, rgp.id)
            db.session.refresh(rgp)
            self._require_live(rgp)
            out = rgp.qty_with_supplier
            if out <= 0:
                raise BadRequestError(f"Nothing on {rgp.rgp_no} is still with the supplier")
            if qty > out:
                raise BadRequestError(
                    f"Cannot receive {qty:g} back: only {out:g} with {rgp.ven_name} on {rgp.rgp_no}")
            rgp.qty_returned = round(float(rgp.qty_returned or 0) + qty, 2)
            rgp.supplier_returned_at = utcnow()
            rgp.supplier_returned_by = user
            rgp.refresh_status()
            db.session.flush()
            self.journal.record(
                rgp.part_id, "RGP_RETURN", qty, store_code=rgp.store_code, user=user,
                prev_status="WITH_SUPPLIER", new_status="RGP_GRN_PENDING",
                from_bucket="WITH_SUPPLIER", to_bucket="RGP_GRN_PENDING",
                return_id=rgp.source_return_id, rgp_id=rgp.id,
                supplier_name=rgp.ven_name, ven_cd=rgp.ven_cd, rgp_no=rgp.rgp_no,
                remarks=_clean(remarks), scanned_code=scanned_code, scan_source=scan_source,
            )
        return self.to_dict(rgp)

    def rgp_grn(self, rgp_id, qty, grn_no, grn_date=None, remarks=None, user=None, *,
                scanned_code=None, scan_source=None):
        """RGP GRN (spec 18/19): the supervisor made the RGP GRN in ERP and
        records its number here. Only now does the reworked quantity become
        available — one RECEIPT ledger row (status RGP_GRN, reference = RGP no)
        in the same transaction as the RGP update and its journal row. For a
        part with a rework bin, the ledger row's remark names that bin: where
        this reworked material was put."""
        qty = _qty(qty, "GRN quantity")
        grn_no = _clean(grn_no)
        if not grn_no:
            raise BadRequestError("GRN no. is required — the RGP GRN created in ERP")
        grn_date = _as_date(grn_date, "GRN date")
        if grn_date is not None and grn_date > date.today():
            raise BadRequestError("GRN date cannot be in the future")
        rgp = self._get(rgp_id)
        with atomic():
            self.stock._lock(SpareRgp, rgp.id)
            db.session.refresh(rgp)
            if rgp.status == "CANCELLED":
                raise BadRequestError(f"{rgp.rgp_no} was cancelled")
            pending = rgp.qty_grn_pending
            if pending <= 0:
                raise BadRequestError(
                    f"Nothing on {rgp.rgp_no} is waiting for an RGP GRN — record the supplier return first")
            if qty > pending:
                raise BadRequestError(
                    f"Cannot GRN {qty:g}: only {pending:g} returned by the supplier and not yet "
                    f"GRN'd on {rgp.rgp_no}")
            if grn_date is not None and rgp.rgp_date and grn_date < rgp.rgp_date:
                raise BadRequestError("GRN date cannot be before the RGP date")
            rgp.qty_grn = round(float(rgp.qty_grn or 0) + qty, 2)
            # The latest GRN; each GRN of a partly-received RGP also stays in the
            # journal and on its own ledger row.
            rgp.grn_no, rgp.grn_date = grn_no, grn_date
            rgp.grn_at, rgp.grn_by = utcnow(), user
            rgp.refresh_status()

            row = self.stock.repo.get_or_create(rgp.part_id)
            # This transaction holds the write lock, so the committed figure
            # read here cannot change before the write below.
            db.session.refresh(row)
            new_qty = round(float(row.qty_on_hand or 0) + qty, 2)
            to_bin = rework_bin(rgp.part)
            _, _, ledger = self.stock._write(
                rgp.part_id, new_qty, "RECEIPT", reference=rgp.rgp_no,
                remarks=f"RGP GRN {grn_no}" + (f" · to the rework bin {to_bin}" if to_bin else ""),
                user=user,
                extra={"status": "RGP_GRN", "supplier_id": rgp.supplier_id},
                return_ledger=True,
            )
            self.journal.record(
                rgp.part_id, "RGP_GRN", qty, store_code=rgp.store_code, user=user,
                prev_status="RGP_GRN_PENDING", new_status="STOCK_AVAILABLE",
                from_bucket="RGP_GRN_PENDING", to_bucket="AVAILABLE",
                return_id=rgp.source_return_id, rgp_id=rgp.id, ledger_id=ledger.id,
                supplier_name=rgp.ven_name, ven_cd=rgp.ven_cd, rgp_no=rgp.rgp_no,
                grn_no=grn_no, remarks=_clean(remarks),
                scanned_code=scanned_code, scan_source=scan_source,
            )
        result = self.to_dict(rgp)
        result.update({"ledger_id": ledger.id, "qty_on_hand": new_qty})
        return result

    def cancel(self, rgp_id, reason, user=None):
        """Cancel an RGP raised by mistake — only while nothing has come back
        from the supplier. The quantity returns to the return bucket it was
        drawn from; the RGP row stays (CANCELLED) and a CANCEL journal row
        records why, so history is corrected, never rewritten."""
        reason = _clean(reason)
        if not reason:
            raise BadRequestError("A reason is required to cancel an RGP")
        rgp = self._get(rgp_id)
        with atomic():
            self.stock._lock(SpareRgp, rgp.id)
            self.stock._lock(SpareReturn, rgp.source_return_id)
            db.session.refresh(rgp)
            if rgp.status == "CANCELLED":
                raise BadRequestError(f"{rgp.rgp_no} is already cancelled")
            if float(rgp.qty_returned or 0) > 0:
                raise BadRequestError(
                    f"The supplier has already returned material on {rgp.rgp_no} — "
                    f"it can no longer be cancelled")
            bucket = rgp.source_bucket
            if bucket not in RGP_SOURCE_BUCKETS:
                raise BadRequestError(
                    f"{rgp.rgp_no} does not record which return bucket it came from — "
                    f"it cannot be cancelled here")
            ret = rgp.source_return
            db.session.refresh(ret)
            qty = round(float(rgp.qty_out), 2)
            col = SpareReturn.BUCKET_COLUMNS[bucket]
            setattr(ret, col, round(ret.q(col) + qty, 2))
            ret.qty_rgp = round(max(ret.q("qty_rgp") - qty, 0), 2)
            ret.refresh_status()
            rgp.status = "CANCELLED"
            rgp.cancelled_by, rgp.cancelled_at = user, utcnow()
            rgp.cancel_reason = reason[:255]
            db.session.flush()
            self.journal.record(
                rgp.part_id, "CANCEL", qty, store_code=rgp.store_code, user=user,
                prev_status="WITH_SUPPLIER", new_status="CANCELLED",
                from_bucket="WITH_SUPPLIER", to_bucket=bucket,
                return_id=ret.id, rgp_id=rgp.id, issue_id=ret.issue_id,
                supplier_name=rgp.ven_name, ven_cd=rgp.ven_cd, rgp_no=rgp.rgp_no,
                remarks=reason,
            )
        return self.to_dict(rgp)

    # ---- reading ----

    @staticmethod
    def _get(rgp_id):
        rgp = db.session.get(SpareRgp, rgp_id)
        if rgp is None:
            raise NotFoundError(f"RGP {rgp_id} not found")
        return rgp

    @staticmethod
    def _require_live(rgp):
        if rgp.status == "CANCELLED":
            raise BadRequestError(f"{rgp.rgp_no} was cancelled")
        if rgp.status == "CLOSED":
            raise BadRequestError(f"{rgp.rgp_no} is already closed")

    @staticmethod
    def to_dict(r, today=None):
        """One RGP as every screen reads it. `overdue` = still (partly) with the
        supplier past the expected return date, against today's plant date.
        `rework_bin` = where the RGP GRN puts the reworked material (None: the
        part's own location)."""
        today = today or date.today()
        with_supplier = r.qty_with_supplier
        part = r.part
        ret = r.source_return
        return {
            "id": r.id, "rgp_no": r.rgp_no, "erp_challan_no": r.erp_challan_no,
            "part_id": r.part_id,
            "part_no": part.part_no if part else None,
            "part_name": part.part_name if part else None,
            "uom": part.uom if part else None,
            "rework_bin": rework_bin(part),
            "store_code": r.store_code,
            "source_return_id": r.source_return_id,
            "return_no": ret.return_no if ret else None,
            "source_bucket": r.source_bucket,
            "status": r.status,
            "supplier_id": r.supplier_id, "ven_cd": r.ven_cd, "ven_name": r.ven_name,
            "supplier_source": r.supplier_source,
            "qty_out": _f(r.qty_out), "qty_returned": _f(r.qty_returned), "qty_grn": _f(r.qty_grn),
            "qty_with_supplier": with_supplier, "qty_grn_pending": r.qty_grn_pending,
            "rework_reason": r.rework_reason, "remarks": r.remarks,
            "rgp_date": _iso(r.rgp_date), "expected_return_date": _iso(r.expected_return_date),
            "overdue": bool(with_supplier > 0 and r.expected_return_date is not None
                            and r.expected_return_date < today),
            "days_with_supplier": ((today - r.rgp_date).days
                                   if with_supplier > 0 and r.rgp_date else None),
            "out_by": r.out_by, "created_at": _iso(r.created_at),
            "supplier_returned_at": _iso(r.supplier_returned_at),
            "supplier_returned_by": r.supplier_returned_by,
            "grn_no": r.grn_no, "grn_date": _iso(r.grn_date),
            "grn_at": _iso(r.grn_at), "grn_by": r.grn_by,
            "cancelled_by": r.cancelled_by, "cancelled_at": _iso(r.cancelled_at),
            "cancel_reason": r.cancel_reason,
        }

    def list(self, store_code, status=None, limit=None):
        """A store's RGPs, newest first. `status` is one RGP status, or OPEN for
        everything still with the supplier or waiting for its GRN."""
        q = (SpareRgp.query.options(joinedload(SpareRgp.part), joinedload(SpareRgp.source_return))
             .filter(SpareRgp.store_code == store_code))
        status = (_clean(status) or "").upper()
        if status == "OPEN":
            q = q.filter(SpareRgp.status.in_(RGP_OPEN))
        elif status:
            if status not in RGP_STATUSES:
                raise BadRequestError(f"status must be OPEN or one of {', '.join(RGP_STATUSES)}")
            q = q.filter(SpareRgp.status == status)
        q = q.order_by(SpareRgp.created_at.desc(), SpareRgp.id.desc())
        if limit:
            q = q.limit(limit)
        today = date.today()
        return [self.to_dict(r, today) for r in q.all()]

    def open_for_part(self, part_id):
        """This part's RGPs still with the supplier or waiting for the RGP GRN —
        what a scan of its QR lists (spec 18), newest first."""
        rows = (SpareRgp.query.options(joinedload(SpareRgp.part), joinedload(SpareRgp.source_return))
                .filter(SpareRgp.part_id == part_id, SpareRgp.status.in_(RGP_OPEN))
                .order_by(SpareRgp.created_at.desc(), SpareRgp.id.desc()).all())
        today = date.today()
        return [self.to_dict(r, today) for r in rows]

    # ---- suppliers ----

    def supplier_options(self, part_id):
        """Who this part can go to for rework: the ERP vendors it has actually
        come from — gate entries first (newest arrival first), then GRN vendors —
        and then the active supplier master. De-duplicated by vendor code (or by
        name where ERP gave no code). Only the ERP rows carry a ven_cd; a master
        row carries its supplier_id and NO code, because the code on an RGP must
        be ERP's for this part (rgp_out enforces the same rule)."""
        part = db.session.get(Part, part_id)
        if part is None:
            raise NotFoundError(f"Part {part_id} not found")
        key = (part.part_no or "").strip().upper()
        options, by_code, names = [], {}, set()

        def add(ven_cd, ven_name, source, last_date):
            code = _clean(ven_cd)
            name = _clean(ven_name) or code
            if not name:
                return
            if (code and code.upper() in by_code) or (not code and name.upper() in names):
                return
            opt = {"ven_cd": code, "ven_name": name, "supplier_id": None,
                   "source": source, "last_date": _iso(last_date)}
            options.append(opt)
            if code:
                by_code[code.upper()] = opt
            names.add(name.upper())

        # Newest first, so a vendor's first row carries its latest date (NULL
        # dates sort last in DESC on SQLite).
        gate = (db.session.query(GateEntry.ven_cd, GateEntry.ven_name, GateEntry.gate_entry_dt)
                .filter(func.upper(GateEntry.item_code) == key)
                .order_by(GateEntry.gate_entry_dt.desc(), GateEntry.id.desc()))
        for ven_cd, ven_name, dt in gate:
            add(ven_cd, ven_name, "GATE_ENTRY", dt)
        grn = (db.session.query(ReceivingRegister.ven_cd, ReceivingRegister.ven_name,
                                ReceivingRegister.grn_date)
               .filter(func.upper(ReceivingRegister.item_cd) == key)
               .order_by(ReceivingRegister.grn_date.desc(), ReceivingRegister.id.desc()))
        for ven_cd, ven_name, dt in grn:
            add(ven_cd, ven_name, "ERP_GRN", dt)

        masters = (Supplier.query.filter(Supplier.status == "Active")
                   .order_by(Supplier.supplier_name.asc()).all())
        for s in masters:
            code = (s.vendor_code or "").strip().upper()
            erp = by_code.get(code) if code else None
            if erp is not None:
                # Same vendor code as an ERP vendor of this part: link the master
                # record to that option rather than listing the supplier twice.
                if erp["supplier_id"] is None:
                    erp["supplier_id"] = s.id
                continue
            name = _clean(s.supplier_name)
            if not name or name.upper() in names:
                continue
            options.append({"ven_cd": None, "ven_name": name, "supplier_id": s.id,
                            "source": "SUPPLIER_MASTER", "last_date": None})
            names.add(name.upper())
        return options

    @staticmethod
    def _erp_vendor(part_no, ven_cd):
        """(ERP's spelling of the code, vendor name) when `ven_cd` is a vendor
        this part has actually come from — a gate entry or a GRN whose item code
        is the part no — else None."""
        key = (part_no or "").strip().upper()
        code = ven_cd.strip().upper()
        feeds = (
            (GateEntry, GateEntry.item_code, GateEntry.gate_entry_dt),
            (ReceivingRegister, ReceivingRegister.item_cd, ReceivingRegister.grn_date),
        )
        for model, item_col, date_col in feeds:
            hit = (db.session.query(model.ven_cd, model.ven_name)
                   .filter(func.upper(item_col) == key,
                           func.upper(func.trim(model.ven_cd)) == code)
                   .order_by(date_col.desc(), model.id.desc()).first())
            if hit:
                return hit[0].strip(), _clean(hit[1])
        return None
