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

# The ERP side of ERP-vs-Physical is normally the ERP feed; until the ERP API is
# connected it can be loaded from an Excel (Part No + ERP Qty). These mirror the
# physical-import aliases for that sheet.
ERP_FIELD_ALIASES = {
    "part_no": {"partno", "partnumber", "itemcode", "itemno"},
    "erp_qty": {"erpqty", "erpstock", "erpquantity", "erponhand", "qty", "quantity", "stock"},
}
ERP_REQUIRED_FIELDS = ["part_no", "erp_qty"]
ERP_TEMPLATE_COLUMNS = ["Part No", "Part Name", "ERP Qty"]

# A short-lived cache for the whole-store stock list. One dashboard refresh fires
# list + summary + analytics, which each rebuild list_stock over every part; the
# combined "all sections" view makes that ~4,800 rows built three times. Caching
# the built rows for a minute means one build serves a whole burst of screens —
# moving between sections / the dashboard / Store Stock re-uses it instead of
# rebuilding ~4,800 rows each time. It is cleared on every stock write (see
# _write), so an issue / receipt / count still shows at once; the TTL only bounds
# staleness if a write path ever bypasses _write.
_STOCK_CACHE = {}
_STOCK_CACHE_TTL = 60.0


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


def is_store_department(name):
    """Is this department the store itself ("Store", "Spare Store")? The store
    hands parts out, so it is never the department an issue goes to ("issuance
    me store dikha rha h jabki store to issue karta h" — the store, 18 Oct 2026).
    It stays in the Department master for the store's own mails."""
    name = " ".join(str(name or "").split()).lower()
    return name == "store" or name.endswith(" store")


def _sec_tuple(section_id=None, section_ids=None):
    """Extra WHERE clause(s) to scope a ledger query to a section group
    (section_ids), a single section, or the whole store (neither). A group wins
    over a single section — the same precedence list_stock uses. Splat into
    .filter(): `.filter(..., *_sec_tuple(section_id, section_ids))`."""
    from app.models.part import Part
    if section_ids:
        return (Part.section_id.in_(list(section_ids)),)
    if section_id:
        return (Part.section_id == section_id,)
    return ()


def _part_in_scope(part, section_id=None, section_ids=None):
    """In-memory counterpart of _sec_tuple for filtering hydrated rows: True if
    the part is within the section group, the one section, or (neither) the
    whole store."""
    if section_ids:
        return bool(part) and part.section_id in section_ids
    if section_id:
        return bool(part) and part.section_id == section_id
    return True


# The consumption figures here — the dashboard's donuts, trend and Top
# Consumed, the TV board's departments and its month total, the consumption
# Excel — follow the Consumption screen's rules (consumption_analytics_service),
# so they add up to its table's Total for the same days: a cancelled issue was
# not consumed, and a day / month is a plant-clock one.

def _not_cancelled():
    """WHERE clause: the issue was not cancelled — a cancelled issue was not consumed."""
    from sqlalchemy import or_
    from app.models.spare_stock import SpareStockLedger
    return or_(SpareStockLedger.status.is_(None), SpareStockLedger.status != "CANCELLED")


# An ISSUE waiting for Confirm Installation (Stage 2) — the ONE rule behind the
# Waiting list, the Work Queue, the alerts bell, the dashboard tile, the
# management board and its attention pop-up. The store's complaint (16 Oct
# 2026, "Waiting list wali kami theek karo"): an issue nobody had confirmed yet
# that was PARTLY returned turned PARTIALLY_RETURNED and dropped off the Waiting
# list, although the rest was still out with the user and never confirmed. So
# PARTIALLY_RETURNED waits too — but only while never confirmed (a confirmed
# issue partly returned is fitted, not waiting) and while something of it is
# still out. CANCELLED / RETURNED / INSTALLED / PARTIALLY_USED are not listed,
# so they never wait.
AWAITING_CONFIRMATION_STATUSES = ("ISSUED_BY_STORE", "PENDING_USER_CONFIRMATION", "PARTIALLY_RETURNED")


def awaiting_confirmation_clause():
    """SQL WHERE for "this ledger row is an issue awaiting confirmation": an
    ISSUE, never confirmed (confirmed_at IS NULL), status in
    AWAITING_CONFIRMATION_STATUSES (so not cancelled), with quantity still out
    — issued - returned > 0, returned counted exactly as _returned_qty_map
    counts it (every return document against the issue, plus legacy direct
    RETURN rows that are not a GOOD inspection's own row). Correlated on
    SpareStockLedger, so use it in a query whose FROM has that table:
    `.filter(awaiting_confirmation_clause())`."""
    from sqlalchemy import and_, func, or_, select
    from sqlalchemy.orm import aliased
    from app.models.spare_flow import SpareReturn
    from app.models.spare_stock import SpareStockLedger as L
    back = aliased(L)
    returned_docs = (select(func.coalesce(func.sum(SpareReturn.qty), 0))
                     .where(SpareReturn.issue_id == L.id)
                     .correlate(L).scalar_subquery())
    returned_legacy = (select(func.coalesce(func.sum(func.abs(back.qty_delta)), 0))
                       .where(back.return_of_id == L.id, back.txn_type == "RETURN",
                              or_(back.status.is_(None), back.status != RETURN_ROW_INSPECTED))
                       .correlate(L).scalar_subquery())
    still_out = func.round(func.abs(L.qty_delta) - returned_docs - returned_legacy, 2) > 0
    return and_(L.txn_type == "ISSUE", L.confirmed_at.is_(None),
                L.status.in_(AWAITING_CONFIRMATION_STATUSES), still_out)


def _plant_clock():
    """(the plant clock's UTC offset, today on it). created_at is stored in UTC:
    cut on the UTC date, an issue made 00:00-05:30 counts on the day before."""
    from app.services.consumption_analytics_service import _local_offset, _utc_naive
    offset = _local_offset()
    return offset, (_utc_naive(utcnow()) + offset).date()


def _plant_key(fmt, column, offset):
    """SQL: strftime(fmt) of a stored UTC timestamp read on the plant clock — a
    plant day / month / year to GROUP BY (SQLite's minutes modifier)."""
    from sqlalchemy import func
    return func.strftime(fmt, column, f"{int(offset.total_seconds() // 60):+d} minutes")


TEMPLATE_COLUMNS = ["Part No", "Part Name", "Qty On Hand"]

# The stock template's stamp (store, 16 Oct 2026, "Chhote data fix"). Download
# Template is pre-filled with TODAY's stock, so an OLD copy uploaded again would
# silently put back figures that issues / receipts have moved since, and mark
# them counted. Each pre-filled template therefore carries the moment it was
# made, on a hidden sheet the importer never mistakes for data (no Part No /
# Qty header on it), and the upload refuses — row by row — a figure for a part
# that moved after that moment and no longer matches today's stock. A file with
# no stamp (an older template, the store's own sheet, a CSV) imports as before.
TEMPLATE_META_SHEET = "_meta"
TEMPLATE_STAMP_KEY = "template_made_at_utc"
# A movement written a moment before the template read the stock may commit
# just after it (its created_at is set at INSERT, before COMMIT): such a figure
# would be stale, yet older than the stamp. A few seconds' allowance treats it
# as "moved since" — the conservative side.
TEMPLATE_STAMP_ALLOWANCE = timedelta(seconds=5)


def _plant_text(ts):
    """A stored UTC moment as the plant reads it — "16 Oct 2026 14:05"."""
    from app.services.consumption_analytics_service import _local_offset, _utc_naive
    ts = _utc_naive(ts)
    return (ts + _local_offset()).strftime("%d %b %Y %H:%M") if ts else None


def _template_tag(made_at):
    """The reference an upload of ONE stamped template writes on its OPENING
    rows: "Stock template 16 Oct 2026 09:39:12" (when that template was made,
    plant time to the second — it also reads as the document in the part's
    history). Loading a physical count is upload, spot a typo, fix it in the
    same file, upload again: the second upload must not take the first one's
    own rows for "stock moved since this template was made" (review, 16 Oct
    2026). Only rows carrying THIS template's tag are passed over — an issue /
    receipt / return in between still counts, and so does the upload of any
    other template (a newer one's rows stop an older copy, the cautious side).
    Two templates made in the same second hold the same figures, so sharing a
    tag does them no harm."""
    from app.services.consumption_analytics_service import _local_offset, _utc_naive
    return f"Stock template {_utc_naive(made_at) + _local_offset():%d %b %Y %H:%M:%S}"


def _stamped_template(columns, rows, made_at):
    """build_export's workbook — the same formatted data sheet, first — plus
    the hidden TEMPLATE_META_SHEET holding `made_at` (UTC, ISO text so a
    re-save in Excel keeps it as written)."""
    import io
    from openpyxl import Workbook
    from app.utils.excel_io import _append_safe_row, format_table
    wb = Workbook()
    ws = wb.active
    ws.append([label for label, _ in columns])
    for row in rows:
        _append_safe_row(ws, [row.get(key, "") for _, key in columns])
    format_table(ws)
    meta = wb.create_sheet(TEMPLATE_META_SHEET)
    # Nothing on this sheet reads as a Part No / Qty header, so read_rows never
    # takes it for the data sheet (or calls the workbook ambiguous).
    meta.append([TEMPLATE_STAMP_KEY, made_at.isoformat()])
    meta.append(["made_at_plant_time", _plant_text(made_at)])
    meta.append(["note", "The app reads this sheet to spot an old copy of the template. Do not edit it."])
    meta.sheet_state = "hidden"
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


def _parse_stamp(value):
    """The stamp cell as a naive UTC datetime, or None when it is missing or
    unreadable (then the file imports as one with no stamp)."""
    from app.services.consumption_analytics_service import _utc_naive
    if isinstance(value, datetime):
        return _utc_naive(value)
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return _utc_naive(datetime.fromisoformat(text))
    except ValueError:
        return None


def _template_stamp(data):
    """When the uploaded stock template was made (naive UTC), read off its
    hidden TEMPLATE_META_SHEET; None for a file without one. Never raises: a
    file this cannot open is left to bulk_import, which reports it properly."""
    import io
    from app.utils.excel_io import sheets_from_upload
    rows = None
    try:
        if data.startswith(b"PK\x03\x04"):
            # Read-only: only the small stamp sheet is parsed, not the 4,800 rows.
            from openpyxl import load_workbook
            wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
            try:
                if TEMPLATE_META_SHEET in wb.sheetnames:
                    rows = list(wb[TEMPLATE_META_SHEET].iter_rows(max_row=10, values_only=True))
            finally:
                wb.close()
        elif data.startswith(b"\xd0\xcf\x11\xe0"):
            # The template re-saved as an old .xls keeps its hidden sheet.
            for name, make_rows in sheets_from_upload(io.BytesIO(data)):
                if name == TEMPLATE_META_SHEET:
                    rows = [r for _, r in zip(range(10), make_rows())]
                    break
    except Exception:  # noqa: BLE001 - an unreadable file is bulk_import's to report
        return None
    for row in rows or ():
        if row and len(row) >= 2 and str(row[0] or "").strip() == TEMPLATE_STAMP_KEY:
            return _parse_stamp(row[1])
    return None


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

# "The caller sent no lot qty" for record_put_away. None cannot mean that: the
# Put-away screen sends null when the operator leaves Lot Qty empty (a part with
# no gate entry), and that must be recorded as empty, not looked up.
_LOOK_UP = object()


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
        # Stock in AVAILABLE packets is part of on hand (spare_packet.py): no
        # write — a count, an RGP, an issue by quantity — may take on hand
        # below it, or a labelled packet would stand for stock that is gone.
        if delta < 0:
            from app.services.spare_packet_service import SparePacketService
            packed = SparePacketService.packed_available(part_id)
            if packed > 0 and new_qty < packed - 1e-9:
                raise BadRequestError(
                    f"{packed:g} of this part is in packets with QR labels — stock cannot go below that. "
                    "Issue a packet by scanning its QR, or cancel the packet first.")

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
              scanned_code=None, scan_source=None, employee_id=None, issued_to_mobile=None,
              from_packet=False):
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
        if is_store_department(department):
            raise BadRequestError("The store hands parts out — choose the department the part is for")
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
            # By quantity only the loose stock: what is in packets goes out a
            # whole packet at a time, by its QR (from_packet — the packet
            # issue, which has already taken its packet off the available ones).
            if not from_packet:
                from app.services.spare_packet_service import SparePacketService
                packed = SparePacketService.packed_available(part.id)
                loose = round(on_hand - packed, 2)
                if packed > 0 and qty > loose + 1e-9:
                    raise BadRequestError(
                        f"{packed:g} {part.uom or ''} of {part.part_no} is in packets — scan a packet's QR to issue "
                        f"a whole packet." + (f" Loose on the shelf: {loose:g}." if loose > 0 else ""))
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
        PARTIALLY_USED. No stock moves — the quantity left available at issue.

        An issue partly returned before anyone confirmed it (PARTIALLY_RETURNED,
        still on the Waiting list — store, 16 Oct 2026) is confirmed the same
        way: the used quantity is capped at what is still out, and the status
        moves on to INSTALLED / PARTIALLY_USED, which takes it off the list."""
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
            # A part that was not fitted is not installed (the store's rule, 14 Oct
            # 2026): nothing used is refused — it stays under Waiting, or comes back.
            if used <= 0 or used > outstanding:
                raise BadRequestError(
                    f"Used quantity must be more than 0 and at most {outstanding:g} (still out on this issue). "
                    "A part that was not fitted is not installed — leave it under Waiting, or return it to the store.")
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

    def lot_qty(self, gate_entry_no, part_no):
        """Lot quantity on a gate-entry line — the gate qty SUMMED for this part on
        this gate entry (one entry can carry several parts, and a part several
        rows). `item_code` on GateEntry is the ERP Item Code = Part No., matched
        case-blind; the gate entry no is trimmed. Returns a float, or None when
        nothing matches."""
        from sqlalchemy import func
        from app.models.gate_entry import GateEntry
        ge = (gate_entry_no or "").strip()
        pn = (part_no or "").strip()
        if not ge or not pn:
            return None
        total = db.session.query(func.sum(GateEntry.qty)).filter(
            func.trim(GateEntry.gate_entry_no) == ge,
            func.upper(GateEntry.item_code) == pn.upper(),
        ).scalar()
        return float(total) if total is not None else None

    def latest_lot(self, part):
        """The lot the Put-away Check screen offers for a part: its LATEST ERP gate
        entry — newest gate date, then time, then row — with the qty summed for
        this part on that entry (lot_qty). Since 17 Oct 2026 the store prints no
        lot tag ("lot tag bhi kah rhe h ki paper wastage h use hta do" —
        management: paper waste), so the qty that tag carried comes from here and
        the storeman may correct it before confirming.

        A gate line belongs to the part when its item code is the Part No.
        (case-blind, as lot_qty); the part is one of the store's, so its lines are
        that store's. Returns {gate_entry_no, gate_entry_dt, gate_entry_time,
        qty, uom} — every value None when ERP has no gate entry for the part."""
        from sqlalchemy import func
        from app.models.gate_entry import GateEntry as G
        empty = {"gate_entry_no": None, "gate_entry_dt": None, "gate_entry_time": None,
                 "qty": None, "uom": part.uom}
        pn = (part.part_no or "").strip()
        if not pn:
            return empty
        row = (db.session.query(G.gate_entry_no, G.gate_entry_dt, G.gate_entry_time)
               .filter(func.upper(G.item_code) == pn.upper(),
                       G.gate_entry_no.isnot(None), func.trim(G.gate_entry_no) != "")
               .order_by(G.gate_entry_dt.desc(), G.gate_entry_time.desc(), G.id.desc())
               .first())
        if row is None:
            return empty
        no, dt, tm = row
        ge = no.strip()
        return {"gate_entry_no": ge, "gate_entry_dt": dt.isoformat() if dt else None,
                "gate_entry_time": (tm or "").strip() or None,
                "qty": self.lot_qty(ge, pn), "uom": part.uom}

    def record_put_away(self, part, scanned_location, gate_entry_no=None, qty=_LOOK_UP, user=None):
        """Record a confirmed put-away: the material was physically shelved in one
        of the part's bins — its fresh location or, when it has one, its rework
        location. Verifies the scanned location is one of them (the screen only
        offers Confirm on a match, but guard here too), records the lot qty and
        the gate entry it came from, and stamps who/when. Writes a PutAwayLog row
        whose assigned_location is the bin that matched; stock is NOT moved (the
        part already carries its locations). Returns the saved record —
        location_kind is "fresh" / "rework" for a two-bin part.

        `qty` is the Lot Qty as confirmed on the screen — the latest gate entry's
        (latest_lot), or what the storeman typed over it; None when it was left
        empty. A caller that sends no qty at all (a screen from before 17 Oct
        2026, which sent the gate entry no. of a scanned lot tag) gets that gate
        entry's qty looked up, as before."""
        from app.models.put_away_log import PutAwayLog
        from app.utils.bin_location import bins_text, match_bin, part_bins
        bins = part_bins(part.location, part.rework_location)
        scanned = (scanned_location or "").strip()
        if not bins:
            raise BadRequestError("Part has no assigned location")
        if not scanned:
            raise BadRequestError("Scanned location is required")
        # A bare bin QR matches at bin level, a slot "(n)" only that exact slot
        # (case and spaces ignored) — the same rule as the screen.
        matched = match_bin(scanned, bins)
        two_bins = any(kind == "rework" for kind, _ in bins)
        if not matched:
            raise BadRequestError(
                f"Scanned location is neither of the part's bins — {bins_text(bins)}" if two_bins
                else "Scanned location does not match the part's assigned location")
        kind, assigned = matched
        ge = (gate_entry_no or "").strip() or None
        if qty is _LOOK_UP:
            qty = self.lot_qty(ge, part.part_no) if ge else None
        elif qty is not None:
            qty = float(qty)
            if not qty > 0:
                raise BadRequestError("Lot qty must be more than 0 — or leave it empty")
        now = utcnow()
        log = PutAwayLog(
            part_id=part.id, part_no=part.part_no,
            assigned_location=assigned, scanned_location=scanned,
            gate_entry_no=ge, qty=(round(qty, 2) if qty is not None else None),
            section_id=part.section_id, store_code=part.store_code,
            put_by=user, confirmed_at=now,
        )
        with atomic():
            db.session.add(log)
        return {
            "id": log.id, "part_id": part.id, "part_no": part.part_no, "part_name": part.part_name,
            "location": assigned, "location_kind": kind if two_bins else None,
            "scanned_location": scanned,
            "gate_entry_no": ge, "qty": (float(qty) if qty is not None else None),
            "uom": part.uom, "put_by": user, "confirmed_at": now.isoformat(),
        }

    def _waiting_rows(self, rows):
        """Issue rows of the Waiting list, each with what came back and what is
        still out (returned_qty / outstanding_qty, the _returned_qty_map rule):
        an issue partly returned before anyone confirmed it reads "Qty 3 · 1
        returned · 2 still out", and the fitter confirms only the 2."""
        returned = self._returned_qty_map([r.id for r in rows])
        out = []
        for r in rows:
            d = self._issue_row_dict(r)
            back = returned.get(r.id, 0.0)
            d.update({"issued_qty": d["qty"], "returned_qty": back,
                      "outstanding_qty": round(d["qty"] - back, 2)})
            out.append(d)
        return out

    def pending_confirmations(self, store_code, limit=None):
        """ISSUE rows awaiting Stage-2 user confirmation (line/machine/install),
        newest first — the queue a user works through on Confirm Installation.
        Which rows wait is awaiting_confirmation_clause, the rule every count of
        this queue uses."""
        from app.models.spare_stock import SpareStockLedger
        q = (
            db.session.query(SpareStockLedger)
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code, awaiting_confirmation_clause())
            .order_by(SpareStockLedger.created_at.desc(), SpareStockLedger.id.desc())
        )
        if limit:
            q = q.limit(limit)
        return self._waiting_rows(q.all())

    def pending_confirmations_for_part(self, part_id):
        from app.models.spare_stock import SpareStockLedger
        rows = (
            SpareStockLedger.query.filter(
                SpareStockLedger.part_id == part_id,
                awaiting_confirmation_clause(),
            ).order_by(SpareStockLedger.created_at.desc(), SpareStockLedger.id.desc()).all()
        )
        return self._waiting_rows(rows)

    def installations(self, store_code, q=None, limit=200):
        """Issues fitted on the line: every ISSUE of the store's parts that has
        been through Confirm Installation at least once (confirmed_at set) and
        is not cancelled, newest confirmation first — what leaves the
        confirmation queue once confirmed. The ISSUE row carries the CURRENT
        line / machine / die, usage and status (an update is the repeatable
        confirm_installation); returned / outstanding follow the one "still
        out" rule (_returned_qty_map). `q` matches part no / name, issued to,
        mobile, department, line name / no and machine, case-blind. `limit`
        defaults to 200, at most 1000."""
        from sqlalchemy import or_
        from sqlalchemy.orm import contains_eager
        from app.models.spare_stock import SpareStockLedger as L
        query = (
            db.session.query(L)
            .join(L.part)
            .options(contains_eager(L.part))
            .filter(
                Part.store_code == store_code,
                L.txn_type == "ISSUE",
                L.confirmed_at.isnot(None),
                or_(L.status.is_(None), L.status != "CANCELLED"),
            )
        )
        q = _clean(q)
        if q:
            query = query.filter(or_(*(col.icontains(q, autoescape=True) for col in (
                Part.part_no, Part.part_name, L.issued_to, L.issued_to_mobile,
                L.department, L.line_name, L.line_no, L.machine))))
        limit = max(1, min(int(limit or 200), 1000))
        rows = query.order_by(L.confirmed_at.desc(), L.id.desc()).limit(limit).all()
        returned = self._returned_qty_map([r.id for r in rows])
        out = []
        for r in rows:
            issued = abs(float(r.qty_delta))
            back = returned.get(r.id, 0.0)
            out.append({
                "id": r.id,
                "part_id": r.part_id,
                "part_no": r.part.part_no,
                "part_name": r.part.part_name,
                "issued_at": r.created_at.isoformat() if r.created_at else None,
                "issued_by": r.created_by,
                "issued_qty": issued,
                "returned_qty": back,
                "outstanding_qty": round(issued - back, 2),
                "actual_qty": float(r.actual_qty) if r.actual_qty is not None else None,
                "status": r.status,
                "department": r.department,
                "issued_to": r.issued_to,
                "issued_to_code": r.issued_to_code,
                "issued_to_mobile": r.issued_to_mobile,
                "line_name": r.line_name,
                "line_no": r.line_no,
                "machine": r.machine,
                "die_no": r.die_no,
                "reference": r.reference,
                "confirmed_by": r.confirmed_by,
                "confirmed_at": r.confirmed_at.isoformat() if r.confirmed_at else None,
                "remarks": r.remarks,
            })
        return out

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
    def _returned_qty_map(issue_ids, job_work=True):
        """{issue_id: quantity returned against it}, in a few set queries — the
        one rule behind every "still out" figure (outstanding = issued -
        returned):

        * every return raised against the issue (spare_returns.qty), whatever
          its inspection later decided — the part is back in the store
          (job_work=False leaves out job work returns: a worn part brought back
          for repair was used, so consumption keeps it);
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
                       .filter(SpareReturn.issue_id.in_(chunk)))
            if not job_work:
                returns = returns.filter(or_(SpareReturn.return_type.is_(None),
                                             SpareReturn.return_type != "JOB_WORK_RETURN"))
            returns = returns.group_by(SpareReturn.issue_id)
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
                    returned_by=None, user=None, scanned_code=None, scan_source=None,
                    return_type="UNUSED_RETURN", verified_by=None, identified_by=None):
        """Take an issued part back to the store against its ORIGINAL issue
        (spec 13). Works for ANY issue, not just a returnable tool/die, and an
        installed part may come back too (removed from the machine).

        The return is taken straight back into store stock (store rule, 14 Oct
        2026; SpareReturnService.return_to_store): on-hand goes up by the
        returned qty, with no inspection. The ISSUE becomes RETURNED when
        nothing is left out, else PARTIALLY_RETURNED. The result keeps the older
        keys (the stock row after the return, return_no, returned_qty, issue_id,
        issue_status) for the screens that read them, plus `return`: the return
        document, closed with all of it good."""
        from app.services.spare_return_service import SpareReturnService
        if return_type == "JOB_WORK_RETURN":
            ret = SpareReturnService().job_work_return(
                ledger_id, qty=qty, reason=reason, note=note, returned_by=returned_by, user=user,
                scanned_code=scanned_code, scan_source=scan_source, identified_by=identified_by)
        else:
            ret = SpareReturnService().return_to_store(
                ledger_id, qty=qty, reason=reason, note=note, returned_by=returned_by,
                user=user, scanned_code=scanned_code, scan_source=scan_source,
                verified_by=verified_by, identified_by=identified_by,
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
        # The packet / individual unit an issue handed out whole: it comes back whole.
        from app.models.spare_packet import SparePacket
        packets = {p.issue_ledger_id: p for p in SparePacket.query.filter(
            SparePacket.issue_ledger_id.in_([i.id for i in issues] or [-1]))}

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
                "packet": ({"code": packets[i.id].code, "kind": packets[i.id].kind, "qty": float(packets[i.id].qty),
                            "status": packets[i.id].status} if i.id in packets else None),
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
        elif getattr(part, "discontinued", False):
            # Not required any more: nothing to order, whatever is on the shelf.
            status = "Discontinued"
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
            "specification": part.specification,
            # The Live Board's Find-part search reads the model no. and shows the photo.
            "model_no": getattr(part, "model_no", None), "image_file": getattr(part, "image_file", None),
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
            "discontinued": bool(getattr(part, "discontinued", False)),
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

    def list_stock(self, store_code, section_id=None, section_ids=None):
        from flask import current_app
        ttl = current_app.config.get("SPARE_STOCK_CACHE_TTL", _STOCK_CACHE_TTL)
        # section_ids (a group of sections) takes precedence over one section_id;
        # the cache key keeps the two scopes apart.
        ids_key = tuple(sorted(section_ids)) if section_ids else None
        key = (store_code, section_id, ids_key)

        def _fresh():
            hit = _STOCK_CACHE.get(key)
            if hit is not None and hit[0] > time.time():
                # A fresh list each call so an in-place sort by a caller (reorder /
                # by-status) never reorders the cached copy.
                return list(hit[1])
            return None

        def _build():
            rows = [self._row_dict(part, stock)
                    for part, stock in self.repo.list_for_store(store_code, section_id, section_ids=section_ids)]
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

    def movements_between(self, store_code, since, until=None, section_id=None, section_ids=None):
        """What moved in a window, split by direction. RECEIPT and ISSUE are
        the two the floor is asked about; OPENING and ADJUSTMENT are counted
        separately so a stock-take is never reported as a day's receipts.

        section_ids (a group of sections) takes precedence over section_id."""
        entries = self.ledger_repo.list_for_store_between(store_code, since, until)
        if section_ids:
            ids = set(section_ids)
            entries = [e for e in entries if e.part and e.part.section_id in ids]
        elif section_id:
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

    def today_movements(self, store_code, section_id=None, section_ids=None):
        """Movement totals since the shift started (see _today_shift_start)."""
        since_utc, since_local_iso = self._today_shift_start()
        summary = self.movements_between(store_code, since_utc, section_id=section_id,
                                         section_ids=section_ids)
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
        # A discontinued part has no levels to be healthy or short against: its
        # stock still counts in the money (value bands), not in the health.
        valued_all = [r for r in rows if r["qty_on_hand"] is not None and r["stock_value"] is not None]
        rows = [r for r in rows if not r.get("discontinued")]
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

        valued = valued_all
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

    def monthly_consumption(self, store_code, months=12, section_id=None, section_ids=None):
        """Issued quantity per plant-clock month (YYYY-MM), off the ledger,
        cancelled issues aside. A SQL GROUP BY
        — the ~12 monthly totals — rather than hydrating up to 5,000 ORM rows and
        grouping in Python, which is what made `analytics` the heaviest call.
        Real usage: an empty list means nothing has been issued. The current
        month is the TV board's denominator for its department shares, so it is
        cut exactly as consumption_by_department cuts this month."""
        from app.extensions import db
        from sqlalchemy import func
        from app.models.spare_stock import SpareStockLedger
        key = _plant_key("%Y-%m", SpareStockLedger.created_at, _plant_clock()[0])
        rows = (
            db.session.query(key, func.sum(func.abs(SpareStockLedger.qty_delta)))
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code, SpareStockLedger.txn_type == "ISSUE", _not_cancelled(),
                    *_sec_tuple(section_id, section_ids))
            .group_by(key).order_by(key)
            .all()
        )
        return [{"name": k, "value": round(float(v or 0), 2)} for k, v in rows if k][-months:]

    def consumption_comparison(self, store_code, section_id=None, section_ids=None):
        """This calendar month's issued quantity against the previous month and
        the same month a year ago — derived from monthly_consumption mapped by
        YYYY-MM. A month with no issues is 0; the % change is None when its
        baseline is 0 (no honest percentage off nothing)."""
        series = {r["name"]: r["value"] for r in self.monthly_consumption(
            store_code, months=15, section_id=section_id, section_ids=section_ids)}
        today = _plant_clock()[1]
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

    def stock_value_by_last_supplier(self, store_code, section_id=None, top=10, section_ids=None):
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
        for r in self.list_stock(store_code, section_id, section_ids=section_ids):
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
        """Filter clauses scoping the ledger to whole PLANT-clock days on
        `created_at`, cut as the Consumption screen cuts them
        (spare_report_service.window): from 00:00 plant time of the first day
        to 00:00 of the day after the last, as the UTC instants stored. Cut on
        the UTC date, an issue made 00:00-05:30 was dropped from a window's
        first day and counted on the day after its last, so the dashboard /
        TV / Excel did not equal the screen's Total (review, 15 Oct 2026).

        An explicit calendar range (`date_from`/`date_to`, ISO 'YYYY-MM-DD'
        from the date picker) wins; otherwise a rolling last-`days` window
        ending today on the plant clock (the Day/Week/Month/Year presets);
        otherwise () for all-time."""
        from app.models.spare_stock import SpareStockLedger
        from app.services.consumption_analytics_service import _parse_day
        col = SpareStockLedger.created_at
        offset, today = _plant_clock()

        def midnight(day):
            return datetime.combine(day, datetime.min.time()) - offset

        if date_from or date_to:
            first, last = _parse_day(date_from, "from"), _parse_day(date_to, "to")
            clauses = []
            if first:
                clauses.append(col >= midnight(first))
            if last:
                clauses.append(col < midnight(last + timedelta(days=1)))
            return tuple(clauses)
        if days and days > 0:
            return (col >= midnight(today - timedelta(days=days - 1)),)
        return ()

    def consumption_by_department(self, store_code, section_id=None, days=None, date_from=None, date_to=None, section_ids=None):
        """Total issued quantity per CONSUMING department, largest first — the
        split behind the dashboard's By Department donut, the TV board's
        this-month departments and the consumption Excel's By Department sheet.

        Consumption belongs to the department that owns the part's section
        (Tool Room, Maintenance), never the one typed on the issue — that is
        who took it out, often the store's own people ("consumption
        maintenance and tool room karega store nhi", "store to material issue
        karta h" — the store, 14 Oct 2026). The one rule the Consumption screen
        uses (consumers() / consumer_of()), so the dashboard and the screen
        never name different consumers. A cancelled issue was not consumed.
        `days` scopes to a rolling window, a range to its plant-clock days
        (_consumption_window); neither = all-time."""
        from app.extensions import db
        from sqlalchemy import func
        from app.models.spare_stock import SpareStockLedger
        from app.services.consumption_analytics_service import consumer_of, consumers
        L = SpareStockLedger
        # Per section in SQL (a handful of rows), then each section's total to
        # the department consuming it.
        rows = (
            db.session.query(Part.section_id, func.sum(func.abs(L.qty_delta)))
            .join(Part, Part.id == L.part_id)
            .filter(Part.store_code == store_code, L.txn_type == "ISSUE", _not_cancelled(),
                    *_sec_tuple(section_id, section_ids),
                    *self._consumption_window(days, date_from, date_to))
            .group_by(Part.section_id)
            .all()
        )
        owner, _ = consumers(store_code)
        totals = {}
        for section, total in rows:
            name = consumer_of(owner, section)
            totals[name] = totals.get(name, 0.0) + float(total or 0)
        out = [{"name": name, "value": round(total, 2)} for name, total in totals.items() if total]
        out.sort(key=lambda r: (-r["value"], r["name"].lower()))
        return out

    def consumption_by_machine(self, store_code, section_id=None, days=None, date_from=None, date_to=None, section_ids=None):
        """Total issued quantity per machine — the split behind Machine-wise
        Consumption (which machine eats the most spares). Only ISSUE rows carry
        a machine; a cancelled issue was not consumed. Windowed as
        consumption_by_department (None = all-time)."""
        from app.extensions import db
        from sqlalchemy import func
        from app.models.spare_stock import SpareStockLedger
        rows = (
            db.session.query(
                SpareStockLedger.machine,
                func.sum(func.abs(SpareStockLedger.qty_delta)),
            )
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code, SpareStockLedger.txn_type == "ISSUE", _not_cancelled(),
                    *_sec_tuple(section_id, section_ids),
                    *self._consumption_window(days, date_from, date_to))
            .group_by(SpareStockLedger.machine)
            .all()
        )
        out = [{"name": mc or "Unspecified", "value": round(float(total or 0), 2)}
               for mc, total in rows if total]
        out.sort(key=lambda r: r["value"], reverse=True)
        return out

    def consumption_by_type(self, store_code, section_id=None, days=None, date_from=None, date_to=None, section_ids=None):
        """Total issued quantity per component type (Part.sub_category) — the
        split behind Part-type-wise Consumption. Parts with no type group under
        'Uncategorised'; a cancelled issue was not consumed. Windowed as
        consumption_by_department (None = all-time)."""
        from app.extensions import db
        from sqlalchemy import func
        from app.models.spare_stock import SpareStockLedger
        rows = (
            db.session.query(Part.sub_category, func.sum(func.abs(SpareStockLedger.qty_delta)))
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code, SpareStockLedger.txn_type == "ISSUE", _not_cancelled(),
                    *_sec_tuple(section_id, section_ids),
                    *self._consumption_window(days, date_from, date_to))
            .group_by(Part.sub_category)
            .all()
        )
        out = [{"name": t or "Uncategorised", "value": round(float(total or 0), 2)}
               for t, total in rows if total]
        out.sort(key=lambda r: r["value"], reverse=True)
        return out

    def consumption_by_period(self, store_code, period="month", section_id=None):
        """Total issued quantity per plant-clock month (YYYY-MM) or year (YYYY)
        over the whole ledger, cancelled issues aside — the month-wise /
        year-wise consumption report. SQLite strftime; the app is SQLite (see
        _patch_schema)."""
        from app.extensions import db
        from sqlalchemy import func
        from app.models.spare_stock import SpareStockLedger
        fmt = "%Y" if period == "year" else "%Y-%m"
        key = _plant_key(fmt, SpareStockLedger.created_at, _plant_clock()[0])
        rows = (
            db.session.query(key, func.sum(func.abs(SpareStockLedger.qty_delta)))
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code, SpareStockLedger.txn_type == "ISSUE", _not_cancelled(),
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
        from app.utils.excel_io import _excel_safe, format_table
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
                ws.append([_excel_safe(r["name"]), r["value"]])
            format_table(ws)
        wsm = wb.create_sheet("Month-wise")
        wsm.append(["Month", "Issued Qty"])
        for r in self.consumption_by_period(store_code, "month", section_id):
            wsm.append([r["period"], r["qty"]])
        format_table(wsm)
        wsy = wb.create_sheet("Year-wise")
        wsy.append(["Year", "Issued Qty"])
        for r in self.consumption_by_period(store_code, "year", section_id):
            wsy.append([r["period"], r["qty"]])
        format_table(wsy)
        buf = BytesIO()
        wb.save(buf)
        buf.seek(0)
        return buf

    def consumption_trend(self, store_code, days=7, section_id=None, date_from=None, date_to=None):
        """Issued quantity per plant-clock day, cancelled issues aside — the
        consumption trend line, on the same days as the donuts and Top Consumed
        beside it (_consumption_window). A calendar range
        (`date_from`/`date_to`, ISO) wins; otherwise the last `days` days. Days
        with no issue come back as 0 so the line has a point for every day rather
        than a gap. The daily span is capped so a very wide range can't return
        thousands of points."""
        from datetime import date, timedelta
        from app.extensions import db
        from sqlalchemy import func
        from app.models.spare_stock import SpareStockLedger
        offset, today = _plant_clock()
        if date_from or date_to:
            end = date.fromisoformat(date_to) if date_to else today
            start = date.fromisoformat(date_from) if date_from else end - timedelta(days=6)
            if start > end:
                start, end = end, start
        else:
            end = today
            start = end - timedelta(days=days - 1)
        span = min((end - start).days + 1, 366)   # guard against a pathological range
        start = end - timedelta(days=span - 1)
        day = _plant_key("%Y-%m-%d", SpareStockLedger.created_at, offset)
        rows = (
            db.session.query(day, func.sum(func.abs(SpareStockLedger.qty_delta)))
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code,
                    SpareStockLedger.txn_type == "ISSUE", _not_cancelled(),
                    *self._consumption_window(None, start.isoformat(), end.isoformat()),
                    *((Part.section_id == section_id,) if section_id else ()))
            .group_by(day)
            .all()
        )
        by_day = {str(d): float(q or 0) for d, q in rows}
        out = []
        for i in range(span):
            d = start + timedelta(days=i)
            out.append({"d": d.strftime("%d %b"), "qty": round(by_day.get(d.isoformat(), 0.0), 2)})
        return out

    def movement_trend(self, store_code, days=30, section_id=None, date_from=None, date_to=None):
        """Received vs issued quantity per day — the material-flow trend that
        overlays stock-in against stock-out. Received = RECEIPT rows, issued =
        ISSUE rows, classified EXACTLY as today's figures (movements_between):
        OPENING and ADJUSTMENT are excluded so a stock-take is never reported as
        a day's receipts. Same windowing and plant-clock days as
        consumption_trend (a `date_from`/`date_to` range wins over `days`), so
        an issue sits on the same day in both charts; every day in the span gets
        a point (0 in / 0 out when nothing moved) so both lines are gap-free."""
        from datetime import date, timedelta
        from app.extensions import db
        from sqlalchemy import func, case
        from app.models.spare_stock import SpareStockLedger
        offset, today = _plant_clock()
        if date_from or date_to:
            end = date.fromisoformat(date_to) if date_to else today
            start = date.fromisoformat(date_from) if date_from else end - timedelta(days=days - 1)
            if start > end:
                start, end = end, start
        else:
            end = today
            start = end - timedelta(days=days - 1)
        span = min((end - start).days + 1, 366)   # guard against a pathological range
        start = end - timedelta(days=span - 1)
        day = _plant_key("%Y-%m-%d", SpareStockLedger.created_at, offset)
        rows = (
            db.session.query(
                day,
                func.sum(case((SpareStockLedger.txn_type == "RECEIPT", func.abs(SpareStockLedger.qty_delta)), else_=0)),
                func.sum(case((SpareStockLedger.txn_type == "ISSUE", func.abs(SpareStockLedger.qty_delta)), else_=0)),
            )
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code,
                    SpareStockLedger.txn_type.in_(("RECEIPT", "ISSUE")),
                    *self._consumption_window(None, start.isoformat(), end.isoformat()),
                    *((Part.section_id == section_id,) if section_id else ()))
            .group_by(day)
            .all()
        )
        by_day = {str(d): (float(rin or 0), float(rout or 0)) for d, rin, rout in rows}
        out = []
        for i in range(span):
            d = start + timedelta(days=i)
            rin, rout = by_day.get(d.isoformat(), (0.0, 0.0))
            out.append({"d": d.strftime("%d %b"), "in": round(rin, 2), "out": round(rout, 2)})
        return out

    def top_consumed(self, store_code, limit=5, days=30, date_from=None, date_to=None):
        """The most-issued parts in the window — the consumed-parts list. A
        calendar range (`date_from`/`date_to`) wins; otherwise the last `days`
        days (plant-clock days, _consumption_window). Ranked by total issued
        quantity; a cancelled issue was not consumed."""
        from app.extensions import db
        from sqlalchemy import func
        from app.models.spare_stock import SpareStockLedger
        total = func.sum(func.abs(SpareStockLedger.qty_delta))
        rows = (
            db.session.query(Part.part_no, Part.part_name, total)
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code,
                    SpareStockLedger.txn_type == "ISSUE", _not_cancelled(),
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
            "issued_to": e.issued_to,
            "issued_to_code": e.issued_to_code,
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

    def today_issues(self, store_code, section_id=None, section_ids=None):
        """The ISSUE rows since the shift started — the rows behind 'Today's
        Issue'. Uses the SAME shift-start boundary as today_movements, so the
        list ties out to the card (row count == issued_lines, qty == issued_qty).
        Newest first."""
        since_utc, _ = self._today_shift_start()
        rows = [e for e in self.ledger_repo.list_for_store_between(store_code, since_utc)
                if e.txn_type == "ISSUE"
                and _part_in_scope(e.part, section_id, section_ids)]
        rows.sort(key=lambda e: e.id, reverse=True)
        return [self._activity_row(e) for e in rows]

    # What a RECEIPT row's status says about where the stock-in came from.
    _STOCK_IN_SOURCE = {
        "ERP_GRN": "ERP GRN — quality accepted in ERP",
        "RGP_GRN": "RGP GRN — rework back from supplier",
        "STOCK_AVAILABLE": "Quality clearance recorded in the app",
    }

    def today_receipts(self, store_code, section_id=None, section_ids=None):
        """The RECEIPT rows since the shift started — the rows behind 'Today
        Added to Stock', on the SAME boundary as today_movements so the list ties
        out to the card (row count == received_lines, qty == received_qty). Each
        row says where the stock-in came from and, for an ERP GRN / RGP GRN, the
        supplier its journal row carries. Newest first."""
        from app.models.spare_flow import SpareTransaction
        since_utc, _ = self._today_shift_start()
        rows = [e for e in self.ledger_repo.list_for_store_between(store_code, since_utc)
                if e.txn_type == "RECEIPT"
                and _part_in_scope(e.part, section_id, section_ids)]
        rows.sort(key=lambda e: e.id, reverse=True)
        ids = [e.id for e in rows]
        supplier = dict(
            db.session.query(SpareTransaction.ledger_id, SpareTransaction.supplier_name)
            .filter(SpareTransaction.ledger_id.in_(ids), SpareTransaction.supplier_name.isnot(None)).all()
        ) if ids else {}
        out = []
        for e in rows:
            d = self._activity_row(e)
            d["source"] = self._STOCK_IN_SOURCE.get(e.status, "Receipt")
            d["supplier"] = supplier.get(e.id)
            out.append(d)
        return out

    @staticmethod
    def _naive_utc(v):
        """A stamp as naive UTC — how SQLite hands one back — so rows read from
        the DB, rows still in the session and a caller's since / until compare
        on one clock. A plain date is midnight of that day."""
        from datetime import date, timezone
        if isinstance(v, datetime):
            return v.astimezone(timezone.utc).replace(tzinfo=None) if v.tzinfo else v
        if isinstance(v, date):
            return datetime(v.year, v.month, v.day)
        return v

    def history_for_part(self, part_id, limit=25, txn_type=None, department=None,
                         machine=None, since=None, until=None):
        """Complete chronological history for a part, newest first: the stock
        ledger rows (row_kind "ledger" — the two-stage issue detail: department
        / issued-to with the taker's mobile and code / line / machine / status,
        and the receiving detail: supplier / invoice / check) and one row_kind
        "installation" row per Confirm Installation / Update Line / Machine
        entry (the INSTALLATION journal rows). An ISSUE row shows only where the
        part is NOW; the installation rows keep every place it was recorded at,
        with who recorded it, when, and how much was used.

        An installation row moves no stock: qty_delta 0, and balance_after is
        the balance in force at that moment (the latest ledger row at or before
        it — its own ISSUE row at the earliest). Its id is "inst-<journal id>",
        never a ledger id. It is shown only when its issue is an ISSUE row of
        this same part recorded before it, so a journal row left pointing at a
        deleted issue never lands on whatever later reused that id.

        Filters: txn_type INSTALLATION gives only installation rows, any other
        txn_type only ledger rows of that type; department / machine / since /
        until (datetimes or dates, UTC) apply to both kinds alike, and limit to
        the merged list (0 or below: everything, as SQLite's LIMIT -1 gave
        before). Two queries: the part's ledger, its INSTALLATION
        journal rows."""
        from bisect import bisect_right
        from sqlalchemy.orm import joinedload
        from app.models.spare_flow import SpareTransaction
        from app.models.spare_stock import SpareStockLedger

        ledger = (SpareStockLedger.query.options(joinedload(SpareStockLedger.supplier))
                  .filter(SpareStockLedger.part_id == part_id)
                  .order_by(SpareStockLedger.created_at.asc(), SpareStockLedger.id.asc()).all())
        installs = []
        if not txn_type or txn_type == "INSTALLATION":
            installs = SpareTransaction.query.filter(
                SpareTransaction.part_id == part_id,
                SpareTransaction.txn_type == "INSTALLATION",
            ).all()
        since = self._naive_utc(since) if since else None
        until = self._naive_utc(until) if until else None

        def keep(at, row_department, row_machine):
            return ((not department or row_department == department)
                    and (not machine or row_machine == machine)
                    and (since is None or at >= since)
                    and (until is None or at <= until))

        # (stamp, rank, id, row): an installation is always after its issue, so
        # on an exact tie it sorts above the ledger row.
        times = [self._naive_utc(e.created_at) for e in ledger]
        issues = {e.id: (e, at) for e, at in zip(ledger, times) if e.txn_type == "ISSUE"}
        rows = [(at, 0, e.id, self._history_ledger_row(e))
                for e, at in zip(ledger, times)
                if (not txn_type or e.txn_type == txn_type) and keep(at, e.department, e.machine)]
        for t in installs:
            issue, issued_at = issues.get(t.issue_id, (None, None))
            at = self._naive_utc(t.created_at)
            if issue is None or at < issued_at or not keep(at, t.department, t.machine):
                continue
            # Never before index 0: the entry is at or after its own ISSUE row.
            balance = float(ledger[bisect_right(times, at) - 1].balance_after)
            rows.append((at, 1, t.id, self._history_installation_row(t, issue, balance)))
        rows.sort(key=lambda r: r[:3], reverse=True)
        out = [r[3] for r in rows]
        return out[:limit] if limit and limit > 0 else out

    @staticmethod
    def _history_installation_row(t, issue, balance):
        """One INSTALLATION journal row (t) of `issue` as a history row."""
        return {
            "id": f"inst-{t.id}",
            "row_kind": "installation",
            "at": t.created_at.isoformat() if t.created_at else None,
            "txn_type": "INSTALLATION",
            "qty_delta": 0.0,
            "balance_after": balance,
            "issue_id": issue.id,
            "issue_reference": issue.reference,
            "issued_qty": abs(float(issue.qty_delta)),
            "actual_qty": float(t.qty) if t.qty is not None else None,
            "status": t.new_status,
            "prev_status": t.prev_status,
            "department": t.department,
            "issued_to": t.issued_to,
            "line_name": t.line_name,
            "line_no": t.line_no,
            "machine": t.machine,
            "die_no": t.die_no,
            "remarks": t.remarks,
            "created_by": t.created_by,
        }

    @staticmethod
    def _history_ledger_row(e):
        """One stock-ledger row as a history row."""
        return {
            "id": e.id,
            "row_kind": "ledger",
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
        }

    # ---- Excel ----

    def build_template(self, store_code=None):
        """Pre-filled with the store's own parts, so opening stock is a matter
        of typing one column rather than retyping 481 part numbers. Stamped
        with the moment it was made (TEMPLATE_META_SHEET), taken BEFORE the
        quantities are read, so an upload of an old copy can tell which of its
        figures have moved since (bulk_import). The header-only template (no
        store) carries no figures to go stale, so no stamp."""
        made_at = utcnow()
        parts = self.part_repo.get_active(store_code) if store_code else []
        qty_map = self.repo.map_by_part(store_code) if store_code else {}
        rows = [{
            "part_no": p.part_no, "part_name": p.part_name,
            "qty_on_hand": qty_map.get(p.id, ""),
        } for p in parts]
        if not rows:
            return build_template(TEMPLATE_COLUMNS)
        return _stamped_template([(c, k) for c, k in
                                  zip(TEMPLATE_COLUMNS, ("part_no", "part_name", "qty_on_hand"))],
                                 rows, made_at)

    @staticmethod
    def _moved_since(since, store_code=None, own_tag=None):
        """{part_id: its latest stock movement} for every part with a
        spare_stock_ledger row written after `since` — read once, before an
        upload writes its own rows. `own_tag` (_template_tag of the file being
        uploaded) passes over the OPENING rows an earlier upload of that same
        template wrote: they are the store's own count, not a movement."""
        from sqlalchemy import func, or_
        from app.models.spare_stock import SpareStockLedger as L
        q = (db.session.query(L.part_id, func.max(L.created_at))
             .filter(L.created_at > since).group_by(L.part_id))
        if own_tag:
            # coalesce: a NULL reference must compare as "not this tag", not
            # as unknown (which would drop the row from "moved").
            q = q.filter(or_(L.txn_type != "OPENING", func.coalesce(L.reference, "") != own_tag))
        if store_code:
            q = q.join(Part, Part.id == L.part_id).filter(Part.store_code == store_code)
        return {pid: at for pid, at in q.all()}

    def bulk_import(self, file_stream, store_code=None, user=None, sheet_name=None):
        """Upload opening stock. Blank quantity cells are skipped rather than
        read as zero — a half-filled sheet must not wipe the shelves it does
        not mention.

        A re-uploaded OLD template (store, 16 Oct 2026): when the file carries
        the stamp build_template writes, a row is NOT applied if its part had a
        stock movement after the template was made AND its figure differs from
        today's stock — that figure may be the old stock, not a count. It is
        reported per row ("skipped: stock moved since this template was made
        … — download a fresh template", in `errors`, so the import report
        lists it with its row number) and in `stale_rows` with the file and
        current figures; the rest of the file applies as before. A row equal to
        today's stock applies (it is right either way). No stamp — an older
        template, the store's own sheet, a CSV — imports exactly as before.

        A stamped upload writes its OPENING rows with the template's tag
        (_template_tag) as their reference, so uploading the same template
        again — the usual fix-a-typo-and-re-upload of a physical count — is
        not stopped by its own first upload; any other movement still is."""
        import io
        data = file_stream.read()
        made_at = _template_stamp(data) if data else None
        tag = _template_tag(made_at) if made_at else None
        moved = (self._moved_since(made_at - TEMPLATE_STAMP_ALLOWANCE, store_code, own_tag=tag)
                 if made_at else {})
        made_text = _plant_text(made_at) if made_at else None
        applied = {"updated": 0, "unchanged": 0}
        stale = []

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
            qty = round(float(qty), 2)

            if part.id in moved:
                stock = self.repo.get_by_part(part.id)
                now_qty = (round(float(stock.qty_on_hand), 2)
                           if stock is not None and stock.qty_on_hand is not None else None)
                if now_qty != qty:
                    stale.append({
                        "part_id": part.id, "part_no": part.part_no, "part_name": part.part_name,
                        "file_qty": qty, "current_qty": now_qty,
                        "last_moved_at": _plant_text(moved[part.id]),
                    })
                    raise ValueError(
                        f"Skipped: stock moved since this template was made ({made_text}) — "
                        f"download a fresh template. {part.part_no}: file {qty:g}, "
                        f"stock now {'not counted' if now_qty is None else f'{now_qty:g}'}.")

            _, delta = self._write(
                part.id, qty, "OPENING", reference=tag,
                remarks="Opening stock upload", user=user, counted=True,
            )
            applied["updated" if delta else "unchanged"] += 1

        with atomic():
            report = bulk_import(io.BytesIO(data), FIELD_ALIASES, REQUIRED_FIELDS, row_processor, sheet_name)
        report.update(applied)
        report.update({"template_made_at": made_text, "stale_count": len(stale), "stale_rows": stale})
        return report

    def build_erp_template(self, store_code=None):
        """Pre-filled with the store's parts + their current ERP qty, so loading
        the ERP stock is typing one column. A stand-in for the ERP feed until the
        ERP API is connected — the ERP side of ERP-vs-Physical."""
        parts = self.part_repo.get_active(store_code) if store_code else []
        erp_map = {e.part_id: float(e.qty_on_hand) for e in self.erp_repo.list_all()}
        rows = [{
            "part_no": p.part_no, "part_name": p.part_name,
            "erp_qty": erp_map.get(p.id, ""),
        } for p in parts]
        if not rows:
            return build_template(ERP_TEMPLATE_COLUMNS)
        return build_export([(c, k) for c, k in
                             zip(ERP_TEMPLATE_COLUMNS, ("part_no", "part_name", "erp_qty"))], rows)

    def import_erp_stock(self, file_stream, store_code=None, user=None, sheet_name=None):
        """Load ERP stock figures from an Excel (Part No + ERP Qty) into the ERP
        cache (ERPStock) — the ERP side of ERP-vs-Physical, a stand-in until the
        ERP API is connected. Blank quantity cells are skipped rather than read
        as zero, so a half-filled sheet never wipes the ERP figures it omits."""
        applied = {"updated": 0, "unchanged": 0}
        now = utcnow()

        def row_processor(raw_row):
            part_no = to_text(raw_row.get("part_no"))
            if not part_no:
                raise ValueError("Part No is required")
            part = self.part_repo.get_by_part_no(part_no)
            if not part:
                raise ValueError(f"Unknown Part No: {part_no}")
            if store_code and part.store_code != store_code:
                raise ValueError(f"{part_no} does not belong to {store_code}")
            qty = to_number(raw_row.get("erp_qty"), None)
            if qty is None:
                return  # nothing stated for this row
            if qty < 0:
                raise ValueError(f"{part_no}: ERP quantity cannot be negative")
            qty = round(float(qty), 2)
            existing = self.erp_repo.get_by_part(part.id)
            changed = existing is None or float(existing.qty_on_hand) != qty
            self.erp_repo.upsert(part.id, qty, now)
            applied["updated" if changed else "unchanged"] += 1

        with atomic():
            report = bulk_import(file_stream, ERP_FIELD_ALIASES, ERP_REQUIRED_FIELDS, row_processor, sheet_name)
        report.update(applied)
        return report

    def export_excel(self, store_code, section_id=None):
        return build_export(EXPORT_COLUMNS, self.list_stock(store_code, section_id))
