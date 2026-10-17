"""Returns to store and the store inspection — spec 13 / 14.

A department sends an issued part back against its ORIGINAL issue (never as a
free receipt). The store's rule (14 Oct 2026): no inspection — whatever the
user hands back is taken straight back into store stock when the return is
recorded. return_to_store does that through the GOOD inspection, in the same
transaction, so there is one stock-in routine: one RETURN ledger row per GOOD
result, written through SpareStockService._write so on-hand, balance_after and
the cached stock lists move together, and the return closes the way a fully
Good inspection closes it.

The inspection itself stays for a return recorded before that rule and still
waiting: GOOD puts it back on the shelf, "Inspection Required" holds it,
"Damaged" keeps it apart (it may go to a supplier for rework on an RGP, or be
scrapped) and "Scrap" ends it.

Every step writes one journal row inside the same atomic() as the change it
describes, so the part history can never disagree with the documents. Each
write takes the database write lock before re-checking the quantities
(SpareStockService._lock), so two terminals — or a double-click — can never
return, or pass as good, the same quantity twice.
"""
from sqlalchemy.orm import joinedload

from app.extensions import db
from app.models.base import utcnow
from app.models.spare_flow import INSPECTION_RESULTS, RETURN_OPEN, RETURN_STATUSES, SpareReturn
from app.models.spare_stock import RETURN_ROW_INSPECTED, SpareStockLedger
from app.services.spare_journal_service import SpareJournalService
from app.services.spare_stock_service import SpareStockService
from app.utils.db_tx import atomic
from app.utils.exceptions import BadRequestError, NotFoundError

# What an inspection may do from each bucket (spec 14). Returned material not
# inspected yet can go anywhere. Held material is inspected again: good,
# damaged or scrap ("inspection required" once more would move nothing).
# Damaged material can only be scrapped here — reworked material comes back to
# stock through the RGP GRN, never by relabelling it good.
ALLOWED_RESULTS = {
    "RETURN_PENDING": ("GOOD", "INSPECTION_REQUIRED", "DAMAGED", "SCRAP"),
    "RETURN_HOLD": ("GOOD", "DAMAGED", "SCRAP"),
    "DAMAGED": ("SCRAP",),
}
# The bucket each result sends the quantity to (a SpareReturn.BUCKET_COLUMNS key).
RESULT_BUCKET = {
    "GOOD": "AVAILABLE", "INSPECTION_REQUIRED": "RETURN_HOLD",
    "DAMAGED": "DAMAGED", "SCRAP": "SCRAPPED",
}
# Short names the screens may send for the bucket to inspect from.
FROM_BUCKET_ALIASES = {
    "PENDING": "RETURN_PENDING", "RETURN_PENDING": "RETURN_PENDING",
    "HOLD": "RETURN_HOLD", "RETURN_HOLD": "RETURN_HOLD",
    "DAMAGED": "DAMAGED",
}
# Operator wording for messages.
BUCKET_WORDS = {
    "RETURN_PENDING": "waiting for inspection",
    "RETURN_HOLD": "on return hold",
    "DAMAGED": "damaged",
}
RESULT_WORDS = {
    "GOOD": "Good / Reusable", "INSPECTION_REQUIRED": "Inspection Required",
    "DAMAGED": "Damaged", "SCRAP": "Scrap",
}

# SpareReturn.reason is String(60); the reason is a RETURN_REASONS label or the
# operator's own words for "Other".
REASON_MAX = 60

# The remark of the GOOD inspection return_to_store runs (the store's rule,
# 14 Oct 2026), on its journal row and its RETURN ledger row alike. It is the
# one mark of a return taken straight back: the part timeline shows such a
# return as one event (ScanResultService) and the Part Ledger does not call it
# inspected (frontend pages/SparePartHistory.jsx compares the same text).
TAKEN_BACK_REMARK = "Taken back into stock on return — no inspection (store rule)"


def _text(value, limit=None):
    """Trimmed text or None — a blank field is "not given", never an empty value."""
    if value is None:
        return None
    value = str(value).strip()
    if not value:
        return None
    return value[:limit] if limit else value


def _qty(value, what):
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        raise BadRequestError(f"{what} must be a number")


def _f(value):
    return round(float(value or 0), 2)


def _iso(value):
    return value.isoformat() if value is not None else None


class SpareReturnService:
    def __init__(self):
        self.stock = SpareStockService()
        self.journal = SpareJournalService()

    # ------------------------------------------------------ return to store

    def return_to_store(self, issue_id, qty=None, reason=None, note=None,
                        returned_by=None, user=None, scanned_code=None, scan_source=None):
        """Spec 13: record a part coming back against its original ISSUE.

        Up to what is still out on that issue (issued - returned) may come
        back, installed parts included — they can be removed from the machine.
        `qty` None returns everything still out (the older one-click return of
        a returnable tool). Creates a SpareReturn with the issue's department /
        person / line / machine / die copied onto it, and sets the issue
        RETURNED (nothing left out) or PARTIALLY_RETURNED.

        The store's rule (14 Oct 2026): no inspection. In the same transaction
        the whole quantity goes back into store stock through the GOOD
        inspection (inspect), remarked TAKEN_BACK_REMARK: +qty on hand, one
        RETURN ledger row carrying the reason and who returned it, and the
        return CLOSED with all of it good. Two journal rows, as the two steps
        always wrote: RETURN_TO_STORE, then RETURN_INSPECTION (GOOD)."""
        issue = db.session.get(SpareStockLedger, issue_id)
        if issue is None or issue.txn_type != "ISSUE":
            raise BadRequestError("That is not an issue that can be returned")
        if issue.status == "CANCELLED":
            raise BadRequestError("This issue was cancelled and cannot be returned")
        part = issue.part
        if not part.is_active:
            raise BadRequestError(f"Part '{part.part_no}' is inactive")
        issued_qty = abs(float(issue.qty_delta))
        outstanding = round(issued_qty - self.stock._returned_qty(issue.id), 2)
        if outstanding <= 0:
            raise BadRequestError("Nothing left to return on this issue")
        qty_back = outstanding if qty is None else _qty(qty, "Return quantity")
        if qty_back <= 0:
            raise BadRequestError("Return quantity must be greater than zero")
        if qty_back > outstanding:
            raise BadRequestError(f"Cannot return {qty_back:g}: only {outstanding:g} still out on this issue")
        reason = _text(reason)
        if reason and len(reason) > REASON_MAX:
            raise BadRequestError(f"Return reason must be {REASON_MAX} characters or fewer")
        note = _text(note, 255)
        returned_by = _text(returned_by, 80)
        scanned_code, scan_source = _text(scanned_code, 80), _text(scan_source, 20)

        with atomic():
            # Lock first, then re-check against what is committed now, so two
            # slips for the same issue can't both take the same quantity.
            self.stock._lock(SpareStockLedger, issue.id)
            db.session.refresh(issue)
            if issue.status == "CANCELLED":
                raise BadRequestError("This issue was cancelled and cannot be returned")
            outstanding = round(issued_qty - self.stock._returned_qty(issue.id), 2)
            if qty_back > outstanding:
                raise BadRequestError(
                    f"Cannot return {qty_back:g}: only {outstanding:g} still out on this issue")
            ret = SpareReturn(
                return_no=self.journal.next_return_no(), part_id=issue.part_id,
                store_code=part.store_code, issue_id=issue.id, status="INSPECTION_PENDING",
                qty=qty_back, qty_pending=qty_back, qty_hold=0, qty_damaged=0,
                qty_good=0, qty_scrap=0, qty_rgp=0,
                reason=reason, remarks=note, returned_by=returned_by, received_by=user,
                department=issue.department, issued_to=issue.issued_to,
                line_name=issue.line_name, line_no=issue.line_no,
                machine=issue.machine, die_no=issue.die_no,
                scanned_code=scanned_code, scan_source=scan_source,
            )
            db.session.add(ret)
            db.session.flush()
            prev_status = issue.status
            new_status = "RETURNED" if qty_back >= outstanding else "PARTIALLY_RETURNED"
            self.stock.ledger_repo.update(issue, status=new_status)
            self.journal.record(
                issue.part_id, "RETURN_TO_STORE", qty_back, store_code=part.store_code,
                user=user, prev_status=prev_status, new_status=new_status,
                from_bucket="ISSUED", to_bucket="RETURN_PENDING",
                return_id=ret.id, issue_id=issue.id,
                department=issue.department, issued_to=issue.issued_to,
                line_name=issue.line_name, line_no=issue.line_no,
                machine=issue.machine, die_no=issue.die_no,
                return_reason=reason, remarks=note,
                scanned_code=scanned_code, scan_source=scan_source,
            )
            # Nothing waits for an inspection: the GOOD path is the one
            # stock-in routine, run here inside this transaction (atomic()
            # nests), so the return and its stock-in commit — or fail — as one.
            self.inspect(ret.id, "GOOD", qty_back, from_bucket="RETURN_PENDING",
                         remarks=TAKEN_BACK_REMARK, user=user)
        return self.to_dict(ret)

    # ---------------------------------------------------------- inspection

    def inspect(self, return_id, result, qty=None, from_bucket=None, remarks=None, user=None):
        """Spec 14: the store inspects returned material — and the GOOD path
        return_to_store runs for every new return (the store's rule); a return
        recorded before that rule may still wait for it.

        `from_bucket` defaults to what is waiting (RETURN_PENDING), then what is
        held (RETURN_HOLD), then what is damaged (DAMAGED); `qty` None takes all
        of that bucket. Allowed moves are ALLOWED_RESULTS. GOOD writes a RETURN
        ledger row (+qty to available stock) pointing at the original issue;
        every other result only moves quantity between the return's buckets, so
        held, damaged and scrapped material never counts as stock. The return's
        status is recomputed from its split (SpareReturn.refresh_status)."""
        ret = db.session.get(SpareReturn, return_id)
        if ret is None:
            raise NotFoundError(f"Return {return_id} not found")
        result = (_text(result) or "").upper()
        if result not in INSPECTION_RESULTS:
            raise BadRequestError(f"Inspection result must be one of {', '.join(INSPECTION_RESULTS)}")
        source = None
        if _text(from_bucket):
            source = FROM_BUCKET_ALIASES.get(_text(from_bucket).upper())
            if source is None:
                raise BadRequestError("Inspect from must be the returned (pending), hold or damaged quantity")
        n = None if qty is None else _qty(qty, "Inspection quantity")
        if n is not None and n <= 0:
            raise BadRequestError("Inspection quantity must be greater than zero")
        part = ret.part
        if not part.is_active:
            raise BadRequestError(f"Part '{part.part_no}' is inactive")
        remarks = _text(remarks, 255)

        with atomic():
            # Lock, then re-read the split: a second terminal inspecting the same
            # return must see this one's result, never the same quantity again.
            self.stock._lock(SpareReturn, ret.id)
            db.session.refresh(ret)
            source = source or self._default_source(ret)
            allowed = ALLOWED_RESULTS[source]
            if result not in allowed:
                raise BadRequestError(self._refusal(source, result))
            col_from = SpareReturn.BUCKET_COLUMNS[source]
            waiting = ret.q(col_from)
            if waiting <= 0:
                raise BadRequestError(f"Nothing {BUCKET_WORDS[source]} on return {ret.return_no}")
            n = waiting if n is None else n
            if n > waiting:
                raise BadRequestError(
                    f"Cannot inspect {n:g}: only {waiting:g} {BUCKET_WORDS[source]} on return {ret.return_no}")
            target = RESULT_BUCKET[result]
            col_to = SpareReturn.BUCKET_COLUMNS[target]
            setattr(ret, col_from, round(waiting - n, 2))
            setattr(ret, col_to, round(ret.q(col_to) + n, 2))
            prev_status = ret.status
            new_status = ret.refresh_status()
            ret.last_inspected_by = user
            ret.last_inspected_at = utcnow()
            ledger = self._back_to_stock(ret, n, remarks, user) if result == "GOOD" else None
            db.session.flush()
            self.journal.record(
                ret.part_id, "RETURN_INSPECTION", n, store_code=ret.store_code, user=user,
                prev_status=prev_status, new_status=new_status,
                from_bucket=source, to_bucket=target,
                return_id=ret.id, issue_id=ret.issue_id,
                ledger_id=ledger.id if ledger else None,
                department=ret.department, issued_to=ret.issued_to,
                line_name=ret.line_name, line_no=ret.line_no,
                machine=ret.machine, die_no=ret.die_no,
                return_reason=ret.reason, inspection_result=result, remarks=remarks,
            )
        out = self.to_dict(ret)
        out["inspection"] = {
            "result": result, "qty": n, "from_bucket": source, "to_bucket": target,
            "ledger_id": ledger.id if ledger else None,
        }
        return out

    @staticmethod
    def _default_source(ret):
        for bucket in ("RETURN_PENDING", "RETURN_HOLD", "DAMAGED"):
            if ret.q(SpareReturn.BUCKET_COLUMNS[bucket]) > 0:
                return bucket
        raise BadRequestError(f"Nothing left to inspect on return {ret.return_no}")

    @staticmethod
    def _refusal(source, result):
        if source == "DAMAGED":
            return ("Damaged material cannot be passed as " + RESULT_WORDS[result]
                    + " here — scrap it, or send it for supplier rework on an RGP")
        allowed = ", ".join(RESULT_WORDS[r] for r in ALLOWED_RESULTS[source])
        return (f"Material {BUCKET_WORDS[source]} cannot be marked {RESULT_WORDS[result]} "
                f"— choose {allowed}")

    def _back_to_stock(self, ret, qty, remarks, user):
        """GOOD: add `qty` to available stock as one RETURN ledger row against
        the original issue (return_of_id), carrying the return no. and where the
        part came back from. Status RETURN_ROW_INSPECTED marks it as quantity
        already counted from this return, so the issue's returned figure never
        counts it twice. Returns the ledger row."""
        issue = ret.issue
        row = self.stock.repo.get_or_create(ret.part_id)
        # This transaction holds the write lock (inspect), so the committed
        # figure read here cannot change before the write below.
        db.session.refresh(row)
        new_qty = round(float(row.qty_on_hand or 0) + qty, 2)
        _, _, ledger = self.stock._write(
            ret.part_id, new_qty, "RETURN",
            reference=issue.reference if issue else None,
            remarks=remarks or f"Return {ret.return_no} inspected good",
            user=user, department=ret.department, machine=ret.machine,
            return_of_id=ret.issue_id,
            extra={"status": RETURN_ROW_INSPECTED, "return_no": ret.return_no,
                   "return_reason": ret.reason, "returned_by": ret.returned_by,
                   "issued_to": ret.issued_to, "line_name": ret.line_name,
                   "line_no": ret.line_no, "die_no": ret.die_no},
            return_ledger=True,
        )
        return ledger

    # ------------------------------------------------------------- reading

    @staticmethod
    def to_dict(r):
        part, issue = r.part, r.issue
        pending, hold, damaged = _f(r.qty_pending), _f(r.qty_hold), _f(r.qty_damaged)
        return {
            "id": r.id, "return_no": r.return_no, "status": r.status,
            "part_id": r.part_id,
            "part_no": part.part_no if part else None,
            "part_name": part.part_name if part else None,
            "uom": part.uom if part else None,
            "store_code": r.store_code,
            "issue_id": r.issue_id,
            "qty": _f(r.qty),
            "qty_pending": pending, "qty_hold": hold, "qty_damaged": damaged,
            "qty_good": _f(r.qty_good), "qty_scrap": _f(r.qty_scrap), "qty_rgp": _f(r.qty_rgp),
            # Still in the store and not decided for good: waiting + held + damaged.
            "qty_open": round(pending + hold + damaged, 2),
            "reason": r.reason, "remarks": r.remarks,
            "returned_by": r.returned_by, "received_by": r.received_by,
            "department": r.department, "issued_to": r.issued_to,
            "line_name": r.line_name, "line_no": r.line_no,
            "machine": r.machine, "die_no": r.die_no,
            # The original issue, so the return reads on its own (spec 13 screen).
            "issue_date": _iso(issue.created_at) if issue else None,
            "issued_qty": abs(float(issue.qty_delta)) if issue else None,
            "issued_by": issue.created_by if issue else None,
            "issue_status": issue.status if issue else None,
            "last_inspected_by": r.last_inspected_by,
            "last_inspected_at": _iso(r.last_inspected_at),
            "scanned_code": r.scanned_code, "scan_source": r.scan_source,
            "created_at": _iso(r.created_at),
        }

    def list(self, store_code, status=None, limit=None):
        """A store's returns, newest first. `status` is one status, a
        comma-separated list, or OPEN (waiting / held / damaged)."""
        q = (SpareReturn.query
             .options(joinedload(SpareReturn.part), joinedload(SpareReturn.issue))
             .filter(SpareReturn.store_code == store_code))
        statuses = self._statuses(status)
        if statuses:
            q = q.filter(SpareReturn.status.in_(statuses))
        q = q.order_by(SpareReturn.created_at.desc(), SpareReturn.id.desc())
        if limit:
            q = q.limit(limit)
        return [self.to_dict(r) for r in q.all()]

    def open_for_part(self, part_id):
        """This part's returns still in the store undecided (waiting, held or
        damaged), newest first — what a scan of the part offers to inspect."""
        rows = (SpareReturn.query
                .options(joinedload(SpareReturn.part), joinedload(SpareReturn.issue))
                .filter(SpareReturn.part_id == part_id, SpareReturn.status.in_(RETURN_OPEN))
                .order_by(SpareReturn.created_at.desc(), SpareReturn.id.desc())
                .all())
        return [self.to_dict(r) for r in rows]

    @staticmethod
    def get(return_id):
        return db.session.get(SpareReturn, return_id)

    @staticmethod
    def _statuses(status):
        status = _text(status)
        if not status:
            return None
        if status.upper() == "OPEN":
            return list(RETURN_OPEN)
        wanted = [s.strip().upper() for s in status.split(",") if s.strip()]
        unknown = [s for s in wanted if s not in RETURN_STATUSES]
        if unknown:
            raise BadRequestError(
                f"Unknown return status {', '.join(unknown)} — use OPEN or {', '.join(RETURN_STATUSES)}")
        return wanted
