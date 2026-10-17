"""Short & Rejection — what a supplier sent short and what quality rejected, on
the ERP GRN lines of a store's parts, and how long each has been pending.

The store asked for it on 17 Oct 2026: "short ki mail banani padegi agar kisi
supplier se short receive hua to mail jaayegi" and "rejection ka bhi banana
padega taaki pta chale kis supplier ki rejection padi h kitne dino se and kis
lot k against me reject hui — ye erp api se mil jaayega".

The source is ERP's GRN register (termsdb.srv_report), mirrored read-only into
receiving_register by ERPSyncService. It is read in ONE function,
erp_grn_lines(): when the ERP API arrives it replaces that read and nothing
else — the screen, the two files and the mail take the same rows from it.

    Short     = Challan Qty - Received Qty, when above 0: the supplier's
                challan said more than the store received.
    Rejected  = Reject Qty, when above 0: quality rejected it in ERP.

A GRN line belongs to a store through its part: Part No = the ERP item code,
trimmed and case-blind, as ErpGrnPostingService matches it (the mirror's own
store column is CHILD_PART on every row, so it says nothing). Money is at the
part's CURRENT rate (unit_price): a part with no rate (or a rate of 0) has no
value — blank, never 0 — and the totals say how many lines are not valued.

Days pending. Nothing from ERP says when a short or a rejection is closed (a
replacement, or a debit note). Until it does, every line counts as open and
its days pending are the days since the GRN date on the plant clock — and the
screen, the files and the mail say so (BASIS). Age bands: 0-7, 8-15, 16-30,
30+ days.

What the data cannot show is said, not left blank: the mirror keeps only the
last ERP_SYNC_SINCE_DAYS of GRNs, so the oldest GRN held is given and a window
reaching before it is flagged (an open line on an older GRN is not listed);
and the short or rejected lines whose item code is no store's Part No are
counted, since no store would list them.

The window is on the GRN date: From - To, by default the last 90 days to
today, at most MAX_DAYS. Filters: a supplier — its code exactly (a click on the
supplier-wise table), else any code or name containing the typed text — and a
part. Nothing here writes.
"""
import io
from collections import Counter
from datetime import date, timedelta
from xml.sax.saxutils import escape

from flask import current_app
from openpyxl import Workbook
from openpyxl.styles import Font
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.platypus import Paragraph, Spacer, Table, TableStyle
from sqlalchemy import func, or_

from app.extensions import db
from app.models.base import utcnow
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.services.consumption_analytics_service import _local_offset, _parse_day, _utc_naive
from app.services.reorder_mail_service import XLSX_MIME, _file_safe, mark_cell
from app.services.stock_mis_report import BELOW, HEALTHY, MONEY, REORDER, TINTS, TOTAL
from app.utils import pdf_io
from app.utils.excel_io import _append_safe_row, format_table
from app.utils.exceptions import BadRequestError, NotFoundError

TITLE = "Short & Rejection"
DEFAULT_DAYS = 90
# Five years, as the Consumption screen allows: the register is small, and an
# old open rejection must stay reachable.
MAX_DAYS = 1830
# The ERP data is "not current" once its last refresh is more than this many
# plant days old — the screen's banner turns amber.
STALE_AFTER_DAYS = 2
# Item codes named when ERP lines match no store's part: enough to act on.
UNMATCHED_ITEMS = 10

# Days pending, in bands: (key, lowest, highest) — None = open-ended. "30+"
# starts at 31: thirty days is still the 16-30 band.
AGE_BANDS = (("0-7", 0, 7), ("8-15", 8, 15), ("16-30", 16, 30), ("30+", 31, None))
# The app's status tints as (fill, text), so a band reads the same here as on
# screen: green, amber, orange, red (stock_mis_report.TINTS).
AGE_TINTS = {"0-7": TINTS[HEALTHY][:2], "8-15": TINTS[BELOW][:2], "16-30": TINTS[REORDER][:2],
             "30+": TINTS["Critical"][:2]}
AGE_LEGEND = "Age (days pending): green = 0-7 days · amber = 8-15 · orange = 16-30 · red = more than 30"

FORMATS = {"excel": ("xlsx", XLSX_MIME), "pdf": ("pdf", "application/pdf")}

SUPPLIER_COLUMNS = ("Supplier Code", "Supplier", "Short Lines", "Short Qty", "Short Value",
                    "Rejected Lines", "Rejected Qty", "Rejected Value", "Oldest (days)", "Latest GRN")
LINE_COLUMNS = ("GRN Date", "GRN No", "Lot (Gate Entry)", "Challan", "PO No", "Supplier Code", "Supplier",
                "Part No", "Description", "Challan Qty", "Received Qty", "Accepted Qty", "Rejected Qty",
                "Short Qty", "Rate", "Rejected Value", "Short Value", "Days Pending", "Age")
MONEY_COLUMNS = ("Rate", "Short Value", "Rejected Value")
TOTAL_LABEL = "Total"
SUPPLIER_SHEET, LINES_SHEET = "Supplier-wise", "Lines"

# Said beside the figures wherever they go — the screen's notes, the files'
# lines under the title. Plain text: the PDF's font has no rupee sign.
BASIS = {
    "short": "Short = Challan Qty - Received Qty: the supplier's challan said more than the store received.",
    "rejected": "Rejected = the qty quality rejected on the ERP GRN line.",
    "days": ("Days pending are counted from the GRN date until ERP tells the app the item is closed "
             "(a replacement or a debit note). ERP gives no closure yet, so every line here counts as open."),
    "value": "Valued at each part's current rate. A part with no rate has no value - blank, not 0.",
    "store": "A GRN line is this store's when its ERP item code is one of the store's Part Nos.",
    "window": "The From - To range is on the GRN date.",
}
# What ERP's GRN register does not carry yet, by line field -> how it is named.
# A field blank on every line is listed under `not_given`, so the screen can say
# "not given by ERP yet" instead of showing an empty column as if it were data.
ERP_FIELDS = {"gate_entry_no": "Lot (gate entry no. and date)", "challan_dt": "Challan date", "po_no": "PO no."}

NOTE_FONT = Font(italic=True, color="475569")
NOTE_STYLE = ParagraphStyle("ShortRejectionNote", fontName="Helvetica", fontSize=8, leading=10,
                            textColor=colors.HexColor("#475569"))


# ---- the source: the ONE read an ERP API will replace ----

def erp_grn_lines(first, last):
    """(rows, as_of): every ERP GRN line dated `first`..`last` with something
    short or rejected on it, and how far the ERP data reaches. Read today from
    receiving_register, the read-only mirror of ERP's srv_report; the ERP API
    replaces this function — the same keys — and nothing else.

    rows: dicts with id, grn_no, grn_date, ven_cd, ven_name, gate_entry_no,
    gate_entry_dt, challan_no, challan_dt, po_no, item_cd, item_desc,
    challan_qty, receipt_qty, accept_qty, reject_qty.
    as_of: {"synced_at": when the mirror last took rows from ERP (UTC, naive),
    "oldest_grn_date" / "newest_grn_date": the GRN dates the data reaches,
    "keeps_days": how many days back the source keeps (None = all of them),
    "rows": the whole mirror's row count}."""
    RR = ReceivingRegister
    q = (db.session.query(RR.id, RR.grn_no, RR.grn_date, RR.ven_cd, RR.ven_name, RR.gate_entry_no,
                          RR.gate_entry_dt, RR.challan_no, RR.challan_dt, RR.po_no, RR.item_cd, RR.item_desc,
                          RR.challan_qty, RR.receipt_qty, RR.accept_qty, RR.reject_qty)
         .filter(RR.grn_date >= first, RR.grn_date <= last, RR.item_cd.isnot(None),
                 or_(RR.reject_qty > 0, RR.challan_qty - RR.receipt_qty > 0)))
    rows = [dict(r._mapping) for r in q]
    # The sync replaces the whole snapshot, so the newest row's stamp is the
    # moment of the last refresh.
    synced, oldest, newest, count = db.session.query(
        func.max(RR.created_at), func.min(RR.grn_date), func.max(RR.grn_date), func.count(RR.id)).one()
    # Each sync takes only the last ERP_SYNC_SINCE_DAYS of GRNs and swaps the
    # whole snapshot, so a short or a rejection older than that leaves the
    # mirror though nothing closed it: the screen must say where the data
    # starts, or an early window reads as "nothing short or rejected".
    keeps = current_app.config.get("ERP_SYNC_SINCE_DAYS") or None
    return rows, {"synced_at": _utc_naive(synced), "oldest_grn_date": _as_date(oldest),
                  "newest_grn_date": _as_date(newest), "keeps_days": keeps, "rows": count or 0}


# ---- small helpers ----

def plant_today():
    return (_utc_naive(utcnow()) + _local_offset()).date()


def _key(code):
    return (code or "").strip().upper()


def _q(value):
    return round(float(value), 2) if value is not None else None


def _num(value):
    """A quantity or amount as a cell: 2, not 2.0; a fraction to 2 places."""
    if value is None:
        return None
    value = round(float(value), 2)
    return int(value) if value.is_integer() else value


def _dmy(day):
    return day.strftime("%d.%m.%Y") if day else None


def _text(value):
    return (value or "").strip() or None


def _as_date(value):
    """A GRN date from an aggregate: a date, or on SQLite possibly its text."""
    if value is None or isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def _quantities(row):
    """(challan, received, short, rejected) of one ERP GRN line, to the
    register's two places; short and rejected are 0 when not above 0."""
    challan, received = _q(row["challan_qty"]), _q(row["receipt_qty"])
    short = round(challan - received, 2) if challan is not None and received is not None else 0.0
    rejected = _q(row["reject_qty"]) or 0.0
    return challan, received, max(short, 0.0), max(rejected, 0.0)


def age_band(days):
    """The AGE_BANDS key of a number of days pending."""
    for key, low, high in AGE_BANDS:
        if days >= low and (high is None or days <= high):
            return key
    return AGE_BANDS[0][0]   # a GRN dated after today (a clock difference) is not overdue


def _dates(first, last):
    return _dmy(first) if first == last else f"{_dmy(first)} to {_dmy(last)}"


def _window(date_from, date_to, today):
    """(first, last) GRN dates of the window: To defaults to today and is cut
    there (no GRN is dated later); From defaults to DEFAULT_DAYS before To."""
    last = _parse_day(date_to, "to") or today
    last = min(last, today)
    first = _parse_day(date_from, "from") or last - timedelta(days=DEFAULT_DAYS - 1)
    if first > last:
        raise BadRequestError("'from' must be on or before 'to' (and not after today)")
    span = (last - first).days + 1
    if span > MAX_DAYS:
        raise BadRequestError(f"The window is {span} days; the most is {MAX_DAYS} (5 years)")
    return first, last


class _Sum:
    """Lines, qty and value of one kind (short or rejected) over a group. A
    line with no rate adds no money and is counted in `unrated`; a group whose
    lines all lack a rate has a value of None (unknown — blank, never 0), a
    group with no line of the kind has 0."""

    def __init__(self):
        self.lines, self.qty, self.money, self.rated, self.unrated = 0, 0.0, 0.0, 0, 0

    def add(self, qty, value):
        self.lines += 1
        self.qty += qty
        if value is None:
            self.unrated += 1
        else:
            self.money += value
            self.rated += 1

    @property
    def value(self):
        if self.lines and not self.rated:
            return None
        return round(self.money, 2)


class _Group:
    """One supplier's (or the whole window's) lines, summed."""

    def __init__(self, code=None, name=None):
        self.code, self.name = code, name
        self.short, self.rejected = _Sum(), _Sum()
        self.lines = self.unrated = 0
        self.oldest, self.latest = None, None

    def add(self, line):
        self.lines += 1
        self.name = self.name or line["supplier_name"]
        if line["short_qty"]:
            self.short.add(line["short_qty"], line["short_value"])
        if line["rejected_qty"]:
            self.rejected.add(line["rejected_qty"], line["rejected_value"])
        if line["rate"] is None:
            self.unrated += 1
        self.oldest = max(self.oldest or 0, line["days_pending"])
        if line["grn_date"] and (self.latest is None or line["grn_date"] > self.latest):
            self.latest = line["grn_date"]

    def as_dict(self):
        return {
            "supplier_code": self.code, "supplier_name": self.name, "lines": self.lines,
            "short_lines": self.short.lines, "short_qty": round(self.short.qty, 2), "short_value": self.short.value,
            "rejected_lines": self.rejected.lines, "rejected_qty": round(self.rejected.qty, 2),
            "rejected_value": self.rejected.value,
            "oldest_days": self.oldest, "latest_grn_date": self.latest, "unrated_lines": self.unrated,
        }


def _money_of(row):
    return (row["short_value"] or 0) + (row["rejected_value"] or 0)


def _lot(row):
    """The lot a line came in with — its gate entry no. and date — as one text."""
    no, day = _text(row.get("gate_entry_no")), row.get("gate_entry_dt")
    if not no:
        return None
    return f"{no} dt {_dmy(day)}" if day else no


def _challan(row):
    no, day = _text(row.get("challan_no")), row.get("challan_dt")
    if not no:
        return _dmy(day)
    return f"{no} dt {_dmy(day)}" if day else no


class ShortRejectionService:

    def report(self, store_code, date_from=None, date_to=None, supplier=None, part_id=None, today=None):
        """Everything short or rejected on the store's ERP GRN lines in the
        window: {window, filters, title, lines, summary, totals, data_as_of,
        not_given, basis}. Lines and suppliers are worst first — the longest
        pending, then the dearest."""
        today = today or plant_today()
        first, last = _window(date_from, date_to, today)
        part = self._part(store_code, part_id) if part_id not in (None, "") else None
        parts = self._store_parts(store_code)
        rows, as_of = erp_grn_lines(first, last)

        lines = []
        for row in rows:
            p = parts.get(_key(row["item_cd"]))
            if p is None or (part is not None and p["part_id"] != part.id):
                continue
            line = self._line(row, p, today)
            if line is not None:
                lines.append(line)
        lines = self._by_supplier(lines, supplier)
        lines.sort(key=lambda ln: (-ln["days_pending"], -_money_of(ln), ln["grn_no"] or "", ln["part_no"] or ""))

        groups, total = {}, _Group()
        for line in lines:
            key = line["supplier_code"] or line["supplier_name"] or ""
            groups.setdefault(key, _Group(line["supplier_code"]))
            groups[key].add(line)
            total.add(line)
        summary = sorted((g.as_dict() for g in groups.values()),
                         key=lambda s: (-(s["oldest_days"] or 0), -_money_of_summary(s),
                                        (s["supplier_name"] or s["supplier_code"] or "").lower()))
        totals = total.as_dict()
        del totals["supplier_code"], totals["supplier_name"]
        totals["suppliers"] = len(summary)
        totals["age_bands"] = {key: 0 for key, _, _ in AGE_BANDS}
        totals["age_bands"].update(Counter(line["age_band"] for line in lines))
        # The part of the window older than the oldest GRN the data holds: no
        # line can show there, so the screen and the files say so rather than
        # let it read as "nothing short or rejected".
        held = as_of["oldest_grn_date"]
        not_held = ({"from": first.isoformat(), "to": min(held - timedelta(days=1), last).isoformat()}
                    if held and first < held else None)

        return {
            "store_code": store_code,
            "window": {"from": first.isoformat(), "to": last.isoformat(), "days": (last - first).days + 1,
                       "default_days": DEFAULT_DAYS, "not_held": not_held},
            "filters": {"supplier": _text(supplier),
                        "part_id": part.id if part else None,
                        "part_no": part.part_no if part else None,
                        "part_name": part.part_name if part else None},
            "title": self._title(first, last, supplier, part),
            "lines": lines,
            "summary": summary,
            "totals": totals,
            "data_as_of": self._as_of(as_of, today),
            "not_given": [label for field, label in ERP_FIELDS.items() if lines and not any(ln[field] for ln in lines)],
            "unmatched": None if _text(supplier) or part is not None else self._unmatched(rows),
            "age_bands": [{"key": key, "from": low, "to": high} for key, low, high in AGE_BANDS],
            "basis": BASIS,
        }

    # ---- reads ----

    @staticmethod
    def _part(store_code, part_id):
        try:
            pid = int(part_id)
        except (TypeError, ValueError):
            raise BadRequestError("part_id must be a whole number") from None
        p = Part.query.filter(Part.id == pid, Part.store_code == store_code).first()
        if p is None:
            raise NotFoundError(f"Part {pid} is not in store '{store_code}'")
        return p

    @staticmethod
    def _store_parts(store_code):
        """{ITEM CODE: part facts} of every part of the store, active ones
        winning a clash: a rejection is the supplier's, whether or not the part
        is still in use."""
        rows = (db.session.query(Part.id, Part.part_no, Part.part_name, Part.unit_price, Part.is_active)
                .filter(Part.store_code == store_code)
                .order_by(Part.is_active.asc(), Part.id.asc()))
        out = {}
        for pid, part_no, name, rate, _active in rows:
            if _key(part_no):
                out[_key(part_no)] = {"part_id": pid, "part_no": part_no, "part_name": name,
                                      "rate": float(rate) if rate else None}
        return out

    @staticmethod
    def _unmatched(rows):
        """The window's short or rejected ERP lines whose item code is no
        store's Part No — no store lists them, so without this count they would
        vanish without a word (in Oct 2026 an 80-qty short of a Schneider
        element was one): {lines, short_lines, rejected_lines, item_count,
        items: the first UNMATCHED_ITEMS codes, the most lines first}. Only for
        an unfiltered window: a supplier or a part filter narrows the list to
        lines that have a part."""
        known = {_key(no) for (no,) in db.session.query(Part.part_no).filter(Part.part_no.isnot(None))}
        items, short_lines, rejected_lines = {}, 0, 0
        for row in rows:
            code = _key(row["item_cd"])
            if code and code in known:
                continue
            _, _, short, rejected = _quantities(row)
            if not short and not rejected:
                continue
            short_lines += bool(short)
            rejected_lines += bool(rejected)
            # Named by the matching key — trimmed, upper case — so one code
            # typed two ways in ERP is one item.
            item = items.setdefault(code, {"item_cd": code or None, "item_desc": _text(row["item_desc"]),
                                           "lines": 0})
            item["lines"] += 1
        ranked = sorted(items.values(), key=lambda i: (-i["lines"], i["item_cd"] or ""))
        return {"lines": sum(i["lines"] for i in ranked), "short_lines": short_lines,
                "rejected_lines": rejected_lines, "item_count": len(ranked), "items": ranked[:UNMATCHED_ITEMS]}

    @staticmethod
    def _line(row, part, today):
        """One GRN line as the screen shows it, or None when, rounded to the
        register's two places, nothing on it is short or rejected."""
        challan, received, short, rejected = _quantities(row)
        if not short and not rejected:
            return None
        rate = part["rate"]
        grn_date = row["grn_date"]
        days = max((today - grn_date).days, 0) if grn_date else 0
        return {
            "id": row["id"],
            "grn_date": grn_date.isoformat() if grn_date else None,
            "grn_no": _text(row["grn_no"]),
            "gate_entry_no": _text(row.get("gate_entry_no")),
            "gate_entry_dt": row["gate_entry_dt"].isoformat() if row.get("gate_entry_dt") else None,
            "lot": _lot(row),
            "challan_no": _text(row.get("challan_no")),
            "challan_dt": row["challan_dt"].isoformat() if row.get("challan_dt") else None,
            "po_no": _text(row.get("po_no")),
            "supplier_code": _text(row["ven_cd"]),
            "supplier_name": _text(row["ven_name"]),
            "part_id": part["part_id"], "part_no": part["part_no"],
            "description": _text(row["item_desc"]) or part["part_name"],
            "challan_qty": challan, "received_qty": received, "accepted_qty": _q(row["accept_qty"]),
            "rejected_qty": rejected, "short_qty": short,
            "rate": rate,
            "rejected_value": round(rejected * rate, 2) if rejected and rate else None,
            "short_value": round(short * rate, 2) if short and rate else None,
            "kind": "both" if short and rejected else "short" if short else "rejected",
            "days_pending": days,
            "age_band": age_band(days),
        }

    @staticmethod
    def _by_supplier(lines, supplier):
        """The lines of one supplier: its code exactly when one line has that
        code (a click on the supplier-wise table), else every line whose code
        or name contains the text (a typed search)."""
        text = (supplier or "").strip().lower()
        if not text:
            return lines
        exact = [ln for ln in lines if (ln["supplier_code"] or "").lower() == text]
        if exact:
            return exact
        return [ln for ln in lines
                if text in (ln["supplier_code"] or "").lower() or text in (ln["supplier_name"] or "").lower()]

    @staticmethod
    def _title(first, last, supplier, part):
        """The title, also the file's name: "Short & Rejection", then each
        filter that narrows it — a file never passes for more than it holds —
        then the dates: "Short & Rejection 19.07.2026 to 17.10.2026"."""
        picked = [_text(supplier), part.part_no if part is not None else None]
        return " ".join([TITLE, *(p for p in picked if p), _dates(first, last)])

    @staticmethod
    def _as_of(as_of, today):
        """How current the ERP data is: its last refresh as a plant day, and
        whether that is more than STALE_AFTER_DAYS old (or never happened)."""
        synced = as_of["synced_at"]
        day = (synced + _local_offset()).date() if synced else None
        age = max((today - day).days, 0) if day else None
        newest, oldest = as_of["newest_grn_date"], as_of["oldest_grn_date"]
        return {
            "source": "ERP GRN register (srv_report), mirrored read-only",
            "synced_at": synced.isoformat() if synced else None,
            "synced_day": day.isoformat() if day else None,
            "newest_grn_date": newest.isoformat() if newest else None,
            # The oldest GRN the data holds, and how far back the source keeps:
            # an open line on an older GRN is not listed (erp_grn_lines).
            "held_from": oldest.isoformat() if oldest else None,
            "keeps_days": as_of["keeps_days"],
            "rows": as_of["rows"],
            "age_days": age,
            "stale": age is None or age > STALE_AFTER_DAYS,
            "stale_after_days": STALE_AFTER_DAYS,
        }

    # ---- the files ----

    def export(self, store_code, fmt, **filters):
        """(file, download name, mimetype): the window on screen as ONE Excel
        workbook (sheets "Supplier-wise" and "Lines") or a PDF, named by the
        title — "Short & Rejection DD.MM.YYYY to DD.MM.YYYY" — with the notes
        the screen shows beside it: a file passed on has no screen around it."""
        if fmt not in FORMATS:
            raise BadRequestError(f"format must be one of {', '.join(FORMATS)}")
        out = self.report(store_code, **filters)
        ext, mime = FORMATS[fmt]
        buf = io.BytesIO(workbook(out)) if fmt == "excel" else _pdf(out)
        return buf, f"{_file_safe(out['title'])}.{ext}", mime


def _money_of_summary(s):
    return (s["short_value"] or 0) + (s["rejected_value"] or 0)


def file_notes(out):
    """The lines a file carries — what its figures cannot say themselves."""
    as_of = out["data_as_of"]
    notes = []
    if as_of["synced_day"]:
        notes.append(f"ERP data up to {_dmy(date.fromisoformat(as_of['synced_day']))}"
                     + (" - not current" if as_of["stale"] else ""))
    else:
        notes.append("No ERP GRN data has been read yet")
    if as_of["held_from"]:
        keeps = f" (the ERP sync keeps the last {as_of['keeps_days']} days)" if as_of["keeps_days"] else ""
        notes.append(f"ERP GRN lines are held from {_dmy(date.fromisoformat(as_of['held_from']))}{keeps}: "
                     "an open short or rejection on an older GRN is not listed.")
    gap = out["window"]["not_held"]
    if gap:
        notes.append(f"No GRN line is held for {_dates(date.fromisoformat(gap['from']), date.fromisoformat(gap['to']))}"
                     " - nothing can be listed for those dates.")
    notes.append(BASIS["days"])
    notes.append(BASIS["short"])
    unrated = out["totals"]["unrated_lines"]
    notes.append(BASIS["value"] + (f" {unrated} line{'s have' if unrated != 1 else ' has'} no rate."
                                   if unrated else ""))
    if out["not_given"]:
        notes.append("Not given by ERP yet: " + ", ".join(out["not_given"]) + ".")
    unmatched = out.get("unmatched")
    if unmatched and unmatched["lines"]:
        codes = ", ".join(i["item_cd"] or "(no code)" for i in unmatched["items"])
        more = f" and {unmatched['item_count'] - len(unmatched['items'])} more" \
            if unmatched["item_count"] > len(unmatched["items"]) else ""
        n = unmatched["lines"]
        notes.append(f"{n} short or rejected ERP GRN line{'s are' if n != 1 else ' is'} for item codes that are no "
                     f"store's Part No, so no store lists {'them' if n != 1 else 'it'}: {codes}{more}.")
    return notes


def supplier_rows(out):
    """The supplier-wise sheet's rows, keyed by column heading, the Total last."""
    def row(s, code, name):
        return {"Supplier Code": code, "Supplier": name, "Short Lines": s["short_lines"],
                "Short Qty": _num(s["short_qty"]), "Short Value": _num(s["short_value"]),
                "Rejected Lines": s["rejected_lines"], "Rejected Qty": _num(s["rejected_qty"]),
                "Rejected Value": _num(s["rejected_value"]), "Oldest (days)": s["oldest_days"],
                "Latest GRN": _dmy(date.fromisoformat(s["latest_grn_date"])) if s["latest_grn_date"] else None}
    rows = [row(s, s["supplier_code"], s["supplier_name"]) for s in out["summary"]]
    t = out["totals"]
    return rows + [row(t, TOTAL_LABEL, f"{t['suppliers']} supplier{'' if t['suppliers'] == 1 else 's'}")]


def line_rows(out):
    """The lines sheet's rows, keyed by column heading, in the screen's order."""
    return [{
        "GRN Date": _dmy(date.fromisoformat(ln["grn_date"])) if ln["grn_date"] else None,
        "GRN No": ln["grn_no"], "Lot (Gate Entry)": ln["lot"],
        "Challan": _challan({"challan_no": ln["challan_no"],
                             "challan_dt": date.fromisoformat(ln["challan_dt"]) if ln["challan_dt"] else None}),
        "PO No": ln["po_no"], "Supplier Code": ln["supplier_code"], "Supplier": ln["supplier_name"],
        "Part No": ln["part_no"], "Description": ln["description"],
        "Challan Qty": _num(ln["challan_qty"]), "Received Qty": _num(ln["received_qty"]),
        "Accepted Qty": _num(ln["accepted_qty"]), "Rejected Qty": _num(ln["rejected_qty"]),
        "Short Qty": _num(ln["short_qty"]), "Rate": _num(ln["rate"]),
        "Rejected Value": _num(ln["rejected_value"]), "Short Value": _num(ln["short_value"]),
        "Days Pending": ln["days_pending"], "Age": ln["age_band"],
    } for ln in out["lines"]]


def _sheet(ws, columns, rows, notes, total_last=False, paint=None, legend=None):
    """One table laid out as excel_io.build_export lays every export out —
    header in row 1, frozen and filterable, bordered, sized, each text through
    the formula guard — money in Indian grouping, the Total row bold, then the
    legend and the notes in grey italics after a blank row (written after the
    columns are sized, so a long note never widens column A)."""
    ws.append(list(columns))
    for r in rows:
        _append_safe_row(ws, [r.get(c) for c in columns])
    format_table(ws)
    at = {c: i for i, c in enumerate(columns, start=1)}
    for number in range(2, len(rows) + 2):
        for c in MONEY_COLUMNS:
            if c in at:
                ws.cell(row=number, column=at[c]).number_format = MONEY
        if paint is not None:
            paint(ws, number, rows[number - 2], at)
    if total_last and rows:
        for cell in ws[len(rows) + 1]:
            mark_cell(cell, TOTAL)
    line = len(rows) + 3
    for text in ([legend] if legend else []) + list(notes):
        ws.cell(row=line, column=1, value=text).font = NOTE_FONT
        line += 1


def _paint_age(ws, number, row, at):
    tint = AGE_TINTS.get(row.get("Age"))
    if tint:
        mark_cell(ws.cell(row=number, column=at["Age"]), *tint)


def workbook(out):
    """The bytes of the one workbook the screen downloads and the mail carries:
    "Supplier-wise" (with its Total) and "Lines" (the Age cell coloured)."""
    wb = Workbook()
    notes = file_notes(out)
    ws = wb.active
    ws.title = SUPPLIER_SHEET
    _sheet(ws, SUPPLIER_COLUMNS, supplier_rows(out), [out["title"], *notes], total_last=True)
    _sheet(wb.create_sheet(LINES_SHEET), LINE_COLUMNS, line_rows(out), [out["title"], *notes],
           paint=_paint_age, legend=AGE_LEGEND)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def attachment(out):
    """The workbook as a mail attachment, named as the screen's download."""
    return {"filename": f"{_file_safe(out['title'])}.xlsx", "mime": XLSX_MIME, "content": workbook(out)}


def _pdf_table(columns, rows, room, bold_last=False):
    data = [list(columns)] + [["" if r.get(c) is None else str(r.get(c)) for c in columns] for r in rows]
    table = Table(data, repeatRows=1)
    table.setStyle(pdf_io.STYLE)
    if table.wrap(room, 10_000)[0] > room:
        table = pdf_io._fitted_table(data, room)
    if bold_last and rows:
        table.setStyle(TableStyle([("FONTNAME", (0, len(rows)), (-1, len(rows)), "Helvetica-Bold")]))
    return table


def _pdf(out):
    """The two tables as pdf_io draws every report — same look, on narrow
    margins, fitted when wider still — under the title and the notes. Text is
    escaped: a "&" in a supplier's name is a character, not markup."""
    buf = io.BytesIO()
    # Nineteen columns never fit the inch margins: narrow ones from the start,
    # so the two tables share one page width.
    doc = pdf_io._document(buf, pdf_io.FIT_MARGIN)
    room = pdf_io._room(doc)
    styles = getSampleStyleSheet()
    story = [Paragraph(escape(out["title"]), styles["Heading2"])]
    story += [Paragraph(escape(note), NOTE_STYLE) for note in file_notes(out)]
    story += [Spacer(1, 8), Paragraph(SUPPLIER_SHEET, styles["Heading3"]),
              _pdf_table(SUPPLIER_COLUMNS, supplier_rows(out), room, bold_last=True),
              Spacer(1, 12), Paragraph(LINES_SHEET, styles["Heading3"])]
    rows = line_rows(out)
    story.append(_pdf_table(LINE_COLUMNS, rows, room) if rows
                 else Paragraph("Nothing short or rejected in this window.", NOTE_STYLE))
    doc.build(story)
    buf.seek(0)
    return buf
