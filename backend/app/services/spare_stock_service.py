"""Spare on-hand stock: setting it, moving it, and the figures it unlocks.

Min/Max on a spare meant nothing until this existed — the store could record
that a part should never fall below 2, with nothing anywhere to say how many
were actually on the shelf. Everything here is scoped to a store, so the
Child Parts screens are untouched.
"""
import threading
import time
from datetime import datetime, timedelta

from sqlalchemy import event
from sqlalchemy.orm import Session as OrmSession

from app.extensions import db
from app.models.base import utcnow
from app.models.part import Part
from app.models.spare_stock import (
    ERP_ORIGIN_RECEIPT_STATUSES, RETURN_ROW_INSPECTED, SpareStock,
)
from app.repositories.supplier_window_schedule_repository import SHIFT_START
from app.repositories.part_repository import PartRepository
from app.repositories.spare_stock_repository import (
    SpareStockLedgerRepository, SpareStockRepository,
)
from app.repositories.erp_stock_repository import ERPStockRepository
from app.services.erp_gap_service import ERPGapService
from app.services.spare_journal_service import SpareJournalService
from app.utils.db_tx import atomic
from app.utils.excel_io import bulk_import, build_export, build_template, to_number, to_text
from app.utils.exceptions import BadRequestError, NotFoundError

FIELD_ALIASES = {
    "part_no": {"partno", "partnumber", "itemcode", "itemno"},
    "qty_on_hand": {"qtyonhand", "qty", "quantity", "openingqty", "openingstock",
                    "physicalstock", "physicalqty", "stock", "closingstock", "totalqty"},
}
REQUIRED_FIELDS = ["part_no", "qty_on_hand"]

# A short-lived cache for the whole-store stock list. One dashboard refresh fires
# list + summary + analytics, which each rebuild list_stock over every part; the
# combined "all sections" view makes that ~4,800 rows built three times. Caching
# the built rows for a few seconds means one build serves all three. It is cleared
# on every stock write (see _write), so an issue / receipt / count still shows at
# once; the TTL only bounds staleness if a write path ever bypasses _write.
_STOCK_CACHE = {}
_STOCK_CACHE_TTL = 5.0


def _clear_after_commit(session):
    """A stock write clears the cache at once AND again once its transaction
    commits: between the two, a concurrent read can rebuild the list from the
    not-yet-committed (old) rows and cache them for 5 s — this second clear
    drops that stale copy."""
    if session.info.pop("spare_stock_dirty", False):
        _STOCK_CACHE.clear()


event.listen(OrmSession, "after_commit", _clear_after_commit)


def invalidate_stock_cache():
    """Drop the cached stock lists. For writes that change what a stock row shows
    without going through _write — a part's location, limits, rate or name —
    so the refresh their "stock" push triggers doesn't read the old rows back."""
    _STOCK_CACHE.clear()
# Per-key build locks for single-flight. A dashboard load fires ~6 endpoints that
# each need the whole stock list AT THE SAME INSTANT (Promise.all), so all six
# miss the TTL cache together and each rebuilds ~4,800 rows. The lock makes the
# first caller build once while the rest wait and then read the fresh cache.
_STOCK_BUILD_LOCKS = {}
_STOCK_BUILD_LOCKS_GUARD = threading.Lock()


def _stock_build_lock(key):
    with _STOCK_BUILD_LOCKS_GUARD:
        lock = _STOCK_BUILD_LOCKS.get(key)
        if lock is None:
            lock = _STOCK_BUILD_LOCKS[key] = threading.Lock()
        return lock

# Shop-floor departments that draw spares — the split behind Department-wise
# Consumption. Recorded on every ISSUE.
DEPARTMENTS = ("Press Shop", "Maintenance", "Tool Room")

TEMPLATE_COLUMNS = ["Part No", "Part Name", "Qty On Hand"]

EXPORT_COLUMNS = [
    ("Part No", "part_no"), ("Part Name", "part_name"), ("Location", "location"),
    ("Qty On Hand", "qty_on_hand"), ("Min", "min_stock_level"),
    ("Reorder Level", "reorder_level"), ("Max", "max_stock_level"),
    ("Shortfall", "shortfall"), ("Rate", "unit_price"), ("Stock Value", "stock_value"),
    ("Status", "status"), ("Last Counted", "last_counted_at"),
]

# The ledger types the ERP stock-write push sends (the stock movements; OPENING
# and ADJUSTMENT are the store's own counts, not movements ERP must mirror).
ERP_PUSH_TYPES = ("ISSUE", "RECEIPT", "RETURN")


def _clean(value):
    """Trimmed text or None — a blank field is "not given", never an empty value."""
    return (value or "").strip() or None


# "The caller did not mention this field" for confirm_installation's place
# fields. None cannot mean that: an operator who empties Die (the part moved to
# a machine with no die) sends null to CLEAR it, and treating that as "keep"
# would leave the old die on the issue and in the journal as its current place.
_KEEP = object()


class SpareStockService:
    def __init__(self):
        self.repo = SpareStockRepository()
        self.ledger_repo = SpareStockLedgerRepository()
        self.part_repo = PartRepository()
        self.erp_repo = ERPStockRepository()
        self.journal = SpareJournalService()

    # ---- movement ----

    def _write(self, part_id, new_qty, txn_type, reference=None, remarks=None,
               user=None, counted=False, department=None, machine=None,
               returnable=False, return_of_id=None, extra=None, return_ledger=False):
        """Set a part's quantity and record why, in one go. The ledger row and
        the maintained qty are written together — a balance that moved with no
        row to explain it is worse than no history at all. `extra` carries the
        two-stage-issue / structured-receiving columns onto the ledger row.

        Returns (stock_row, delta). With return_ledger=True it returns
        (stock_row, delta, ledger_row) — the row a journal entry or a document
        points at (None for a zero-delta write, which records no row)."""
        row = self.repo.get_or_create(part_id)
        before = float(row.qty_on_hand or 0)
        delta = round(new_qty - before, 2)

        row.qty_on_hand = new_qty
        if counted:
            row.last_counted_at = utcnow()

        # An import that re-states the same figure is not a movement. Writing a
        # zero-delta row for all 481 parts on every upload would bury the real
        # ones within a week.
        ledger = None
        if delta != 0:
            ledger = self.ledger_repo.create(
                part_id=part_id, qty_delta=delta, balance_after=new_qty,
                txn_type=txn_type, reference=reference, remarks=remarks,
                created_by=user, department=department, machine=machine,
                returnable=returnable, return_of_id=return_of_id,
                **(extra or {}),
            )
        # Stock just changed — drop the cached lists so the next read is fresh,
        # and flag the session so they are dropped again after the commit.
        _STOCK_CACHE.clear()
        db.session.info["spare_stock_dirty"] = True
        if return_ledger:
            return row, delta, ledger
        return row, delta

    @staticmethod
    def _lock(model, row_id):
        """Take the database write lock before a re-check that must not race.

        SQLite serialises writers, but a plain SELECT holds no lock: two
        requests can both read "3 still out" and both act on it. Touching the
        row first (its updated_at) makes this transaction the writer, so what it
        reads next is what is committed, and a concurrent request waits
        (busy_timeout) and then reads this one's result. On a server database
        the same UPDATE is a row lock. Call it first inside `with atomic():`,
        then refresh any row already loaded before it."""
        db.session.query(model).filter(model.id == row_id).update(
            {model.updated_at: utcnow()}, synchronize_session=False)

    def set_quantity(self, part_id, qty, txn_type="ADJUSTMENT", reference=None,
                     remarks=None, user=None):
        part = self.part_repo.get_by_id(part_id)
        if not part:
            raise NotFoundError(f"Part {part_id} not found")
        if qty is None or float(qty) < 0:
            raise BadRequestError("Quantity must be zero or more")
        with atomic():
            row, _ = self._write(
                part.id, round(float(qty), 2), txn_type,
                reference=reference, remarks=remarks, user=user,
                counted=txn_type in ("OPENING", "ADJUSTMENT"),
            )
        return self._row_dict(part, row)

    def _valid_department_names(self):
        """Active department names from the master (dynamic — new departments
        become issuable with no code change). Falls back to the seed tuple only
        if the master table is somehow empty, so a partial/empty master never
        blocks the store."""
        from app.models.department import Department
        names = {d.name for d in Department.query.filter_by(is_active=True).all()}
        return names or set(DEPARTMENTS)

    @staticmethod
    def _issue_person(employee_id=None, mobile=None):
        """The Employee master person an issue is handed to, or None for the
        old free-text "Issued To". The counter sends employee_id (and the mobile
        it was found by); a mobile alone is looked up. Refused when the person
        is not on the master or is inactive, or when the mobile sent is not that
        person's — never an issue booked to someone the master can't name."""
        from app.models.employee import Employee, normalise_mobile
        if employee_id is None and not _clean(mobile):
            return None
        norm = None
        if _clean(mobile):
            norm = normalise_mobile(mobile)
            if not norm:
                raise BadRequestError("Enter a valid 10-digit mobile number")
        if employee_id is not None:
            emp = db.session.get(Employee, employee_id)
            if emp is None:
                raise BadRequestError(f"Person {employee_id} is not on the Employee Master")
            if norm and norm != emp.mobile:
                raise BadRequestError(f"Mobile {norm} is not {emp.name}'s — look the person up again")
        else:
            emp = Employee.query.filter_by(mobile=norm).first()
            if emp is None:
                raise BadRequestError(f"Mobile {norm} is not on the Employee Master — add the person first")
        if not emp.is_active:
            raise BadRequestError(f"{emp.name} is inactive on the Employee Master — "
                                  f"ask a supervisor to reactivate them")
        return emp

    def issue(self, part_id, qty, department, machine=None, returnable=False,
              reference=None, remarks=None, user=None, issued_to=None, status=None,
              scanned_code=None, scan_source=None, employee_id=None, issued_to_mobile=None):
        """Stage 1 of the two-stage issue: the store issues a spare to a
        department + person. Machine/line are NOT required here — the store may
        not know where it will be fitted; the user confirms those later
        (confirm_installation). Deducts on-hand, writes an ISSUE ledger row, and
        refuses to issue more than is on the shelf. Department is validated
        against the live master, so a newly-added department works with no code
        change.

        The ISSUE ledger row is the issue document every later step points at
        (installation updates, returns), so the journal ISSUE row carries its id
        as both issue_id and ledger_id, and the result hands the row back as
        `issue` — the screen never has to guess which row it just created.

        The taker is found by mobile number on the Employee master
        (_issue_person): the ledger and journal rows keep the person's id,
        mobile and employee code as they were at issue time, and Issued To
        defaults to their name. Department is still the operator's pick (the
        form pre-fills the person's own). Without a person, issued_to stays
        free text."""
        part = self.part_repo.get_by_id(part_id)
        if not part:
            raise NotFoundError(f"Part {part_id} not found")
        if not part.is_active:
            raise BadRequestError(f"Part '{part.part_no}' is inactive")
        qty = float(qty) if qty is not None else 0.0
        if qty <= 0:
            raise BadRequestError("Issue quantity must be greater than zero")
        if department not in self._valid_department_names():
            raise BadRequestError(f"Unknown department '{department}'")
        machine = _clean(machine)
        issued_to = _clean(issued_to)
        emp = self._issue_person(employee_id, issued_to_mobile)
        person = {"employee_id": None, "issued_to_mobile": None, "issued_to_code": None}
        if emp is not None:
            issued_to = issued_to or emp.name
            person = {"employee_id": emp.id, "issued_to_mobile": emp.mobile,
                      "issued_to_code": emp.employee_code}
        status = status or "PENDING_USER_CONFIRMATION"
        with atomic():
            row = self.repo.get_or_create(part.id)
            # Lock, then re-read on-hand, so two terminals can't both issue the
            # last pieces on the shelf.
            self._lock(SpareStock, row.id)
            db.session.refresh(row)
            on_hand = float(row.qty_on_hand or 0)
            if qty > on_hand:
                raise BadRequestError(f"Cannot issue {qty:g}: only {on_hand:g} on hand")
            row, _, ledger = self._write(
                part.id, round(on_hand - qty, 2), "ISSUE",
                reference=reference, remarks=remarks, user=user,
                department=department, machine=machine, returnable=bool(returnable),
                extra={"issued_to": issued_to, "status": status, **person},
                return_ledger=True,
            )
            self.journal.record(
                part.id, "ISSUE", qty, store_code=part.store_code, user=user,
                new_status=status, from_bucket="AVAILABLE", to_bucket="ISSUED",
                issue_id=ledger.id, ledger_id=ledger.id,
                department=department, issued_to=issued_to, machine=machine, **person,
                remarks=remarks, scanned_code=_clean(scanned_code), scan_source=_clean(scan_source),
            )
        result = self._row_dict(part, row)
        result["issue"] = self._issue_row_dict(ledger)
        return result

    def confirm_installation(self, ledger_id, line_name=_KEEP, line_no=_KEEP,
                             machine=_KEEP, actual_qty=None, user=None, remarks=None,
                             die_no=_KEEP):
        """Stage 2 and every "Update Line / Machine" after it (spec 11/12): the
        person who fitted the part records WHERE it is — line, machine, die —
        and how much of what is still out was actually used.

        Repeatable while the issue is not cancelled and something of it is
        still out (issued - returned > 0): a part can move to another machine
        or die, and the store needs its latest place. The ISSUE row holds the
        CURRENT values; each update also appends an INSTALLATION journal row
        with the previous / new status and the line / machine / die in force
        after it, so an earlier location is never lost.

        A place field left out keeps its current value (the fitter re-confirms
        what did not change); one passed as None or blank CLEARS it — a part
        moved to a machine with no die must not keep showing the old die, and
        a wrongly entered line or machine must be removable. Status follows the
        latest update: INSTALLED when everything still out was used, else
        PARTIALLY_USED. No stock moves — the quantity left available at issue."""
        from app.models.spare_stock import SpareStockLedger
        row = self.ledger_repo.get_by_id(ledger_id)
        if not row or row.txn_type != "ISSUE":
            raise NotFoundError(f"Issue {ledger_id} not found")
        if row.status == "CANCELLED":
            raise BadRequestError("This issue was cancelled")
        part = row.part
        if part is not None and not part.is_active:
            raise BadRequestError(f"Part '{part.part_no}' is inactive")
        place = {"line_name": line_name, "line_no": line_no,
                 "machine": machine, "die_no": die_no}
        remarks = _clean(remarks)
        issued_qty = abs(float(row.qty_delta))
        with atomic():
            # Lock, then re-read: a return landing at the same moment must not
            # let this update claim quantity that already came back.
            self._lock(SpareStockLedger, row.id)
            db.session.refresh(row)
            if row.status == "CANCELLED":
                raise BadRequestError("This issue was cancelled")
            outstanding = round(issued_qty - self._returned_qty(row.id), 2)
            if outstanding <= 0:
                raise BadRequestError("Nothing of this issue is still out — it has all been returned")
            used = outstanding if actual_qty is None else round(float(actual_qty), 2)
            if used < 0 or used > outstanding:
                raise BadRequestError(
                    f"Actual usage must be between 0 and {outstanding:g} (still out on this issue)")
            prev_status = row.status
            new_status = "INSTALLED" if used >= outstanding else "PARTIALLY_USED"
            # Resolved after the re-read, so a field kept is the value committed
            # now, not one a concurrent update has since replaced.
            current = {k: (getattr(row, k) if v is _KEEP else _clean(v))
                       for k, v in place.items()}
            self.ledger_repo.update(
                row, **current,
                actual_qty=used, confirmed_by=user, confirmed_at=utcnow(),
                status=new_status, remarks=remarks or row.remarks,
            )
            self.journal.record(
                row.part_id, "INSTALLATION", used,
                store_code=part.store_code if part else None, user=user,
                prev_status=prev_status, new_status=new_status, issue_id=row.id,
                department=row.department, issued_to=row.issued_to,
                line_name=row.line_name, line_no=row.line_no, machine=row.machine,
                die_no=row.die_no, remarks=remarks,
            )
        result = self._issue_row_dict(row)
        result.update({"returned_qty": round(issued_qty - outstanding, 2),
                       "outstanding_qty": outstanding})
        return result

    def receive(self, part_id, qty=None, **_):
        """Receiving, the GRN and the Maintenance / Tool Room quality clearance
        are done in ERP (user decision 2026-09-26). A GRN line whose quality ERP
        accepted becomes store stock through ErpGrnPostingService, read by the
        ERP sync — nothing is received by hand any more. A caller still on the
        old path gets the same 410 the route answers, never a silent no-op."""
        from app.services.spare_receipt_service import ReceivingInErpError
        raise ReceivingInErpError()

    def update_location(self, part_id, new_location, reason=None, qty=None, user=None):
        """Move a spare to a new rack/shelf. Records the old + new location in the
        location history instead of silently overwriting it, and applies the
        change only after that succeeds. Location is locally owned today."""
        from app.models.location_history import SpareLocationHistory
        part = self.part_repo.get_by_id(part_id)
        if not part:
            raise NotFoundError(f"Part {part_id} not found")
        new_location = (new_location or "").strip()
        if not new_location:
            raise BadRequestError("New location is required")
        old_location = part.location or None
        if new_location == (old_location or ""):
            raise BadRequestError("New location is the same as the current one")
        with atomic():
            self.part_repo.update(part, location=new_location)
            db.session.add(SpareLocationHistory(
                part_id=part.id, old_location=old_location, new_location=new_location,
                reason=(reason or "").strip() or None,
                qty=(round(float(qty), 2) if qty is not None else None), moved_by=user,
            ))
        invalidate_stock_cache()  # the stock rows carry the location
        return {
            "part_id": part.id, "part_no": part.part_no,
            "old_location": old_location, "new_location": new_location,
        }

    def pending_confirmations(self, store_code, limit=None):
        """ISSUE rows awaiting Stage-2 user confirmation (line/machine/install),
        newest first — the queue a user works through by re-scanning."""
        from app.models.spare_stock import SpareStockLedger
        q = (
            db.session.query(SpareStockLedger)
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(
                Part.store_code == store_code,
                SpareStockLedger.txn_type == "ISSUE",
                SpareStockLedger.status.in_(("PENDING_USER_CONFIRMATION", "ISSUED_BY_STORE")),
            )
            .order_by(SpareStockLedger.created_at.desc(), SpareStockLedger.id.desc())
        )
        if limit:
            q = q.limit(limit)
        return [self._issue_row_dict(r) for r in q.all()]

    def pending_confirmations_for_part(self, part_id):
        from app.models.spare_stock import SpareStockLedger
        rows = (
            SpareStockLedger.query.filter(
                SpareStockLedger.part_id == part_id,
                SpareStockLedger.txn_type == "ISSUE",
                SpareStockLedger.status.in_(("PENDING_USER_CONFIRMATION", "ISSUED_BY_STORE")),
            ).order_by(SpareStockLedger.created_at.desc(), SpareStockLedger.id.desc()).all()
        )
        return [self._issue_row_dict(r) for r in rows]

    def location_history_for_part(self, part_id):
        from app.models.location_history import SpareLocationHistory
        rows = (
            SpareLocationHistory.query.filter_by(part_id=part_id)
            .order_by(SpareLocationHistory.created_at.desc(), SpareLocationHistory.id.desc()).all()
        )
        return [{
            "id": r.id, "old_location": r.old_location, "new_location": r.new_location,
            "reason": r.reason, "qty": float(r.qty) if r.qty is not None else None,
            "moved_by": r.moved_by, "at": r.created_at.isoformat() if r.created_at else None,
        } for r in rows]

    @staticmethod
    def _installed_qty(issue_row):
        """How much of an ISSUE the fitter recorded as used on the line — for
        display only. An INSTALLED row with no figure counts as fully used.
        It no longer limits a return: an installed part can be removed from the
        machine and sent back, so "still out" is issued - returned."""
        issued = abs(float(issue_row.qty_delta))
        if issue_row.status in ("INSTALLED", "PARTIALLY_USED") and issue_row.actual_qty is not None:
            return round(min(float(issue_row.actual_qty), issued), 2)
        if issue_row.status == "INSTALLED":
            return issued
        return 0.0

    @staticmethod
    def _returned_qty_map(issue_ids):
        """{issue_id: quantity returned against it}, in a few set queries — the
        one rule behind every "still out" figure (outstanding = issued -
        returned):

        * every return raised against the issue (spare_returns.qty), whatever
          its inspection later decided — the part is back in the store;
        * legacy direct RETURN ledger rows, written before returns went through
          inspection. A RETURN row written by a GOOD inspection
          (RETURN_ROW_INSPECTED) is quantity already counted from its return,
          so it is not summed a second time."""
        from sqlalchemy import func, or_
        from app.models.spare_flow import SpareReturn
        from app.models.spare_stock import SpareStockLedger

        ids = sorted({i for i in (issue_ids or ()) if i is not None})
        out = {i: 0.0 for i in ids}
        # Chunked so a long list stays under SQLite's bound-parameter limit.
        for start in range(0, len(ids), 500):
            chunk = ids[start:start + 500]
            returns = (db.session.query(SpareReturn.issue_id, func.sum(SpareReturn.qty))
                       .filter(SpareReturn.issue_id.in_(chunk))
                       .group_by(SpareReturn.issue_id))
            legacy = (db.session.query(SpareStockLedger.return_of_id,
                                       func.sum(func.abs(SpareStockLedger.qty_delta)))
                      .filter(SpareStockLedger.return_of_id.in_(chunk),
                              SpareStockLedger.txn_type == "RETURN",
                              # NULL status = a legacy direct return; `!=` alone
                              # would drop it (NULL never compares true).
                              or_(SpareStockLedger.status.is_(None),
                                  SpareStockLedger.status != RETURN_ROW_INSPECTED))
                      .group_by(SpareStockLedger.return_of_id))
            for issue_id, total in (*returns.all(), *legacy.all()):
                out[issue_id] += float(total or 0)
        return {k: round(v, 2) for k, v in out.items()}

    @staticmethod
    def _returned_qty(issue_id):
        """Quantity already returned against one ISSUE (see _returned_qty_map)."""
        return SpareStockService._returned_qty_map([issue_id]).get(issue_id, 0.0)

    def return_item(self, ledger_id, qty=None, reason=None, note=None,
                    returned_by=None, user=None, scanned_code=None, scan_source=None):
        """Take an issued part back to the store against its ORIGINAL issue
        (spec 13). Works for ANY issue, not just a returnable tool/die, and an
        installed part may come back too (removed from the machine).

        Nothing returned goes straight back on the shelf any more (spec 14): the
        return is held for the store inspection (SpareReturnService), and only a
        GOOD inspection adds it to available stock — on-hand is unchanged here.
        The ISSUE becomes RETURNED when nothing is left out, else
        PARTIALLY_RETURNED. The result keeps the older keys (the stock row,
        return_no, returned_qty, issue_id, issue_status) for the screens that
        read them, plus `return`: the return document waiting for inspection."""
        from app.services.spare_return_service import SpareReturnService
        ret = SpareReturnService().return_to_store(
            ledger_id, qty=qty, reason=reason, note=note, returned_by=returned_by,
            user=user, scanned_code=scanned_code, scan_source=scan_source,
        )
        part = self.part_repo.get_by_id(ret["part_id"])
        result = self._row_dict(part, self.repo.get_by_part(part.id))
        result.update({"return_no": ret["return_no"], "returned_qty": ret["qty"],
                       "issue_id": ledger_id, "issue_status": ret["issue_status"],
                       "return": ret})
        return result

    def returnable_issues_for_part(self, part_id):
        """Issues of this part with something still out — what the store picks
        from when a department brings a part back (spec 13: a return is recorded
        against its ORIGINAL issue). Outstanding = issued - returned; an
        installed part still counts as out, since it can be removed from the
        machine and sent back. Newest first; ordinary issues, not only
        returnable tools. Carries the issue's current line / machine / die and
        installation so the return screen shows where the part came from."""
        from app.models.spare_stock import SpareStockLedger
        issues = [
            i for i in SpareStockLedger.query.filter(
                SpareStockLedger.part_id == part_id,
                SpareStockLedger.txn_type == "ISSUE",
            ).order_by(SpareStockLedger.created_at.desc(), SpareStockLedger.id.desc()).all()
            if i.status != "CANCELLED"
        ]
        # Returned quantities for all of them at once, not a query per issue.
        returned = self._returned_qty_map([i.id for i in issues])

        out = []
        for i in issues:
            issued_qty = abs(float(i.qty_delta))
            already = returned.get(i.id, 0.0)
            outstanding = round(issued_qty - already, 2)
            if outstanding <= 0:
                continue
            out.append({
                "id": i.id,
                "part_id": i.part_id,
                "part_no": i.part.part_no if i.part else None,
                "part_name": i.part.part_name if i.part else None,
                "issued_qty": issued_qty,
                # Kept for the screens that show "N fitted"; informational only
                # (see _installed_qty) — it no longer reduces what can come back.
                "consumed_qty": self._installed_qty(i),
                "actual_qty": float(i.actual_qty) if i.actual_qty is not None else None,
                "returned_qty": already,
                "outstanding_qty": outstanding,
                "department": i.department,
                "issued_to": i.issued_to,
                "employee_id": i.employee_id,
                "issued_to_mobile": i.issued_to_mobile,
                "issued_to_code": i.issued_to_code,
                "line_name": i.line_name,
                "line_no": i.line_no,
                "machine": i.machine,
                "die_no": i.die_no,
                "returnable": bool(i.returnable),
                "status": i.status,
                "reference": i.reference,
                "issued_by": i.created_by,
                "issued_at": i.created_at.isoformat() if i.created_at else None,
                "confirmed_by": i.confirmed_by,
                "confirmed_at": i.confirmed_at.isoformat() if i.confirmed_at else None,
            })
        return out

    def outstanding_returnables(self, store_code):
        """Returnable tools/dies still out on the floor — every returnable ISSUE
        (not cancelled) with something not yet returned, newest first. A partial
        return leaves the rest outstanding (the first RETURN used to close the
        whole issue), and a return counts as back even while it waits for
        inspection: the tool is in the store then, not on the floor."""
        from sqlalchemy import or_
        from app.models.spare_stock import SpareStockLedger
        rows = (
            db.session.query(SpareStockLedger)
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(
                Part.store_code == store_code,
                SpareStockLedger.txn_type == "ISSUE",
                SpareStockLedger.returnable.is_(True),
                or_(SpareStockLedger.status.is_(None), SpareStockLedger.status != "CANCELLED"),
            )
            .order_by(SpareStockLedger.created_at.desc(), SpareStockLedger.id.desc())
            .all()
        )
        returned = self._returned_qty_map([r.id for r in rows])
        out = []
        for r in rows:
            issued_qty = abs(float(r.qty_delta))
            outstanding = round(issued_qty - returned.get(r.id, 0.0), 2)
            if outstanding <= 0:
                continue
            out.append({
                "id": r.id,
                "part_id": r.part_id,
                "part_no": r.part.part_no if r.part else None,
                "part_name": r.part.part_name if r.part else None,
                "qty": issued_qty,
                "issued_qty": issued_qty,
                "returned_qty": returned.get(r.id, 0.0),
                "outstanding_qty": outstanding,
                "department": r.department,
                "issued_to": r.issued_to,
                "issued_to_mobile": r.issued_to_mobile,
                "issued_to_code": r.issued_to_code,
                "line_name": r.line_name,
                "machine": r.machine,
                "die_no": r.die_no,
                "status": r.status,
                "reference": r.reference,
                "issued_at": r.created_at.isoformat() if r.created_at else None,
            })
        return out

    # ---- reading ----

    @staticmethod
    def _row_dict(part, stock):
        qty = float(stock.qty_on_hand) if stock and stock.qty_on_hand is not None else None
        minimum = float(part.min_stock_level or 0)
        maximum = float(part.max_stock_level) if part.max_stock_level is not None else None
        reorder = float(part.reorder_level) if part.reorder_level is not None else None
        rate = float(part.unit_price) if part.unit_price is not None else None

        if qty is None:
            status = "Not Counted"
        elif qty <= 0:
            status = "Out of Stock"
        elif minimum > 0 and qty < minimum:
            status = "Below Minimum"
        # Reorder point sits between min and max: at/below it (but still above the
        # minimum) means "time to order", a step short of critical.
        elif reorder is not None and reorder > 0 and qty <= reorder:
            status = "Reorder"
        elif maximum and qty > maximum:
            status = "Above Maximum"
        else:
            status = "Healthy"

        return {
            "part_id": part.id, "part_no": part.part_no, "part_name": part.part_name,
            # old_part_no = the customer/OEM reference code (Part Master maps
            # "reference code" -> old_part_no); carried so the dashboard can
            # search + show parts by their reference code, not just the TBDI no.
            "old_part_no": part.old_part_no, "new_part_no": part.new_part_no,
            "location": part.location, "rework_location": part.rework_location,
            "uom": part.uom, "section_id": part.section_id,
            # Business category (BOP / Import / …) and component type — carried so
            # the Live Dashboard can group on-hand parts by category and by status.
            "category": part.category, "sub_category": part.sub_category,
            "qty_on_hand": qty,
            "min_stock_level": minimum,
            "reorder_level": reorder,
            "max_stock_level": maximum,
            # What it would take to get back to the maximum — the reorder
            # quantity, once anyone wants to raise one.
            "shortfall": round(maximum - qty, 2) if (maximum and qty is not None and qty < maximum) else None,
            "unit_price": rate,
            "stock_value": round(qty * rate, 2) if (qty is not None and rate is not None) else None,
            "status": status,
            "last_counted_at": stock.last_counted_at.isoformat() if stock and stock.last_counted_at else None,
        }

    @staticmethod
    def _issue_row_dict(row):
        """One ISSUE row with its two-stage detail — used by the confirmation
        queue, the issue response and the installation-update response."""
        return {
            "id": row.id,
            "part_id": row.part_id,
            "part_no": row.part.part_no if row.part else None,
            "part_name": row.part.part_name if row.part else None,
            "qty": abs(float(row.qty_delta)),
            "actual_qty": float(row.actual_qty) if row.actual_qty is not None else None,
            "department": row.department,
            "issued_to": row.issued_to,
            # The Employee-master person (found by mobile no. at the counter);
            # None on free-text and older issues.
            "employee_id": row.employee_id,
            "issued_to_mobile": row.issued_to_mobile,
            "issued_to_code": row.issued_to_code,
            "machine": row.machine,
            "line_name": row.line_name,
            "line_no": row.line_no,
            "die_no": row.die_no,
            "status": row.status,
            "returnable": row.returnable,
            "reference": row.reference,
            "remarks": row.remarks,
            "issued_by": row.created_by,
            "issued_at": row.created_at.isoformat() if row.created_at else None,
            "confirmed_by": row.confirmed_by,
            "confirmed_at": row.confirmed_at.isoformat() if row.confirmed_at else None,
        }

    def resolve_scan(self, store_code, code):
        """Resolve a scanned barcode / part number to this store's spare part —
        the part's dedicated barcode first, then its part number
        (PartRepository.get_by_scan_code). Rejects a code that isn't in this
        store so a scan can't pull another store's part. Works with part numbers
        today and real barcode labels once they exist."""
        code = (code or "").strip()
        if not code:
            raise BadRequestError("No code scanned")
        part = self.part_repo.get_by_scan_code(code)
        if not part or part.store_code != store_code:
            raise NotFoundError(f"No part in this store for code '{code}'")
        return self._row_dict(part, self.repo.get_by_part(part.id))

    def get_for_part(self, part_id):
        """One part's stock, read-only — no row is created, so asking about a
        part does not silently record it as counted at zero."""
        part = self.part_repo.get_by_id(part_id)
        if not part:
            raise NotFoundError(f"Part {part_id} not found")
        return self._row_dict(part, self.repo.get_by_part(part_id))

    def list_stock(self, store_code, section_id=None):
        from flask import current_app
        ttl = current_app.config.get("SPARE_STOCK_CACHE_TTL", _STOCK_CACHE_TTL)
        key = (store_code, section_id)

        def _fresh():
            hit = _STOCK_CACHE.get(key)
            if hit is not None and hit[0] > time.time():
                # A fresh list each call so an in-place sort by a caller (reorder /
                # by-status) never reorders the cached copy.
                return list(hit[1])
            return None

        def _build():
            rows = [self._row_dict(part, stock)
                    for part, stock in self.repo.list_for_store(store_code, section_id)]
            if ttl and ttl > 0:
                _STOCK_CACHE[key] = (time.time() + ttl, rows)
            return list(rows)

        # Caching off (tests) — build straight through, no lock.
        if not (ttl and ttl > 0):
            return _build()

        cached = _fresh()
        if cached is not None:
            return cached
        # Single-flight: the winner builds once; the others wait on the lock and
        # then find the just-built cache instead of rebuilding all ~4,800 rows.
        with _stock_build_lock(key):
            cached = _fresh()
            return cached if cached is not None else _build()

    def get_summary(self, store_code, section_id=None):
        """The figures the store dashboard asks for. Counted separately from
        "not counted": a part nobody has counted is not a part with none, and
        reporting it as zero would invent a shortage.

        section_id narrows it to one section, because the section screen shows
        the same dashboard and must not quote the whole store's stock."""
        rows = self.list_stock(store_code, section_id)
        counted = [r for r in rows if r["qty_on_hand"] is not None]
        valued = [r for r in counted if r["stock_value"] is not None]
        return {
            "total_parts": len(rows),
            "counted_parts": len(counted),
            "uncounted_parts": len(rows) - len(counted),
            "total_qty": round(sum(r["qty_on_hand"] for r in counted), 2),
            "stock_value": round(sum(r["stock_value"] for r in valued), 2),
            "valued_parts": len(valued),
            "out_of_stock": sum(1 for r in counted if r["status"] == "Out of Stock"),
            "below_minimum": sum(1 for r in counted if r["status"] == "Below Minimum"),
            "reorder": sum(1 for r in counted if r["status"] == "Reorder"),
            "above_maximum": sum(1 for r in counted if r["status"] == "Above Maximum"),
            "healthy": sum(1 for r in counted if r["status"] == "Healthy"),
            # Everything that needs a purchase order raised — the single "to order" figure.
            "needs_reordering": sum(1 for r in counted
                                    if r["status"] in ("Out of Stock", "Below Minimum", "Reorder")),
        }

    def list_below_minimum(self, store_code, limit=None, section_id=None):
        # The reorder feed: empty and below minimum are critical, and a part at or
        # below its reorder level is due for a PO even while still above minimum.
        order = {"Out of Stock": 0, "Below Minimum": 1, "Reorder": 2}
        rows = [r for r in self.list_stock(store_code, section_id)
                if r["status"] in order]
        # Worst first: out of stock, then below minimum, then reorder; within each
        # by how far short of the level that flags it.
        def gap(r):
            level = r["min_stock_level"] if r["status"] != "Reorder" else (r["reorder_level"] or 0)
            return -(level - r["qty_on_hand"])
        rows.sort(key=lambda r: (order[r["status"]], gap(r)))
        return rows[:limit] if limit else rows

    def reorder_list(self, store_code):
        """What to reorder: every part at/below its minimum, with the quantity
        that brings it back up to its maximum and the spend that takes. A
        purchasing view — the shortfall already is the reorder quantity."""
        rows = self.list_below_minimum(store_code)
        items = []
        total_value = 0.0
        for r in rows:
            reorder_qty = r["shortfall"]
            if reorder_qty is None:
                # No maximum set — fall back to the gap up to the minimum, so a
                # zero-stock critical part still shows something to order.
                gap = (r["min_stock_level"] or 0) - (r["qty_on_hand"] or 0)
                reorder_qty = round(gap, 2) if gap > 0 else None
            rate = r["unit_price"]
            value = round(reorder_qty * rate, 2) if (reorder_qty and rate) else None
            if value:
                total_value += value
            items.append({**r, "reorder_qty": reorder_qty, "reorder_value": value})
        return {
            "items": items,
            "count": len(items),
            "total_reorder_value": round(total_value, 2),
        }

    def list_by_status(self, store_code, status, limit=None, section_id=None):
        """One status at a time, for the dashboard's Action Required entries.
        Sorted so the worst case in each list is the first row read."""
        rows = [r for r in self.list_stock(store_code, section_id) if r["status"] == status]
        if status == "Above Maximum":
            # Furthest over first — that is where the money is tied up.
            rows.sort(key=lambda r: -(r["qty_on_hand"] - (r["max_stock_level"] or 0)))
        elif status == "Below Minimum":
            rows.sort(key=lambda r: -(r["min_stock_level"] - r["qty_on_hand"]))
        else:
            # Out of Stock and Not Counted have no depth to rank by, so the
            # dearest part is the one worth seeing first.
            rows.sort(key=lambda r: -(r["unit_price"] or 0))
        return rows[:limit] if limit else rows

    def list_excess(self, store_code, limit=None, section_id=None):
        """Above maximum, with how far over. `excess_since` is carried straight
        off the part rather than derived — nothing back-dates it yet, so it
        stays None instead of being guessed from the ledger."""
        rows = self.list_by_status(store_code, "Above Maximum", limit, section_id)
        for r in rows:
            r["excess_qty"] = round(r["qty_on_hand"] - (r["max_stock_level"] or 0), 2)
        return rows

    def movements_between(self, store_code, since, until=None, section_id=None):
        """What moved in a window, split by direction. RECEIPT and ISSUE are
        the two the floor is asked about; OPENING and ADJUSTMENT are counted
        separately so a stock-take is never reported as a day's receipts."""
        entries = self.ledger_repo.list_for_store_between(store_code, since, until)
        if section_id:
            entries = [e for e in entries if e.part and e.part.section_id == section_id]
        out = {
            "received_qty": 0.0, "received_lines": 0,
            "issued_qty": 0.0, "issued_lines": 0,
            "adjusted_lines": 0, "opening_lines": 0,
        }
        for e in entries:
            delta = float(e.qty_delta)
            if e.txn_type == "RECEIPT":
                out["received_qty"] += delta
                out["received_lines"] += 1
            elif e.txn_type == "ISSUE":
                out["issued_qty"] += abs(delta)
                out["issued_lines"] += 1
            elif e.txn_type == "ADJUSTMENT":
                out["adjusted_lines"] += 1
            elif e.txn_type == "OPENING":
                out["opening_lines"] += 1
        out["received_qty"] = round(out["received_qty"], 2)
        out["issued_qty"] = round(out["issued_qty"], 2)
        return out

    def _today_shift_start(self):
        """The shift-start boundary today's figures are measured from — returned
        both as the UTC instant to compare created_at against and the plant-clock
        ISO to report. The plant's day runs 08:30 to about 03:20 the next
        morning, so a midnight cut would split one night shift across two days.
        created_at is stored in UTC, so the local boundary is converted before it
        is compared — reading one against the other is what once put every
        vehicle window 5.5 hours out. The offset is measured, not hardcoded, so
        this holds wherever the server clock is set."""
        now_local = datetime.now()
        offset = now_local - datetime.utcnow()
        start_local = now_local.replace(hour=SHIFT_START.hour, minute=SHIFT_START.minute,
                                        second=0, microsecond=0)
        if now_local < start_local:
            start_local -= timedelta(days=1)
        return start_local - offset, start_local.isoformat()

    def today_movements(self, store_code, section_id=None):
        """Movement totals since the shift started (see _today_shift_start)."""
        since_utc, since_local_iso = self._today_shift_start()
        summary = self.movements_between(store_code, since_utc, section_id=section_id)
        # Reported as the plant clock, which is the shift anyone is thinking of.
        summary["since"] = since_local_iso
        return summary

    @staticmethod
    def _pct(part, whole):
        """None, not zero, when there is nothing to divide by. A gauge reading
        0% claims it measured something and found none; a gauge with no
        denominator has measured nothing at all, and the two must not look
        alike on a screen."""
        if not whole:
            return None
        return round(part / whole * 100, 1)

    def analytics(self, store_code, section_id=None):
        """Every percentage the dashboard's gauges show, worked out here rather
        than in the browser — one definition per metric, and the same figure
        whoever asks."""
        rows = self.list_stock(store_code, section_id)
        counted = [r for r in rows if r["qty_on_hand"] is not None]
        by = lambda s: sum(1 for r in counted if r["status"] == s)  # noqa: E731

        healthy, below, above = by("Healthy"), by("Below Minimum"), by("Above Maximum")
        zero = by("Out of Stock")
        reorder = by("Reorder")
        # Anything needing a PO raised is "critical" for the gauge — empty, below
        # minimum, or down to its reorder point.
        critical = below + zero + reorder

        # Utilisation is on-hand against the planned maximum — how full the
        # store is against what it decided to hold, which is the only capacity
        # figure a spares store has. Only parts that are both counted and
        # planned can take part, or the ratio compares against a missing limit.
        planned_counted = [r for r in counted if r["max_stock_level"]]
        on_hand = sum(r["qty_on_hand"] for r in planned_counted)
        capacity = sum(r["max_stock_level"] for r in planned_counted)

        with_min = sum(1 for r in rows if r["min_stock_level"])
        with_max = sum(1 for r in rows if r["max_stock_level"])
        with_both = sum(1 for r in rows if r["min_stock_level"] and r["max_stock_level"])

        valued = [r for r in counted if r["stock_value"] is not None]
        value_bands = {"Normal Stock": 0.0, "Critical Stock": 0.0, "Excess Stock": 0.0}
        for r in valued:
            if r["status"] in ("Out of Stock", "Below Minimum", "Reorder"):
                value_bands["Critical Stock"] += r["stock_value"]
            elif r["status"] == "Above Maximum":
                value_bands["Excess Stock"] += r["stock_value"]
            else:
                value_bands["Normal Stock"] += r["stock_value"]

        return {
            "counted_parts": len(counted),
            "total_parts": len(rows),
            "gauges": {
                "stock_utilisation": {
                    "pct": self._pct(on_hand, capacity),
                    "caption": f"{round(on_hand)} on hand · max limit {round(capacity)}",
                    "basis": len(planned_counted),
                },
                "inventory_health": {
                    "pct": self._pct(healthy, len(counted)),
                    "caption": f"{healthy} of {len(counted)} counted parts healthy",
                    "basis": len(counted),
                },
                "min_max_coverage": {
                    "pct": self._pct(with_both, len(rows)),
                    "caption": f"{with_both} of {len(rows)} have both limits",
                    "basis": len(rows),
                },
                "planning_coverage": {
                    "pct": self._pct(with_max, len(rows)),
                    "caption": f"{with_max} of {len(rows)} have a maximum",
                    "basis": len(rows),
                },
                "critical_parts": {
                    "pct": self._pct(critical, len(counted)),
                    "caption": f"{critical} critical of {len(counted)} counted",
                    "basis": len(counted),
                },
                "excess_stock": {
                    "pct": self._pct(above, len(counted)),
                    "caption": f"{above} above maximum of {len(counted)} counted",
                    "basis": len(counted),
                },
            },
            "status_distribution": [
                {"name": "Healthy", "value": healthy},
                {"name": "Below Minimum", "value": below},
                {"name": "Reorder", "value": reorder},
                {"name": "Above Maximum", "value": above},
                {"name": "Zero Stock", "value": zero},
            ],
            "value_distribution": [
                {"name": k, "value": round(v, 2)} for k, v in value_bands.items()
            ],
            "total_value": round(sum(value_bands.values()), 2),
            "short_vs_excess": [
                {"name": "Below Minimum", "value": below},
                {"name": "Healthy", "value": healthy},
                {"name": "Above Maximum", "value": above},
            ],
            "top_value": [{
                "part_id": r["part_id"], "part_no": r["part_no"], "part_name": r["part_name"],
                "qty_on_hand": r["qty_on_hand"], "unit_price": r["unit_price"],
                "stock_value": r["stock_value"], "status": r["status"],
            } for r in sorted(valued, key=lambda r: -r["stock_value"])[:10]],
            "monthly_consumption": self.monthly_consumption(store_code, section_id=section_id),
        }

    def monthly_consumption(self, store_code, months=12, section_id=None):
        """Issued quantity per month (YYYY-MM), off the ledger. A SQL GROUP BY
        — the ~12 monthly totals — rather than hydrating up to 5,000 ORM rows and
        grouping in Python, which is what made `analytics` the heaviest call.
        Real usage: an empty list means nothing has been issued."""
        from app.extensions import db
        from sqlalchemy import func
        from app.models.spare_stock import SpareStockLedger
        key = func.strftime("%Y-%m", SpareStockLedger.created_at)
        rows = (
            db.session.query(key, func.sum(func.abs(SpareStockLedger.qty_delta)))
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code, SpareStockLedger.txn_type == "ISSUE",
                    *((Part.section_id == section_id,) if section_id else ()))
            .group_by(key).order_by(key)
            .all()
        )
        return [{"name": k, "value": round(float(v or 0), 2)} for k, v in rows if k][-months:]

    def consumption_comparison(self, store_code, section_id=None):
        """This calendar month's issued quantity against the previous month and
        the same month a year ago — derived from monthly_consumption mapped by
        YYYY-MM. A month with no issues is 0; the % change is None when its
        baseline is 0 (no honest percentage off nothing)."""
        from datetime import date, timedelta
        series = {r["name"]: r["value"] for r in self.monthly_consumption(store_code, months=15, section_id=section_id)}
        today = date.today()
        cur_key = today.strftime("%Y-%m")
        prev_key = (today.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
        yoy_key = f"{today.year - 1}-{today.month:02d}"
        cur = float(series.get(cur_key, 0))
        prev = float(series.get(prev_key, 0))
        yoy = float(series.get(yoy_key, 0))

        def pct(now, base):
            return round((now - base) / base * 100, 1) if base > 0 else None

        return {
            "current": {"key": cur_key, "value": cur},
            "previous": {"key": prev_key, "value": prev, "change_pct": pct(cur, prev)},
            "year_ago": {"key": yoy_key, "value": yoy, "change_pct": pct(cur, yoy)},
        }

    @staticmethod
    def latest_gate_suppliers():
        """{ITEM_CODE_UPPER: (ven_cd, name, last_gate_date)} — each part's most
        recent gate-entry vendor, in ONE pass over the gate entries (newest
        first, first wins). NULL dates sort last in DESC on SQLite, so dated
        entries win. A gate row with no vendor on it is skipped, so an older row
        that names one still counts. The supplier of a spare is derived from the
        gate, never stored on the part (one part = many suppliers over time)."""
        from app.extensions import db
        from app.models.gate_entry import GateEntry

        latest = {}
        q = (db.session.query(GateEntry.item_code, GateEntry.ven_cd, GateEntry.ven_name,
                              GateEntry.gate_entry_dt)
             .filter(GateEntry.item_code.isnot(None))
             .order_by(GateEntry.gate_entry_dt.desc(), GateEntry.id.desc()))
        for code, ven_cd, ven_name, dt in q:
            k = (code or "").strip().upper()
            ven_cd = (ven_cd or "").strip() or None
            name = (ven_name or "").strip() or ven_cd
            if k and name and k not in latest:
                latest[k] = (ven_cd, name, dt)
        return latest

    def part_facts(self, store_code):
        """Per-part facts the inventory table shows beside the on-hand figure,
        from set queries (never one per row): the last ISSUE and the quantity
        issued in the last 90 days (ledger), and the latest gate-entry supplier.
        Only parts with at least one fact are returned — an absent part means
        "no issue recorded, never seen at the gate", not zero."""
        from datetime import timedelta
        from sqlalchemy import case, func
        from app.extensions import db
        from app.models.spare_stock import SpareStockLedger

        since = utcnow() - timedelta(days=90)
        facts = {}
        issues = (
            db.session.query(
                SpareStockLedger.part_id,
                func.max(SpareStockLedger.created_at),
                func.sum(case((SpareStockLedger.created_at >= since, -SpareStockLedger.qty_delta), else_=0)),
            )
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code, SpareStockLedger.txn_type == "ISSUE")
            .group_by(SpareStockLedger.part_id)
        )
        for pid, last_at, qty90 in issues:
            facts[pid] = {
                "last_issue_at": last_at.isoformat() if last_at else None,
                "issued_90d": round(float(qty90 or 0), 2),
            }
        suppliers = self.latest_gate_suppliers()
        if suppliers:
            parts = (db.session.query(Part.id, Part.part_no)
                     .filter(Part.store_code == store_code, Part.is_active.is_(True)))
            for pid, pno in parts:
                hit = suppliers.get((pno or "").strip().upper())
                if hit:
                    f = facts.setdefault(pid, {})
                    f["supplier_code"], f["supplier"] = hit[0], hit[1]
                    f["last_arrival"] = hit[2].isoformat() if hit[2] else None
        return {str(k): v for k, v in facts.items()}

    def stock_value_by_last_supplier(self, store_code, section_id=None, top=10):
        """On-hand stock value attributed to each part's MOST RECENT gate-entry
        supplier.

        A spare part arrives from several vendors over time (supplier is derived
        live from ERP gate entries, never stored on the part), so this is an
        honest approximation — "who last supplied what we are holding now" — not
        an exact per-supplier stock ledger; the response says so in `basis`.

        Parts never seen at the gate (opening stock that predates the ERP feed)
        are NOT ranked as if they were a supplier — they would swamp the chart —
        but reported apart as `unattributed`, so total = attributed +
        unattributed and nothing is silently dropped. Each ranked supplier and
        the unattributed bucket carry `part_ids`, so the screen can drill into
        exactly the parts behind a bar without a second request."""
        from app.extensions import db
        from app.models.gate_entry import GateEntry

        top = max(1, min(int(top or 10), 50))

        latest = {k: (v[0], v[1]) for k, v in self.latest_gate_suppliers().items()}

        agg = {}
        none = {"value": 0.0, "parts": 0, "part_ids": []}
        for r in self.list_stock(store_code, section_id):
            val = r.get("stock_value")
            if not val:
                continue
            hit = latest.get((r.get("part_no") or "").strip().upper())
            if hit is None:
                none["value"] += float(val)
                none["parts"] += 1
                none["part_ids"].append(r["part_id"])
                continue
            ven_cd, name = hit
            a = agg.setdefault(ven_cd or name, {"ven_cd": ven_cd, "name": name,
                                                "value": 0.0, "parts": 0, "part_ids": []})
            a["value"] += float(val)
            a["parts"] += 1
            a["part_ids"].append(r["part_id"])

        ranked = sorted(agg.values(), key=lambda a: a["value"], reverse=True)
        for a in ranked:
            a["value"] = round(a["value"], 2)
        rest = ranked[top:]
        attributed = round(sum(a["value"] for a in ranked), 2)
        none["value"] = round(none["value"], 2)
        return {
            "basis": "last gate-entry supplier",
            "total": round(attributed + none["value"], 2),
            "attributed": attributed,
            "supplier_count": len(ranked),
            "suppliers": ranked[:top],
            "others": {"count": len(rest),
                       "value": round(sum(a["value"] for a in rest), 2),
                       "parts": sum(a["parts"] for a in rest)},
            "unattributed": none,
        }

    def _consumption_window(self, days=None, date_from=None, date_to=None):
        """Filter clauses scoping the ledger to a window on `created_at`. An
        explicit calendar range (`date_from`/`date_to`, ISO 'YYYY-MM-DD' from the
        Consumption screen's date picker) wins; otherwise a rolling last-`days`
        window (the Day/Week/Month/Year presets); otherwise () for all-time.
        days=None with no range keeps the whole-ledger default, so every existing
        caller is unaffected."""
        from sqlalchemy import func
        from app.models.spare_stock import SpareStockLedger
        col = func.date(SpareStockLedger.created_at)
        if date_from or date_to:
            clauses = []
            if date_from:
                clauses.append(col >= date_from)
            if date_to:
                clauses.append(col <= date_to)
            return tuple(clauses)
        if days and days > 0:
            from datetime import date, timedelta
            start = date.today() - timedelta(days=days - 1)
            return (col >= start.isoformat(),)
        return ()

    def consumption_by_department(self, store_code, section_id=None, days=None, date_from=None, date_to=None):
        """Total issued quantity per department — the split behind Department-wise
        Consumption. Only ISSUE rows carry a department, so opening/receipt/
        adjustment rows never appear here. `days` scopes to a rolling window
        (None = all-time)."""
        from app.extensions import db
        from sqlalchemy import func
        from app.models.spare_stock import SpareStockLedger
        rows = (
            db.session.query(
                SpareStockLedger.department,
                func.sum(func.abs(SpareStockLedger.qty_delta)),
            )
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code, SpareStockLedger.txn_type == "ISSUE",
                    *((Part.section_id == section_id,) if section_id else ()),
                    *self._consumption_window(days, date_from, date_to))
            .group_by(SpareStockLedger.department)
            .all()
        )
        return [{"name": dept or "Unspecified", "value": round(float(total or 0), 2)}
                for dept, total in rows if total]

    def consumption_by_machine(self, store_code, section_id=None, days=None, date_from=None, date_to=None):
        """Total issued quantity per machine — the split behind Machine-wise
        Consumption (which machine eats the most spares). Only ISSUE rows carry
        a machine. `days` scopes to a rolling window (None = all-time)."""
        from app.extensions import db
        from sqlalchemy import func
        from app.models.spare_stock import SpareStockLedger
        rows = (
            db.session.query(
                SpareStockLedger.machine,
                func.sum(func.abs(SpareStockLedger.qty_delta)),
            )
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code, SpareStockLedger.txn_type == "ISSUE",
                    *((Part.section_id == section_id,) if section_id else ()),
                    *self._consumption_window(days, date_from, date_to))
            .group_by(SpareStockLedger.machine)
            .all()
        )
        out = [{"name": mc or "Unspecified", "value": round(float(total or 0), 2)}
               for mc, total in rows if total]
        out.sort(key=lambda r: r["value"], reverse=True)
        return out

    def consumption_by_type(self, store_code, section_id=None, days=None, date_from=None, date_to=None):
        """Total issued quantity per component type (Part.sub_category) — the
        split behind Part-type-wise Consumption. Parts with no type group under
        'Uncategorised'. `days` scopes to a rolling window (None = all-time)."""
        from app.extensions import db
        from sqlalchemy import func
        from app.models.spare_stock import SpareStockLedger
        rows = (
            db.session.query(Part.sub_category, func.sum(func.abs(SpareStockLedger.qty_delta)))
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code, SpareStockLedger.txn_type == "ISSUE",
                    *((Part.section_id == section_id,) if section_id else ()),
                    *self._consumption_window(days, date_from, date_to))
            .group_by(Part.sub_category)
            .all()
        )
        out = [{"name": t or "Uncategorised", "value": round(float(total or 0), 2)}
               for t, total in rows if total]
        out.sort(key=lambda r: r["value"], reverse=True)
        return out

    def consumption_by_period(self, store_code, period="month", section_id=None):
        """Total issued quantity per month (YYYY-MM) or per year (YYYY) over the
        whole ledger — the month-wise / year-wise consumption report. SQLite
        strftime; the app is SQLite (see _patch_schema)."""
        from app.extensions import db
        from sqlalchemy import func
        from app.models.spare_stock import SpareStockLedger
        fmt = "%Y" if period == "year" else "%Y-%m"
        key = func.strftime(fmt, SpareStockLedger.created_at)
        rows = (
            db.session.query(key, func.sum(func.abs(SpareStockLedger.qty_delta)))
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code, SpareStockLedger.txn_type == "ISSUE",
                    *((Part.section_id == section_id,) if section_id else ()))
            .group_by(key).order_by(key)
            .all()
        )
        return [{"period": p, "qty": round(float(q or 0), 2)} for p, q in rows if p]

    def consumption_report_excel(self, store_code, days=None, section_id=None, date_from=None, date_to=None):
        """Downloadable consumption report. The first three sheets — By
        Department, By Machine, By Part Type — reflect the range picked on the
        screen (a calendar range, a rolling `days` window, or all-time), so the
        download always matches the bars the user is looking at. Month-wise and
        Year-wise stay whole-ledger so the long view rides along in every
        report."""
        from io import BytesIO
        from openpyxl import Workbook
        wb = Workbook()
        breakdowns = [
            ("By Department", "Department", self.consumption_by_department(store_code, section_id, days, date_from, date_to)),
            ("By Machine", "Machine", self.consumption_by_machine(store_code, section_id, days, date_from, date_to)),
            ("By Part Type", "Part Type", self.consumption_by_type(store_code, section_id, days, date_from, date_to)),
        ]
        for i, (title, head, data) in enumerate(breakdowns):
            ws = wb.active if i == 0 else wb.create_sheet(title)
            ws.title = title
            ws.append([head, "Issued Qty"])
            for r in data:
                ws.append([r["name"], r["value"]])
        wsm = wb.create_sheet("Month-wise")
        wsm.append(["Month", "Issued Qty"])
        for r in self.consumption_by_period(store_code, "month", section_id):
            wsm.append([r["period"], r["qty"]])
        wsy = wb.create_sheet("Year-wise")
        wsy.append(["Year", "Issued Qty"])
        for r in self.consumption_by_period(store_code, "year", section_id):
            wsy.append([r["period"], r["qty"]])
        buf = BytesIO()
        wb.save(buf)
        buf.seek(0)
        return buf

    def consumption_trend(self, store_code, days=7, section_id=None, date_from=None, date_to=None):
        """Issued quantity per day — the consumption trend line. A calendar range
        (`date_from`/`date_to`, ISO) wins; otherwise the last `days` days. Days
        with no issue come back as 0 so the line has a point for every day rather
        than a gap. The daily span is capped so a very wide range can't return
        thousands of points."""
        from datetime import date, timedelta
        from app.extensions import db
        from sqlalchemy import func
        from app.models.spare_stock import SpareStockLedger
        if date_from or date_to:
            end = date.fromisoformat(date_to) if date_to else date.today()
            start = date.fromisoformat(date_from) if date_from else end - timedelta(days=6)
            if start > end:
                start, end = end, start
        else:
            end = date.today()
            start = end - timedelta(days=days - 1)
        span = min((end - start).days + 1, 366)   # guard against a pathological range
        start = end - timedelta(days=span - 1)
        rows = (
            db.session.query(
                func.date(SpareStockLedger.created_at),
                func.sum(func.abs(SpareStockLedger.qty_delta)),
            )
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code,
                    SpareStockLedger.txn_type == "ISSUE",
                    func.date(SpareStockLedger.created_at) >= start.isoformat(),
                    func.date(SpareStockLedger.created_at) <= end.isoformat(),
                    *((Part.section_id == section_id,) if section_id else ()))
            .group_by(func.date(SpareStockLedger.created_at))
            .all()
        )
        by_day = {str(d): float(q or 0) for d, q in rows}
        out = []
        for i in range(span):
            d = start + timedelta(days=i)
            out.append({"d": d.strftime("%d %b"), "qty": round(by_day.get(d.isoformat(), 0.0), 2)})
        return out

    def top_consumed(self, store_code, limit=5, days=30, date_from=None, date_to=None):
        """The most-issued parts in the window — the consumed-parts list. A
        calendar range (`date_from`/`date_to`) wins; otherwise the last `days`
        days. Ranked by total issued quantity."""
        from app.extensions import db
        from sqlalchemy import func
        from app.models.spare_stock import SpareStockLedger
        total = func.sum(func.abs(SpareStockLedger.qty_delta))
        rows = (
            db.session.query(Part.part_no, Part.part_name, total)
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code,
                    SpareStockLedger.txn_type == "ISSUE",
                    *self._consumption_window(days, date_from, date_to))
            .group_by(Part.id)
            .order_by(total.desc())
            .limit(limit)
            .all()
        )
        return [{"part_no": pn, "part_name": name, "qty": round(float(q or 0), 2)}
                for pn, name, q in rows]

    def machines_used(self, store_code):
        """Distinct machine names already recorded for this store — the source
        for the issue form's type-ahead, so the same machine is always spelled
        the same way."""
        from app.extensions import db
        from app.models.spare_stock import SpareStockLedger
        rows = (
            db.session.query(SpareStockLedger.machine)
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code, SpareStockLedger.machine.isnot(None))
            .distinct()
            .all()
        )
        return sorted({m for (m,) in rows if m})

    def erp_completeness(self, store_code):
        """How much of this store's list ERP has ever reported a stock figure
        for. Reported separately because it measures the feed, not the store."""
        from app.models.erp_stock import ERPStock
        from app.extensions import db
        from sqlalchemy import func
        total = len(self.part_repo.get_active(store_code))
        synced = (
            db.session.query(func.count(func.distinct(ERPStock.part_id)))
            .join(Part, Part.id == ERPStock.part_id)
            .filter(Part.store_code == store_code)
            .scalar() or 0
        )
        return {"pct": self._pct(synced, total), "synced": synced, "total": total}

    # ---- ERP vs Physical gap (spare store) ----
    #
    # The same reconciliation the Child Parts store gets, but scoped to one
    # store and — deliberately — reading physical straight from the in-app count
    # (SpareStock.qty_on_hand), not the separate physical-snapshot upload the
    # Child Parts gap uses. ERP is the feed (erp_stock); physical is whatever
    # the store has counted, so there is nothing to key in twice. A part with an
    # ERP figure but no count reads NO_PHYSICAL; one counted but never pushed by
    # ERP reads NOT_SYNCED. Status rule is shared with ERPGapService so the two
    # stores can never disagree on what SHORT/EXCESS means.

    def erp_gap(self, store_code, keyword=None, category=None, status=None):
        erp_map = {r.part_id: (float(r.qty_on_hand), r.synced_at)
                   for r in self.erp_repo.list_all()}
        rows = []
        for part, spare in self.repo.list_for_store(store_code):
            erp = erp_map.get(part.id)
            erp_qty = erp[0] if erp else None
            physical_qty = float(spare.qty_on_hand) if spare is not None else None
            if erp_qty is None and physical_qty is None:
                continue
            gap_qty = (physical_qty - erp_qty) if (erp_qty is not None and physical_qty is not None) else None
            rows.append({
                "part_id": part.id, "part_no": part.part_no, "part_name": part.part_name,
                "category": part.category, "location": part.location,
                "erp_qty": erp_qty, "physical_qty": physical_qty, "gap_qty": gap_qty,
                "status": ERPGapService._status(erp_qty, physical_qty),
                "erp_synced_at": erp[1].isoformat() if erp else None,
                "last_counted_at": spare.last_counted_at.isoformat() if (spare and spare.last_counted_at) else None,
            })
        if keyword:
            kw = keyword.lower()
            rows = [r for r in rows if kw in r["part_no"].lower() or kw in (r["part_name"] or "").lower()]
        if category:
            rows = [r for r in rows if r["category"] == category]
        if status:
            rows = [r for r in rows if r["status"] == status]
        rows.sort(key=lambda r: abs(r["gap_qty"]) if r["gap_qty"] is not None else -1, reverse=True)
        return rows

    def erp_gap_summary(self, store_code):
        rows = self.erp_gap(store_code)
        reconciled = [r for r in rows if r["gap_qty"] is not None]
        matched = sum(1 for r in reconciled if r["status"] == "MATCH")
        return {
            "total": len(rows),
            "matched": matched,
            "short": sum(1 for r in rows if r["status"] == "SHORT"),
            "excess": sum(1 for r in rows if r["status"] == "EXCESS"),
            "no_physical": sum(1 for r in rows if r["status"] == "NO_PHYSICAL"),
            "not_synced": sum(1 for r in rows if r["status"] == "NOT_SYNCED"),
            "accuracy_pct": round(matched / len(reconciled) * 100, 2) if reconciled else None,
        }

    # ---- ERP outbound sync (mock-now / real-later) ----

    @staticmethod
    def _erp_pending_filter():
        """Filter clauses for the movements still waiting to push to ERP — one
        definition shared by the count, the drill list and the sync, so the
        three always agree. A RECEIPT whose status is in
        ERP_ORIGIN_RECEIPT_STATUSES (a quality clearance or an RGP GRN) is left
        out: its stock-in already happened in ERP through the supervisor's GRN,
        and pushing it would add it a second time. Legacy RECEIPT rows (other
        or no status) still count."""
        from sqlalchemy import or_
        from app.models.spare_stock import SpareStockLedger
        return (
            SpareStockLedger.txn_type.in_(ERP_PUSH_TYPES),
            SpareStockLedger.erp_pushed_at.is_(None),
            # NULL-safe: `status NOT IN (...)` alone would drop NULL-status rows.
            or_(SpareStockLedger.txn_type != "RECEIPT",
                SpareStockLedger.status.is_(None),
                SpareStockLedger.status.notin_(ERP_ORIGIN_RECEIPT_STATUSES)),
        )

    def pending_erp_count(self, store_code):
        """How many stock movements are waiting to be pushed to ERP."""
        from app.extensions import db
        from sqlalchemy import func
        from app.models.spare_stock import SpareStockLedger
        return (
            db.session.query(func.count(SpareStockLedger.id))
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code, *self._erp_pending_filter())
            .scalar() or 0
        )

    @staticmethod
    def erp_write_status():
        """Truthful state of the ERP stock-write path — so the UI can say WHY
        movements are (or aren't) syncing without ever faking 'ERP updated'.
        Writing needs BOTH the enable flag and an endpoint URL."""
        from flask import current_app
        write_enabled = bool(current_app.config.get("ERP_STOCK_WRITE_ENABLED"))
        api_configured = bool(current_app.config.get("ERP_API_BASE_URL"))
        active = write_enabled and api_configured
        if active:
            reason = "ERP stock write is enabled"
        elif not write_enabled:
            reason = "ERP stock write is disabled (approval pending) — movements stay in the app only"
        else:
            reason = "ERP stock API endpoint is not configured yet"
        return {"write_enabled": write_enabled, "api_configured": api_configured,
                "active": active, "reason": reason}

    def sync_pending_to_erp(self, store_code):
        """Push every not-yet-pushed movement (ISSUE/RECEIPT/RETURN) to ERP,
        oldest first, stamping erp_pushed_at on each success. Writing needs BOTH
        ERP_STOCK_WRITE_ENABLED and ERP_API_BASE_URL; until then nothing is
        pushed and the movements stay pending — run this again once ERP is
        approved + configured and it clears the backlog. Receipts that came in
        through an ERP GRN are never pushed (see _erp_pending_filter)."""
        from app.extensions import db
        from app.models.base import utcnow
        from app.models.spare_stock import SpareStockLedger
        from app.services.erp_client import ERPClient, ERPNotConfigured
        client = ERPClient()
        rows = (
            db.session.query(SpareStockLedger)
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code, *self._erp_pending_filter())
            .order_by(SpareStockLedger.id.asc())
            .all()
        )
        pushed = 0
        failed = 0
        now = utcnow()
        for r in rows:
            try:
                client.push_stock_movement(
                    r.part.part_no if r.part else None, float(r.qty_delta), r.txn_type, r.reference)
                r.erp_pushed_at = now
                pushed += 1
            except ERPNotConfigured:
                db.session.rollback()
                status = self.erp_write_status()
                return {"configured": False, "write_enabled": status["write_enabled"],
                        "api_configured": status["api_configured"], "reason": status["reason"],
                        "pushed": 0, "pending": len(rows)}
            except Exception:
                failed += 1
        db.session.commit()
        return {"configured": True, "write_enabled": True, "pushed": pushed,
                "failed": failed, "pending": len(rows) - pushed}

    @staticmethod
    def _activity_row(e):
        """One ledger movement as the dashboard/feed reads it — the shape the
        Live Dashboard's transaction drill (Today's Issue / Pending ERP) and the
        activity feed both render, so all three stay identical."""
        return {
            "id": e.id,
            "at": e.created_at.isoformat() if e.created_at else None,
            "part_id": e.part_id,
            "part_no": e.part.part_no if e.part else None,
            "part_name": e.part.part_name if e.part else None,
            "uom": e.part.uom if e.part else None,
            "section_id": e.part.section_id if e.part else None,
            "txn_type": e.txn_type,
            "qty_delta": float(e.qty_delta),
            "balance_after": float(e.balance_after),
            "reference": e.reference,
            "remarks": e.remarks,
            "department": e.department,
            "machine": e.machine,
            "created_by": e.created_by,
        }

    def recent_activity(self, store_code, limit=20):
        """The store's own event feed, off the ledger. Every row is something
        that actually happened to stock — no synthesised "system" events."""
        return [self._activity_row(e)
                for e in self.ledger_repo.recent_for_store(store_code, limit)]

    def pending_erp_movements(self, store_code, limit=None):
        """The individual stock movements still waiting to push to ERP — the rows
        behind the 'Pending ERP' count, oldest first (the order they'd sync in).
        Same filter as pending_erp_count, so the list length equals that count."""
        from app.models.spare_stock import SpareStockLedger
        q = (
            db.session.query(SpareStockLedger)
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code, *self._erp_pending_filter())
            .order_by(SpareStockLedger.id.asc())
        )
        if limit:
            q = q.limit(limit)
        return [self._activity_row(e) for e in q.all()]

    def today_issues(self, store_code, section_id=None):
        """The ISSUE rows since the shift started — the rows behind 'Today's
        Issue'. Uses the SAME shift-start boundary as today_movements, so the
        list ties out to the card (row count == issued_lines, qty == issued_qty).
        Newest first."""
        since_utc, _ = self._today_shift_start()
        rows = [e for e in self.ledger_repo.list_for_store_between(store_code, since_utc)
                if e.txn_type == "ISSUE"
                and (not section_id or (e.part and e.part.section_id == section_id))]
        rows.sort(key=lambda e: e.id, reverse=True)
        return [self._activity_row(e) for e in rows]

    def history_for_part(self, part_id, limit=25, txn_type=None, department=None,
                         machine=None, since=None, until=None):
        """Complete chronological history for a part — now carrying the two-stage
        issue detail (department / issued-to with the taker's mobile and code /
        line / machine / status) and the
        receiving detail (supplier / invoice / check) that the old view dropped,
        with optional server-side filters."""
        from app.models.spare_stock import SpareStockLedger
        q = SpareStockLedger.query.filter(SpareStockLedger.part_id == part_id)
        if txn_type:
            q = q.filter(SpareStockLedger.txn_type == txn_type)
        if department:
            q = q.filter(SpareStockLedger.department == department)
        if machine:
            q = q.filter(SpareStockLedger.machine == machine)
        if since:
            q = q.filter(SpareStockLedger.created_at >= since)
        if until:
            q = q.filter(SpareStockLedger.created_at <= until)
        q = q.order_by(SpareStockLedger.created_at.desc(), SpareStockLedger.id.desc())
        if limit:
            q = q.limit(limit)
        return [{
            "id": e.id,
            "at": e.created_at.isoformat() if e.created_at else None,
            "qty_delta": float(e.qty_delta),
            "balance_after": float(e.balance_after),
            "txn_type": e.txn_type,
            "status": e.status,
            "reference": e.reference,
            "remarks": e.remarks,
            "department": e.department,
            "issued_to": e.issued_to,
            "issued_to_mobile": e.issued_to_mobile,
            "issued_to_code": e.issued_to_code,
            "machine": e.machine,
            "line_name": e.line_name,
            "line_no": e.line_no,
            "die_no": e.die_no,
            "actual_qty": float(e.actual_qty) if e.actual_qty is not None else None,
            "invoice_no": e.invoice_no,
            "invoice_date": e.invoice_date.isoformat() if e.invoice_date else None,
            "check_result": e.check_result,
            "supplier": e.supplier.supplier_name if e.supplier else None,
            "return_no": e.return_no,
            "return_reason": e.return_reason,
            "returned_by": e.returned_by,
            "created_by": e.created_by,
            "confirmed_by": e.confirmed_by,
            "confirmed_at": e.confirmed_at.isoformat() if e.confirmed_at else None,
        } for e in q.all()]

    # ---- Excel ----

    def build_template(self, store_code=None):
        """Pre-filled with the store's own parts, so opening stock is a matter
        of typing one column rather than retyping 481 part numbers."""
        parts = self.part_repo.get_active(store_code) if store_code else []
        qty_map = self.repo.map_by_part(store_code) if store_code else {}
        rows = [{
            "part_no": p.part_no, "part_name": p.part_name,
            "qty_on_hand": qty_map.get(p.id, ""),
        } for p in parts]
        if not rows:
            return build_template(TEMPLATE_COLUMNS)
        return build_export([(c, k) for c, k in
                             zip(TEMPLATE_COLUMNS, ("part_no", "part_name", "qty_on_hand"))], rows)

    def bulk_import(self, file_stream, store_code=None, user=None, sheet_name=None):
        """Upload opening stock. Blank quantity cells are skipped rather than
        read as zero — a half-filled sheet must not wipe the shelves it does
        not mention."""
        applied = {"updated": 0, "unchanged": 0}

        def row_processor(raw_row):
            part_no = to_text(raw_row.get("part_no"))
            if not part_no:
                raise ValueError("Part No is required")
            part = self.part_repo.get_by_part_no(part_no)
            if not part:
                raise ValueError(f"Unknown Part No: {part_no}")
            if store_code and part.store_code != store_code:
                raise ValueError(f"{part_no} does not belong to {store_code}")

            qty = to_number(raw_row.get("qty_on_hand"), None)
            if qty is None:
                return  # nothing stated for this row
            if qty < 0:
                raise ValueError(f"{part_no}: quantity cannot be negative")

            _, delta = self._write(
                part.id, round(float(qty), 2), "OPENING",
                remarks="Opening stock upload", user=user, counted=True,
            )
            applied["updated" if delta else "unchanged"] += 1

        with atomic():
            report = bulk_import(file_stream, FIELD_ALIASES, REQUIRED_FIELDS, row_processor, sheet_name)
        report.update(applied)
        return report

    def export_excel(self, store_code, section_id=None):
        return build_export(EXPORT_COLUMNS, self.list_stock(store_code, section_id))
