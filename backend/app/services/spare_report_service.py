"""The Reports page of a spare store (the Spare Parts Store, MAINTENANCE): the
nine downloads it offers, each built from what the store records today.

One small function per report returns plain rows keyed by column heading;
ReportService renders them as the app's formatted Excel table
(excel_io.build_export), CSV or PDF and names the file — the reorder and excess
lists' Excel coloured like the reorder / excess mail sheets. Nothing here writes.

    stock / reorder / excess   SpareStockService.list_stock rows: the status the
                               screens show, the reorder mail's order and order
                               quantity, the supplier of the latest gate entry;
    issues                     spare_stock_ledger ISSUE rows, each with who took
                               it (Department) and who consumes it (Consumer:
                               the owner of the part's section, consumers());
    installations             the INSTALLATION journal rows (spare_transactions);
    returns                    spare_returns, plus older direct RETURN ledger rows;
    put-away                   put_away_log;
    receipts                   spare_stock_ledger RECEIPT rows (reference = GRN no.);
    ERP vs physical            SpareStockService.erp_gap.

There is no Kiosk Part Requests report any more: the kiosk and its Part
Requisition queue were taken out on 17 Oct 2026 ("management k according manual
detail fill karke issuance karna time waste h" — the store). The part_requests
rows stay in the database; the Issue Register lists every issue, those made
from a kiosk request included.

Consumption is not here: it is on the Consumption screen, where a part, a From
- To range and a view (date, week, month, year, part, department, line /
machine, category) are picked, seen and downloaded as Excel / PDF — "alag se
report me aane ki jarurat nhi" (the store, 14 Oct 2026). See
ConsumptionTableService; it reuses this module's plant clock and cells.

Sections and departments come from their masters, never from a list in code. A
part still in a switched-off section, or an issue booked to a department since
switched off, shows the name as it was recorded: history is not rewritten.

Dated reports cover plant-clock calendar days (default: the 1st of this month to
today). created_at is stored in UTC, so the range is shifted by the server's
offset before it is compared, and every time is printed on the plant clock.
"""
from collections import namedtuple
from datetime import datetime, time, timedelta
from decimal import Decimal

from sqlalchemy import func, or_, select

from app.extensions import db
from app.models.base import utcnow
from app.models.part import Part
from app.models.put_away_log import PutAwayLog
from app.models.spare_flow import SpareReturn, SpareTransaction
from app.models.spare_stock import LEGACY_RETURN_REASONS, RETURN_ROW_INSPECTED, SpareStockLedger
from app.models.supplier import Supplier
from app.services.consumption_analytics_service import (
    _local_offset, _parse_day, _utc_naive, consumer_of, consumers,
)
from app.services.email_rules import EXCESS_LEGEND, excess_paint
from app.services.inventory_control_service import InventoryControlService, _q
from app.services.reorder_mail_service import _ORDER, REORDER_LEGEND, REORDER_STATUSES, part_cells, reorder_paint
from app.services.spare_dashboard_service import SpareDashboardService
from app.services.spare_stock_service import SpareStockService
from app.utils.exceptions import BadRequestError, NotFoundError

# `paint` / `legend` colour a report's Excel download as a mail colours its
# sheet (reorder_mail_service.xlsx_table); a report without them downloads the
# plain table it always did.
Report = namedtuple("Report", "key label description needs_dates columns build paint legend",
                    defaults=(None, None))
# A plant-clock range: first / last day, and the UTC instants that bound it.
Window = namedtuple("Window", "first last lo hi")

STOCK_COLUMNS = ("Section", "Category", "Part No", "Description", "Specification", "Supplier",
                 "Location", "UOM", "In Stock", "Min", "Reorder Level", "Max", "Status", "Rate",
                 "Stock Value")
REORDER_COLUMNS = ("Section", "Part No", "Description", "Supplier", "Location", "UOM", "In Stock",
                   "Min", "Reorder Level", "Max", "Status", "Order Qty", "Rate", "Order Value")
EXCESS_COLUMNS = ("Section", "Part No", "Description", "Supplier", "Location", "UOM", "In Stock",
                  "Max", "Excess Qty", "Rate", "Excess Value")
ISSUE_COLUMNS = ("Date & Time", "Issue No", "Reference", "Part No", "Description", "Section", "Qty",
                 "Department", "Consumer", "Issued To", "Emp Code", "Mobile", "Issued By", "Status",
                 "Line", "Machine", "Die", "Used Qty", "Returned Qty", "Still Out")
INSTALLATION_COLUMNS = ("Date & Time", "Issue No", "Part No", "Description", "Department",
                        "Issued To", "Line", "Machine", "Die", "Used Qty", "Issued Qty",
                        "Recorded By", "Entry")
RETURN_COLUMNS = ("Date & Time", "Return No", "Issue No", "Part No", "Description", "Qty", "Reason",
                  "Returned By", "Department", "Recorded By", "Result")
PUT_AWAY_COLUMNS = ("Date & Time", "Part No", "Description", "Location", "Lot Qty",
                    "Gate Entry No", "Put By")
RECEIPT_COLUMNS = ("Date", "GRN No", "Part No", "Description", "Section", "Qty", "Supplier",
                   "Rate", "Value")
ERP_COLUMNS = ("Part No", "Description", "Location", "ERP Stock", "In Stock (Physical)",
               "Gap (Physical - ERP)", "Status")

# How an issue's status reads (models/spare_stock.ISSUE_STATUSES), as on the
# Confirm Installation screen.
ISSUE_WORDS = {
    "ISSUED_BY_STORE": "Waiting for installation",
    "PENDING_USER_CONFIRMATION": "Waiting for installation",
    "INSTALLED": "Installed",
    "PARTIALLY_USED": "Partly used",
    "RETURNED": "Returned",
    "PARTIALLY_RETURNED": "Partly returned",
    "CANCELLED": "Cancelled",
}
# A confirmation with 0 used is stored as PARTIALLY_USED: nothing was fitted.
NOT_USED = "Not used yet"
ERP_WORDS = {
    "MATCH": "Match", "SHORT": "Short", "EXCESS": "Excess",
    "NOT_SYNCED": "Awaiting ERP", "NO_PHYSICAL": "Not counted yet",
}
# Where a returned quantity went (the SpareReturn split), in that order.
RETURN_RESULTS = (
    ("qty_good", "Back in stock"), ("qty_pending", "Waiting for inspection"),
    ("qty_hold", "On hold"), ("qty_damaged", "Damaged"), ("qty_scrap", "Scrapped"),
    ("qty_rgp", "Sent for rework"),
)
# An older RETURN ledger row put the quantity straight back on the shelf.
BACK_IN_STOCK = RETURN_RESULTS[0][1]


# ---- shared cell helpers ----

def plant_today():
    return (_utc_naive(utcnow()) + _local_offset()).date()


def window(date_from=None, date_to=None):
    """The plant-day range of a dated report. Default: the 1st of the month of
    the last day (this month when neither is given) to today."""
    last = _parse_day(date_to, "date_to") or plant_today()
    first = _parse_day(date_from, "date_from") or last.replace(day=1)
    if first > last:
        raise BadRequestError("'date_from' must be on or before 'date_to'")
    offset = _local_offset()
    return Window(first, last, datetime.combine(first, time.min) - offset,
                  datetime.combine(last + timedelta(days=1), time.min) - offset)


def _plant(ts):
    ts = _utc_naive(ts)
    return ts + _local_offset() if ts else None


def _stamp(ts):
    at = _plant(ts)
    return at.strftime("%d.%m.%Y %H:%M") if at else None


def _date(ts):
    at = _plant(ts)
    return at.strftime("%d.%m.%Y") if at else None


def _num(value):
    """A quantity or amount as a number cell: 2, not 2.0; a fraction to 2 places."""
    if value is None:
        return None
    value = round(float(value), 2)
    return int(value) if value.is_integer() else value


def _cells(row):
    """Every float / Decimal in a row through _num, so no cell reads 2.0."""
    return {k: (_num(v) if isinstance(v, (float, Decimal)) else v) for k, v in row.items()}


def _money(qty, rate):
    """qty x rate; None without a quantity or a rate (a rate of 0 is a missing rate)."""
    return round(float(qty) * float(rate), 2) if (qty and rate) else None


def _line(row):
    return " ".join(v for v in (row.line_name, row.line_no) if v) or None


def _issue_status(row):
    if (row.status in ("INSTALLED", "PARTIALLY_USED") and row.actual_qty is not None
            and float(row.actual_qty) == 0):
        return NOT_USED
    if not row.status:
        return "Status not recorded"  # issues from before the two-stage flow
    return ISSUE_WORDS.get(row.status) or row.status.replace("_", " ").capitalize()


def _return_result(ret):
    split = [(label, ret.q(column)) for column, label in RETURN_RESULTS if ret.q(column) > 0]
    if len(split) == 1:
        return split[0][0]
    return ", ".join(f"{label} {_q(qty)}" for label, qty in split) or None


def _in(column, win):
    return (column >= win.lo, column < win.hi)


class SpareReportService:
    def __init__(self):
        self.stock = SpareStockService()

    def build(self, store_code, key, date_from=None, date_to=None):
        """(report, window or None, rows) — rows keyed by column heading."""
        report = next((r for r in self.REPORTS if r.key == key), None)
        if report is None:
            raise NotFoundError(f"There is no report '{key}' in this store")
        win = window(date_from, date_to) if report.needs_dates else None
        rows = report.build(self, store_code, win)
        return report, win, [_cells(r) for r in rows]

    # ---- reads shared by several reports ----

    @staticmethod
    def _sections(store_code):
        """{section id: name} for every section of the store, switched off or not."""
        return SpareDashboardService._section_names(store_code)

    def _suppliers(self, store_code):
        return {pid: f["supplier"] for pid, f in self.stock.part_facts(store_code).items()
                if f.get("supplier")}

    def _part_rows(self, store_code, statuses=None):
        """(stock rows, their part_cells) of the store's active parts."""
        sections, suppliers = self._sections(store_code), self._suppliers(store_code)
        rows = [r for r in self.stock.list_stock(store_code)
                if statuses is None or r["status"] in statuses]
        return [(r, part_cells(r, sections, suppliers)) for r in rows]

    @staticmethod
    def _issues(store_code, win, *extra):
        L = SpareStockLedger
        return (db.session.query(L, Part).join(Part, Part.id == L.part_id)
                .filter(Part.store_code == store_code, L.txn_type == "ISSUE",
                        *_in(L.created_at, win), *extra)
                .order_by(L.created_at, L.id).all())

    # ---- the reports ----

    def _stock_current(self, store_code, _win):
        out = [cells for _, cells in self._part_rows(store_code)]
        out.sort(key=lambda c: (c["Section"] is None, (c["Section"] or "").lower(), c["Part No"] or ""))
        return out

    def _reorder_list(self, store_code, _win):
        rows = self._part_rows(store_code, REORDER_STATUSES)
        # The reorder mail's order: zero stock, below minimum, at reorder level;
        # within each, furthest under the minimum first.
        rows.sort(key=lambda rc: (_ORDER.get(rc[0]["status"], 9),
                                  -((rc[0]["min_stock_level"] or 0) - (rc[0]["qty_on_hand"] or 0))))
        out = []
        for r, cells in rows:
            qty = InventoryControlService._order_qty(r)[0]
            out.append({**cells, "Order Qty": qty, "Order Value": _money(qty, r["unit_price"])})
        return out

    def _excess_list(self, store_code, _win):
        out = []
        for r, cells in self._part_rows(store_code, ("Above Maximum",)):
            over = round(r["qty_on_hand"] - (r["max_stock_level"] or 0), 2)
            out.append({**cells, "Excess Qty": over, "Excess Value": _money(over, r["unit_price"])})
        # Where the money is tied up; unrated parts after every rated one.
        out.sort(key=lambda c: (c["Excess Value"] is None, -(c["Excess Value"] or 0), -c["Excess Qty"]))
        return out

    def _issue_register(self, store_code, win):
        rows = self._issues(store_code, win)
        sections = self._sections(store_code)
        owner, _ = consumers(store_code)
        returned = SpareStockService._returned_qty_map([r.id for r, _ in rows])
        out = []
        for r, part in rows:
            issued = abs(float(r.qty_delta))
            back = returned.get(r.id, 0.0)
            used = r.actual_qty if r.actual_qty is not None else (issued if r.status == "INSTALLED" else None)
            out.append({
                "Date & Time": _stamp(r.created_at), "Issue No": r.id, "Reference": r.reference,
                "Part No": part.part_no, "Description": part.part_name,
                "Section": sections.get(part.section_id), "Qty": issued,
                # Department = who took it, as typed (often the store's own
                # people); Consumer = who uses it, by the part's section.
                "Department": r.department, "Consumer": consumer_of(owner, part.section_id),
                "Issued To": r.issued_to, "Emp Code": r.issued_to_code,
                "Mobile": r.issued_to_mobile, "Issued By": r.created_by, "Status": _issue_status(r),
                "Line": _line(r), "Machine": r.machine, "Die": r.die_no,
                "Used Qty": used, "Returned Qty": back,
                "Still Out": 0 if r.status == "CANCELLED" else max(round(issued - back, 2), 0),
            })
        return out

    def _installation_register(self, store_code, win):
        T, L = SpareTransaction, SpareStockLedger
        rows = (db.session.query(T, L, Part)
                .join(L, L.id == T.issue_id).join(Part, Part.id == L.part_id)
                .filter(T.txn_type == "INSTALLATION", L.txn_type == "ISSUE",
                        Part.store_code == store_code, *_in(T.created_at, win))
                .order_by(T.created_at, T.id).all())
        # An issue's first INSTALLATION entry is its installation; later ones update it.
        firsts = {first for (first,) in
                  db.session.query(func.min(T.id)).join(Part, Part.id == T.part_id)
                  .filter(T.txn_type == "INSTALLATION", Part.store_code == store_code)
                  .group_by(T.issue_id)}
        return [{
            "Date & Time": _stamp(t.created_at), "Issue No": issue.id, "Part No": part.part_no,
            "Description": part.part_name, "Department": t.department, "Issued To": t.issued_to,
            "Line": _line(t), "Machine": t.machine, "Die": t.die_no, "Used Qty": t.qty,
            "Issued Qty": abs(float(issue.qty_delta)), "Recorded By": t.created_by,
            "Entry": "Installation" if t.id in firsts else "Update",
        } for t, issue, part in rows]

    def _return_register(self, store_code, win):
        R, L = SpareReturn, SpareStockLedger
        returns = (db.session.query(R, Part).join(Part, Part.id == R.part_id)
                   .filter(R.store_code == store_code, *_in(R.created_at, win)).all())
        # Direct returns from before the store inspection — not the RETURN rows a
        # good inspection writes, whose quantity is already on their return.
        direct = (db.session.query(L, Part).join(Part, Part.id == L.part_id)
                  .filter(Part.store_code == store_code, L.txn_type == "RETURN",
                          or_(L.status.is_(None), L.status != RETURN_ROW_INSPECTED),
                          *_in(L.created_at, win)).all())
        lines = [(_utc_naive(r.created_at), r.return_no, {
            "Date & Time": _stamp(r.created_at), "Return No": r.return_no, "Issue No": r.issue_id,
            "Part No": part.part_no, "Description": part.part_name, "Qty": r.qty,
            "Reason": LEGACY_RETURN_REASONS.get(r.reason, r.reason), "Returned By": r.returned_by,
            "Department": r.department, "Recorded By": r.received_by, "Result": _return_result(r),
        }) for r, part in returns]
        lines += [(_utc_naive(e.created_at), e.return_no or "", {
            "Date & Time": _stamp(e.created_at), "Return No": e.return_no, "Issue No": e.return_of_id,
            "Part No": part.part_no, "Description": part.part_name, "Qty": abs(float(e.qty_delta)),
            "Reason": LEGACY_RETURN_REASONS.get(e.return_reason, e.return_reason),
            "Returned By": e.returned_by, "Department": e.department,
            "Recorded By": e.created_by, "Result": BACK_IN_STOCK,
        }) for e, part in direct]
        lines.sort(key=lambda line: line[:2])
        return [row for _, _, row in lines]

    def _put_away_register(self, store_code, win):
        rows = (db.session.query(PutAwayLog, Part).outerjoin(Part, Part.id == PutAwayLog.part_id)
                .filter(PutAwayLog.store_code == store_code, *_in(PutAwayLog.created_at, win))
                .order_by(PutAwayLog.created_at, PutAwayLog.id).all())
        return [{
            "Date & Time": _stamp(log.confirmed_at or log.created_at),
            "Part No": log.part_no or (part.part_no if part else None),
            "Description": part.part_name if part else None,
            "Location": log.assigned_location, "Lot Qty": log.qty,
            "Gate Entry No": log.gate_entry_no, "Put By": log.put_by,
        } for log, part in rows]

    def _receipt_register(self, store_code, win):
        L, T = SpareStockLedger, SpareTransaction
        # The supplier the GRN named, kept on the journal row of the stock-in.
        journal_supplier = (select(T.supplier_name)
                            .where(T.ledger_id == L.id, T.supplier_name.isnot(None))
                            .order_by(T.id.desc()).limit(1).scalar_subquery())
        rows = (db.session.query(L, Part, Supplier.supplier_name, journal_supplier)
                .join(Part, Part.id == L.part_id)
                .outerjoin(Supplier, Supplier.id == L.supplier_id)
                .filter(Part.store_code == store_code, L.txn_type == "RECEIPT",
                        *_in(L.created_at, win))
                .order_by(L.created_at, L.id).all())
        sections = self._sections(store_code)
        return [{
            "Date": _date(e.created_at), "GRN No": e.reference, "Part No": part.part_no,
            "Description": part.part_name, "Section": sections.get(part.section_id),
            "Qty": float(e.qty_delta), "Supplier": master or named, "Rate": part.unit_price,
            "Value": _money(e.qty_delta, part.unit_price),
        } for e, part, master, named in rows]

    def _erp_vs_physical(self, store_code, _win):
        return [{
            "Part No": r["part_no"], "Description": r["part_name"], "Location": r["location"],
            "ERP Stock": r["erp_qty"], "In Stock (Physical)": r["physical_qty"],
            "Gap (Physical - ERP)": r["gap_qty"], "Status": ERP_WORDS.get(r["status"], r["status"]),
        } for r in self.stock.erp_gap(store_code)]

    REPORTS = (
        Report("stock_current", "Current Stock",
               "Every active part with its stock, min / reorder / max, status, rate and value.",
               False, STOCK_COLUMNS, _stock_current),
        # The reorder and excess lists in the colours of the mail sheets the
        # store approved on 14 Oct 2026 — he opened this download and asked
        # "bhai kahan kiya???" (15 Oct 2026): the same colours wherever the
        # list opens. Built by the mails' own code, found by column heading.
        Report("reorder_list", "Reorder / Critical List",
               "Parts at zero, below minimum or at reorder level, worst first, with the quantity to order.",
               False, REORDER_COLUMNS, _reorder_list, reorder_paint(REORDER_COLUMNS), REORDER_LEGEND),
        Report("excess_list", "Excess Parts",
               "Parts above maximum with the excess quantity and the money tied up, dearest first.",
               False, EXCESS_COLUMNS, _excess_list, excess_paint(EXCESS_COLUMNS), EXCESS_LEGEND),
        Report("issue_register", "Issue Register",
               "Every issue in the period: who took it (Department), who consumes it (Consumer, by the "
               "part's section), its status, where it was fitted and what is still out.",
               True, ISSUE_COLUMNS, _issue_register),
        Report("installation_register", "Installation Register",
               "Every installation and later update recorded in the period: line, machine, die and qty used.",
               True, INSTALLATION_COLUMNS, _installation_register),
        Report("return_register", "Return Register",
               "Every part returned to the store in the period, against its issue, and where the qty went.",
               True, RETURN_COLUMNS, _return_register),
        Report("put_away_register", "Put-away Register",
               "Put-away confirmations in the period: part, location, lot quantity and who put it away.",
               True, PUT_AWAY_COLUMNS, _put_away_register),
        Report("receipt_register", "Receipts (ERP GRN)",
               "Stock received in the period on ERP GRNs, with the supplier and the value at today's rate.",
               True, RECEIPT_COLUMNS, _receipt_register),
        Report("erp_vs_physical", "ERP vs Physical",
               "ERP stock against the physical count of every part, largest gap first.",
               False, ERP_COLUMNS, _erp_vs_physical),
    )
