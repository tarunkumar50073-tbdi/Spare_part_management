"""The Daily Stock Report: a store's stock position as one management (MIS)
workbook, laid out to be printed and handed over as it is.

    Summary             the front page — key figures, stock by status and by
                        section, the last 7 days' movement, the sign-off boxes
    Stock Detail        every active part, by section and part no.
    Critical & Reorder  the parts to order, worst first, with what to order
    Excess              the parts above their maximum, dearest first
    Category Summary    parts and value per section and category

Every figure is read from the app's own stock list (SpareStockService), so the
report cannot disagree with the screens: the statuses are the stock list's, the
order quantity is Inventory Control's rule, the supplier is the part's latest
gate entry. "Critical" is zero stock and below minimum together, as in every
summary the store reads.

What is not known is left empty — a part with no rate has no value, and is
counted as such in the notes; a level stored as 0 is a level not set — never
printed as a zero or a dash.

Beside it, the Daily Stock Report (Stock Only): one sheet, Stock List, with
the stock of every active part and its levels — section, part no.,
description, location, UOM, quantity in stock, min, reorder level and max —
read from the same figures, so it always agrees with the MIS (the store, 14 Oct
2026: "daily mis k alawa mujhe only daily stock report chahiye jisme only stock
ho", then "min, max, reorder bhi add kar"). Its In Stock cell is solid dark
red at zero, red at or below the min or reorder level, green between the
levels, yellow above the max, and grey "Not counted" for a part never counted.
"""
import io
import os
from copy import copy
from datetime import timedelta
from decimal import ROUND_HALF_UP, Decimal

from openpyxl import Workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE, Cell
from openpyxl.drawing.image import Image
from openpyxl.drawing.spreadsheet_drawing import AnchorMarker, OneCellAnchor
from openpyxl.drawing.xdr import XDRPositiveSize2D
from openpyxl.formatting.rule import FormulaRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.utils.units import pixels_to_EMU
from openpyxl.worksheet.page import PageMargins
from openpyxl.worksheet.properties import PageSetupProperties

from app.models.base import utcnow
from app.models.store import Store
from app.services.consumption_analytics_service import _local_offset, _utc_naive
from app.services.inventory_control_service import InventoryControlService
from app.services.spare_dashboard_service import SpareDashboardService
from app.services.spare_stock_service import SpareStockService
from app.utils.excel_io import _excel_safe

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

REPORT = "Daily Stock Report"
STOCK_ONLY = f"{REPORT} (Stock Only)"
COMPANY = "Toyota Boshoku Device India"
SYSTEM = "TBDI Digital SMP"
LOGO = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "assets", "toyota-boshoku-logo.png")

OUT, BELOW, REORDER, EXCESS, HEALTHY, NOT_COUNTED = (
    "Out of Stock", "Below Minimum", "Reorder", "Above Maximum", "Healthy", "Not Counted")
DISCONTINUED = "Discontinued"
STATUSES = (OUT, BELOW, REORDER, EXCESS, HEALTHY, DISCONTINUED, NOT_COUNTED)
# The order list, worst first.
TO_ORDER = {OUT: 0, BELOW: 1, REORDER: 2}
UNASSIGNED = "Unassigned"
UNCATEGORISED = "Uncategorised"
MOVEMENT_DAYS = 7

# ---- the look, shared by every sheet ----

FONT = "Calibri"
NAVY = "1F3A5F"         # table headers — the navy of every export (utils/excel_io)
RED = "EB0A1E"          # Toyota red
WHITE = "FFFFFF"
INK = "1F2937"
MUTED = "64748B"
RULE = "D4DBE6"         # cell borders, as in utils/excel_io
BAND = "F5F7FA"         # alternate rows
TOTAL = "E8EEF6"        # total rows and captions: a tint of the navy
# The Stock List's In Stock colours, the store's own (14 Oct 2026): red at or
# below the min / reorder level, green in between, yellow above the max, as
# (fill, text) light enough to print; then the two he chose on top: nothing on
# the shelf in solid dark red — the most urgent, it must jump out — and a part
# never counted in grey, so its cell does not read as missing data.
LEVEL_BANDS = {"low": ("FFE4E6", "9F1239"), "ok": ("D1FAE5", "065F46"), "high": ("FEF9C3", "854D0E"),
               "zero": ("DC2626", WHITE), "uncounted": ("E5E7EB", "4B5563")}
NOT_COUNTED_TEXT = "Not counted"

# The app's status colours (frontend STATUS_COLOR and the Store Stock chips) as
# a light tint with dark text, so a status reads the same here as on screen and
# still prints legibly: (fill, text, accent).
TINTS = {
    "Critical": ("FFE4E6", "9F1239", "E11D48"),
    OUT: ("FFE4E6", "9F1239", "E11D48"),
    BELOW: ("FEF3C7", "92400E", "F59E0B"),
    REORDER: ("FFEDD5", "9A3412", "F97316"),
    EXCESS: ("DBEAFE", "1E40AF", "3B82F6"),
    HEALTHY: ("D1FAE5", "065F46", "10B981"),
    NOT_COUNTED: ("F1F5F9", "475569", "94A3B8"),
    DISCONTINUED: ("E2E8F0", "334155", "64748B"),
    "Store": (TOTAL, NAVY, NAVY),
}

# Indian digit grouping (12,34,56,789): Excel has no built-in format for it, so
# the lakh and crore commas are placed by value range.
MONEY = r"[>=10000000]##\,##\,##\,##0.00;[>=100000]##\,##\,##0.00;##,##0.00"
WHOLE = r"[>=10000000]##\,##\,##\,##0;[>=100000]##\,##\,##0;##,##0"
PARTS = ";".join(section + '" parts"' for section in WHOLE.split(";"))
PERCENT = "0.0%"
DATE = "DD.MM.YYYY"

THIN = Side(style="thin", color=RULE)
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

A4_MARGINS = {"left": 0.4, "right": 0.4, "top": 0.5, "bottom": 0.6, "header": 0.25, "footer": 0.3}

# The Summary is laid out on a grid of equal columns; every tile, table column
# and signature box spans a whole number of them. Twelve of this width fill an
# A4 portrait page at 100 %.
GRID = 12
GRID_WIDTH = 7.6


def _look(wb, size=10, bold=False, italic=False, color=INK, fill=None, border=BOX,
          h="left", v="center", wrap=False, indent=0, shrink=False, fmt="General"):
    """One cell look as openpyxl's packed style, to stamp on any number of cells
    with _put.

    Setting font, fill, border, alignment and number format on each cell costs
    five registry look-ups a cell — seconds over the ~100,000 cells of a full
    store. A look is resolved once on a scratch cell instead, and its packed
    style copied to every cell that wears it (how openpyxl itself copies a
    cell's style from one sheet to another)."""
    cell = Cell(wb.active)
    cell.font = Font(name=FONT, size=size, bold=bold, italic=italic, color=color)
    cell.alignment = Alignment(horizontal=h, vertical=v, wrap_text=wrap, indent=indent,
                               shrink_to_fit=shrink)
    cell.number_format = fmt
    if fill:
        cell.fill = PatternFill("solid", fgColor=fill)
    if border:
        cell.border = border
    return cell._style


class _Guarded(str):
    """Text from the data that Excel could take for a formula: it starts with
    = + - or @ (the rule is excel_io._excel_safe's)."""


def _put(ws, row, col, value, look):
    cell = ws.cell(row=row, column=col, value=value)
    cell._style = copy(look)
    if isinstance(value, _Guarded):
        # Kept as text by Excel's own quote prefix — what typing an apostrophe
        # in front of the value sets, and Excel never shows or prints — not by
        # an apostrophe in the text itself, which it prints as part of the value.
        cell.data_type, cell.quotePrefix = "s", True
    return cell


def _span(ws, row, first, last, value, look, rows=1):
    """One value across a run of columns (and rows). Styled first, then merged:
    the merge hands the first cell's borders on to the edges of the range."""
    cell = _put(ws, row, first, value, look)
    if last > first or rows > 1:
        ws.merge_cells(start_row=row, start_column=first, end_row=row + rows - 1, end_column=last)
    return cell


def _text(value):
    """A value from the data as a text cell: single-spaced, nothing Excel cannot
    store, never read as a formula — what excel_io._excel_safe would guard comes
    back as _Guarded, for _put to write as text — or None when blank."""
    if value is None:
        return None
    text = ILLEGAL_CHARACTERS_RE.sub("", " ".join(str(value).split()))
    if not text:
        return None
    return _Guarded(text) if _excel_safe(text) != text else text


def _number(value):
    """A quantity as a real number cell: a whole number as an int, so it never
    shows a trailing ".0"; a fraction to 2 places."""
    if value is None:
        return None
    value = round(float(value), 2)
    return int(value) if value.is_integer() else value


def _grouped(value):
    """A whole number in Indian digit grouping, for the captions that are
    sentences rather than number cells. A half rounds up, as Excel shows the
    same amount in a cell (round() would make 12,344.50 "12,344")."""
    digits = str(Decimal(str(value)).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    head, tail = digits[:-3], digits[-3:]
    groups = [head[max(end - 2, 0):end] for end in range(len(head), 0, -2)][::-1]
    return ",".join(groups + [tail])


# ---- the figures ----

def _gather(store_code, stamp):
    """Everything the workbook prints, read once: the parts (the stock list's
    rows, copied — never the cached rows themselves — with the section name, the
    latest gate supplier and the order / excess figures), their tallies, and the
    week's movement."""
    stock = SpareStockService()
    store = Store.query.filter_by(code=store_code).first()
    names = {sid: _text(name) for sid, name in SpareDashboardService._section_names(store_code).items()}
    facts = stock.part_facts(store_code)

    parts = []
    for r in stock.list_stock(store_code):
        qty, rate, status = r["qty_on_hand"], r["unit_price"], r["status"]
        part = {
            "section": names.get(r["section_id"]) or UNASSIGNED,
            "category": _text(r["sub_category"]),
            "part_no": _text(r["part_no"]),
            "name": _text(r["part_name"]),
            "spec": _text(r["specification"]),
            "supplier": _text(facts.get(str(r["part_id"]), {}).get("supplier")),
            "location": _text(r["location"]),
            "uom": _text(r["uom"]),
            "qty": qty,
            # A level of 0 is a level not set — the stock list's own status rule
            # passes over it — not a limit of zero.
            "min": r["min_stock_level"] or None,
            "reorder": r["reorder_level"] or None,
            "max": r["max_stock_level"] or None,
            "status": status,
            # A rate of 0 is a missing rate, not a free part: no rate, no value.
            "rate": rate or None,
            "value": r["stock_value"] if rate else None,
        }
        if status in TO_ORDER:
            need = InventoryControlService._order_qty(r)[0]
            part["order_qty"] = need
            part["order_value"] = round(need * rate, 2) if (need and rate) else None
            # How far under the level that flags it — the order within a status.
            level = r["reorder_level"] if status == REORDER else r["min_stock_level"]
            part["gap"] = (level or 0) - qty
        elif status == EXCESS:
            over = round(qty - r["max_stock_level"], 2)
            part["excess_qty"] = over
            part["excess_value"] = round(over * rate, 2) if rate else None
        parts.append(part)
    parts.sort(key=lambda p: (_section_order(p["section"]), p["part_no"] or ""))

    by_section = {}
    for p in parts:
        by_section.setdefault(p["section"], []).append(p)

    today = stamp.date()
    first_day = today - timedelta(days=MOVEMENT_DAYS - 1)
    trend = stock.movement_trend(store_code, date_from=first_day.isoformat(), date_to=today.isoformat())
    return {
        "store": (_text(store.name) if store else None) or _text(store_code),
        "stamp": stamp,
        "today": today,
        "parts": parts,
        "total": _tally(parts),
        "sections": [(name, rows, _tally(rows)) for name, rows in by_section.items()],
        # One point per day, oldest first (movement_trend fills the quiet days).
        "movement": [(first_day + timedelta(days=i), day["in"], day["out"]) for i, day in enumerate(trend)],
    }


def _section_order(name):
    """Sections by name, with the parts no section claims at the end."""
    return (name == UNASSIGNED, name.lower())


def _tally(parts):
    """A group of parts in figures: how many, how many in each status, the stock
    value held in each status, and the money sitting above maximum. A part with
    no rate is counted but adds no value: "unvalued" is how many add none (no
    rate, or never counted), "no_levels" how many of the Healthy have no min,
    reorder level or max to be judged by."""
    count = dict.fromkeys(STATUSES, 0)
    value = dict.fromkeys(STATUSES, 0.0)
    excess_value = 0.0
    for p in parts:
        count[p["status"]] += 1
        value[p["status"]] += p["value"] or 0.0
        excess_value += p.get("excess_value") or 0.0
    return {
        "parts": len(parts),
        "count": count,
        "critical": count[OUT] + count[BELOW],
        "value": {status: round(v, 2) for status, v in value.items()},
        "stock_value": round(sum(value.values()), 2),
        "excess_value": round(excess_value, 2),
        "unrated": sum(1 for p in parts if not p["rate"]),
        "unvalued": sum(1 for p in parts if p["value"] is None),
        "no_levels": sum(1 for p in parts
                         if p["status"] == HEALTHY and not (p["min"] or p["reorder"] or p["max"])),
    }


def _share(part, whole):
    """A share as a fraction for a percentage cell; empty when there is nothing
    to take a share of."""
    return part / whole if whole else None


# ---- page setup ----

def _page(ws, today, tab, landscape, repeat_row=None, one_page=None, report=REPORT):
    """Print setup, the same on every sheet: A4, centred, fitted to the page
    width (the Summary to one page), a footer naming the report and the page.
    A portrait sheet is one page unless `one_page` is False — a long portrait
    list runs on over as many pages as it needs."""
    ws.sheet_view.showGridLines = False
    ws.sheet_properties.tabColor = tab
    ws.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.orientation = "landscape" if landscape else "portrait"
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 1 if (not landscape if one_page is None else one_page) else 0
    ws.page_margins = PageMargins(**A4_MARGINS)
    ws.print_options.horizontalCentered = True
    if repeat_row:
        ws.print_title_rows = f"{repeat_row}:{repeat_row}"
    footer = ws.oddFooter
    footer.left.text = f"{report} · {today:%d.%m.%Y}"
    footer.center.text = "&A"
    footer.right.text = "Page &P of &N"
    for part in (footer.left, footer.center, footer.right):
        part.font, part.size, part.color = f"{FONT},Regular", 8, MUTED


# ---- sheet 1: Summary ----

def _summary_sheet(wb, data):
    ws = wb.active
    ws.title = "Summary"
    for col in range(1, GRID + 1):
        ws.column_dimensions[get_column_letter(col)].width = GRID_WIDTH
    row = _letterhead(ws, wb, data)
    row = _tiles(ws, wb, row, data["total"])
    row = _status_table(ws, wb, row, data["total"])
    row = _section_table(ws, wb, row, data)
    row = _movement_table(ws, wb, row, data["movement"])
    last = _sign_off(ws, wb, row)
    ws.print_area = f"A1:{get_column_letter(GRID)}{last}"
    _page(ws, data["today"], RED, landscape=False)


def _gap(ws, row, height=9):
    ws.row_dimensions[row].height = height
    return row + 1


def _letterhead(ws, wb, data):
    """The band across the top: the logo on white at the left, the title in
    white on navy, the dates at the right, a Toyota-red rule beneath."""
    heights = (33, 22, 4)
    for row, height in enumerate(heights, start=1):
        ws.row_dimensions[row].height = height
    band = {"color": WHITE, "fill": NAVY, "border": None}
    _span(ws, 1, 1, 2, None, _look(wb, border=None), rows=2)
    _span(ws, 1, 3, 8, REPORT.upper(), _look(wb, size=20, bold=True, v="bottom", indent=1, **band))
    _span(ws, 2, 3, 8, f"{COMPANY} · {data['store']}",
          _look(wb, size=11, v="top", indent=1, shrink=True, **band))
    _span(ws, 1, 9, GRID, f"Report date: {data['today']:%d.%m.%Y}",
          _look(wb, size=11, bold=True, h="right", v="bottom", indent=1, **band))
    _span(ws, 2, 9, GRID, f"Generated: {data['stamp']:%d.%m.%Y %H:%M}",
          _look(wb, size=9, h="right", v="top", indent=1, **band))
    _span(ws, 3, 1, GRID, None, _look(wb, fill=RED, border=None))
    _logo(ws, columns=2, height_pt=heights[0] + heights[1])
    return _gap(ws, 4)


def _logo(ws, columns, height_pt):
    """The company logo, centred in the white box at the left of the band. A
    report without the picture is still a report: no file, no logo."""
    if not os.path.isfile(LOGO):
        return
    image = Image(LOGO)
    # Excel draws a column of width w as 7w + 5 pixels and a point as 4/3 pixel.
    box_w, box_h = columns * (GRID_WIDTH * 7 + 5), height_pt * 4 / 3
    # Scaled to sit a few pixels clear of the box on every side.
    scale = min((box_w - 12) / image.width, (box_h - 10) / image.height)
    width, height = round(image.width * scale), round(image.height * scale)
    corner = AnchorMarker(col=0, colOff=pixels_to_EMU(round((box_w - width) / 2)),
                          row=0, rowOff=pixels_to_EMU(round((box_h - height) / 2)))
    image.anchor = OneCellAnchor(_from=corner,
                                 ext=XDRPositiveSize2D(pixels_to_EMU(width), pixels_to_EMU(height)))
    ws.add_image(image)


def _tiles(ws, wb, row, total):
    """The strip of key figures: one boxed, tinted tile each — label, the figure
    large, small print. A line of small print is kept short enough to fit the
    tile (about 24 characters); Critical's two halves take a line each."""
    count = total["count"]
    tiles = (
        ("Total Parts", total["parts"], f"{_grouped(count[NOT_COUNTED])} not counted yet", "Store"),
        ("Stock Value", total["stock_value"], f"{_grouped(total['unrated'])} with no rate", "Store"),
        ("Critical", total["critical"],
         f"zero stock {_grouped(count[OUT])}\nbelow minimum {_grouped(count[BELOW])}", "Critical"),
        ("Reorder", count[REORDER], "at/below reorder level", REORDER),
        ("Excess", count[EXCESS], f"₹ {_grouped(total['excess_value'])} tied up", EXCESS),
        ("Healthy", count[HEALTHY], f"{_grouped(total['no_levels'])} with no levels set", HEALTHY),
    )
    for offset, height in enumerate((17, 30, 25)):
        ws.row_dimensions[row + offset].height = height
    for i, (label, figure, small, tint) in enumerate(tiles):
        fill, ink, accent = TINTS[tint]
        edge = Side(style="thin", color=accent)
        first, last = 1 + 2 * i, 2 + 2 * i
        tile = {"color": ink, "fill": fill, "h": "center"}
        _span(ws, row, first, last, label,
              _look(wb, size=9, bold=True, v="bottom", **tile,
                    border=Border(left=edge, right=edge, top=Side(style="medium", color=accent))))
        _span(ws, row + 1, first, last, figure,
              _look(wb, size=16, bold=True, fmt=WHOLE, shrink=True, **tile,
                    border=Border(left=edge, right=edge)))
        _span(ws, row + 2, first, last, small,
              _look(wb, size=8, v="top", wrap=True, **tile,
                    border=Border(left=edge, right=edge, bottom=edge)))
    return _gap(ws, row + 3)


def _heading(ws, wb, row, text):
    ws.row_dimensions[row].height = 19
    _span(ws, row, 1, GRID, text, _look(wb, size=11, bold=True, color=NAVY, border=None))
    return row + 1


def _table_row(ws, row, spans, values, looks, height=16):
    """One row of a Summary table: each value across its run of grid columns."""
    ws.row_dimensions[row].height = height
    for (first, last), value, look in zip(spans, values, looks):
        _span(ws, row, first, last, value, look)
    return row + 1


def _row_looks(wb, formats, label=None, **common):
    """The looks of one table row: a text label, then a right-aligned number in
    each of the given formats."""
    return ([_look(wb, **{"indent": 1, **common, **(label or {})})]
            + [_look(wb, h="right", fmt=fmt, shrink=True, **common) for fmt in formats])


def _head_looks(wb, columns):
    return [_look(wb, size=9, bold=True, color=WHITE, fill=NAVY, h="center", wrap=True)] * columns


def _status_table(ws, wb, row, total):
    """Stock by status. Critical is one line with its two halves indented under
    it, so the lines that count — Critical, Reorder, Excess, Healthy, Not
    counted — add up to the Total; "Not counted" is there for that sum only."""
    spans = ((1, 4), (5, 6), (7, 8), (9, 10), (11, 12))
    formats = (WHOLE, PERCENT, WHOLE, PERCENT)
    count, value = total["count"], total["value"]

    def line(label, parts, worth):
        return (label, parts, _share(parts, total["parts"]), worth, _share(worth, total["stock_value"]))

    def chip(status, **more):
        fill, ink, _ = TINTS[status]
        return {"fill": fill, "color": ink, **more}

    half = {"size": 9, "color": MUTED}
    lines = (
        (line("Critical", total["critical"], round(value[OUT] + value[BELOW], 2)),
         _row_looks(wb, formats, label=chip("Critical", bold=True))),
        (line("of which zero stock", count[OUT], value[OUT]),
         _row_looks(wb, formats, label=chip(OUT, indent=3), **half)),
        (line("of which below minimum", count[BELOW], value[BELOW]),
         _row_looks(wb, formats, label=chip(BELOW, indent=3), **half)),
        (line("Reorder", count[REORDER], value[REORDER]),
         _row_looks(wb, formats, label=chip(REORDER, bold=True))),
        (line("Excess (above maximum)", count[EXCESS], value[EXCESS]),
         _row_looks(wb, formats, label=chip(EXCESS, bold=True))),
        (line("Healthy", count[HEALTHY], value[HEALTHY]),
         _row_looks(wb, formats, label=chip(HEALTHY, bold=True))),
        (line("Discontinued (not required)", count[DISCONTINUED], value[DISCONTINUED]),
         _row_looks(wb, formats, label=chip(DISCONTINUED, bold=True))),
        (line("Not counted", count[NOT_COUNTED], value[NOT_COUNTED]),
         _row_looks(wb, formats, color=MUTED)),
    )
    row = _heading(ws, wb, row, "Stock by status")
    row = _table_row(ws, row, spans, ("Status", "Parts", "% of parts", "Stock Value", "% of value"),
                     _head_looks(wb, len(spans)), height=18)
    for values, looks in lines:
        row = _table_row(ws, row, spans, values, looks)
    row = _table_row(ws, row, spans, line("Total", total["parts"], total["stock_value"]),
                     _row_looks(wb, formats, bold=True, fill=TOTAL), height=17)
    return _gap(ws, row)


def _section_table(ws, wb, row, data):
    spans = ((1, 3), (4, 4), (5, 5), (6, 6), (7, 7), (8, 8), (9, 10), (11, 12))
    formats = (WHOLE,) * 7

    def line(label, tally):
        count = tally["count"]
        return (label, tally["parts"], tally["critical"], count[REORDER], count[EXCESS], count[HEALTHY],
                tally["stock_value"], tally["excess_value"])

    row = _heading(ws, wb, row, "Stock by section")
    row = _table_row(ws, row, spans, ("Section", "Parts", "Critical", "Reorder", "Excess", "Healthy",
                                      "Stock Value", "Excess Value"),
                     _head_looks(wb, len(spans)), height=18)
    plain, banded = _row_looks(wb, formats), _row_looks(wb, formats, fill=BAND)
    for i, (name, _, tally) in enumerate(data["sections"]):
        row = _table_row(ws, row, spans, line(name, tally), banded if i % 2 else plain)
    row = _table_row(ws, row, spans, line("Total", data["total"]),
                     _row_looks(wb, formats, bold=True, fill=TOTAL), height=17)
    ws.row_dimensions[row].height = 13
    _span(ws, row, 1, GRID, "Parts include those not counted yet. A part with no rate is counted but not valued.",
          _look(wb, size=8, italic=True, color=MUTED, border=None, indent=1))
    return _gap(ws, row + 1)


def _movement_table(ws, wb, row, movement):
    """Received against issued, day by day, newest last — or one line saying
    nothing moved, rather than a week of zeros."""
    spans = ((1, 4), (5, 8), (9, 12))
    row = _heading(ws, wb, row, f"Material movement - last {MOVEMENT_DAYS} days")
    row = _table_row(ws, row, spans, ("Date", "Received Qty", "Issued Qty"),
                     _head_looks(wb, len(spans)), height=18)
    if not any(received or issued for _, received, issued in movement):
        row = _table_row(ws, row, ((1, GRID),),
                         (f"No material was received or issued in the last {MOVEMENT_DAYS} days.",),
                         [_look(wb, italic=True, color=MUTED, indent=1)])
        return _gap(ws, row)

    def line(row, label, received, issued, height=16, **common):
        values = (label, _number(received), _number(issued))
        looks = [_look(wb, indent=1, fmt=DATE, **common)] + [
            _look(wb, h="right", shrink=True, fmt=MONEY if isinstance(qty, float) else WHOLE, **common)
            for qty in values[1:]]
        return _table_row(ws, row, spans, values, looks, height)

    for i, (day, received, issued) in enumerate(movement):
        row = line(row, day, received, issued, fill=BAND if i % 2 else None)
    row = line(row, "Total", sum(received for _, received, _ in movement),
               sum(issued for _, _, issued in movement), height=17, bold=True, fill=TOTAL)
    return _gap(ws, row)


def _sign_off(ws, wb, row):
    """Three boxes to sign in, and the line that says where the page came from.
    Returns the last row used."""
    row = _gap(ws, row, 6)
    pen = Side(style="thin", color=INK)
    for offset, height in enumerate((17, 40, 14)):
        ws.row_dimensions[row + offset].height = height
    for i, who in enumerate(("Prepared by (Store)", "Checked by", "Approved by")):
        first, last = 1 + 4 * i, 4 + 4 * i
        _span(ws, row, first, last, who, _look(wb, size=9, bold=True, color=NAVY, fill=TOTAL, indent=1))
        _span(ws, row + 1, first, last, None, _look(wb, border=Border(left=THIN, right=THIN, bottom=pen)))
        _span(ws, row + 2, first, last, "Name, signature and date",
              _look(wb, size=8, color=MUTED, h="center"))
    row = _gap(ws, row + 3, 6)
    ws.row_dimensions[row].height = 13
    _span(ws, row, 1, GRID, f"System-generated report · {SYSTEM}",
          _look(wb, size=8, color=MUTED, h="center", border=None))
    return row


# ---- sheets 2-5: the lists ----

# A list sheet is four rows of heading — title, store and note, totals, column
# headers — then one row per record. The totals sit ABOVE the header, outside
# the filter range, so sorting or filtering the list never moves them.
TITLE_ROW, STORE_ROW, TOTAL_ROW, HEAD_ROW, FIRST_ROW = 1, 2, 3, 4, 5

# Column kinds: how a value is aligned and formatted.
#   sr      the running number          mid     short text, centred
#   text    text that may wrap          qty     a quantity
#   code    text kept on one line       money   rupees, 2 places
#   status  the stock status, tinted


def _body_looks(wb):
    cell = {"size": 9, "v": "top"}
    looks = {
        "sr": _look(wb, h="center", **cell),
        "text": _look(wb, wrap=True, **cell),
        "code": _look(wb, **cell),
        "mid": _look(wb, h="center", **cell),
        "qty": _look(wb, h="right", fmt=WHOLE, shrink=True, **cell),
        "qty2": _look(wb, h="right", fmt=MONEY, shrink=True, **cell),
        "money": _look(wb, h="right", fmt=MONEY, shrink=True, **cell),
    }
    for band, (fill, ink) in LEVEL_BANDS.items():
        looks[band] = _look(wb, h="right", fmt=WHOLE, shrink=True, bold=True, color=ink, fill=fill, **cell)
        looks[band + "2"] = _look(wb, h="right", fmt=MONEY, shrink=True, bold=True, color=ink, fill=fill, **cell)
    for status in STATUSES:
        fill, ink, _ = TINTS[status]
        looks[status] = _look(wb, h="center", bold=True, color=ink, fill=fill, **cell)
    return looks


def _list_top(ws, wb, data, title, heads, lead, note, totals, date_cols=2):
    """The four heading rows of a list sheet. `heads` are the (label, width) of
    its columns; `lead` is how many of them the store's name takes on the left
    of row 2; `totals` are the (first column, last column, value, kind) cells of
    the totals row; `date_cols` how many of the last columns the report date
    takes (more on a sheet of narrow columns, so it is not cut off)."""
    width = len(heads)
    for col, (_, col_width) in enumerate(heads, start=1):
        ws.column_dimensions[get_column_letter(col)].width = col_width
    for row, height in ((TITLE_ROW, 24), (STORE_ROW, 16), (TOTAL_ROW, 18), (HEAD_ROW, 28)):
        ws.row_dimensions[row].height = height

    band = {"color": WHITE, "fill": NAVY, "border": None}
    _span(ws, TITLE_ROW, 1, width - date_cols, f"{REPORT} · {title}",
          _look(wb, size=14, bold=True, indent=1, **band))
    _span(ws, TITLE_ROW, width - date_cols + 1, width, f"Report date: {data['today']:%d.%m.%Y}",
          _look(wb, bold=True, h="right", indent=1, **band))
    _span(ws, STORE_ROW, 1, lead, f"{COMPANY} · {data['store']}",
          _look(wb, size=9, bold=True, color=NAVY, border=None, indent=1))
    _span(ws, STORE_ROW, lead + 1, width, note,
          _look(wb, size=9, italic=True, color=MUTED, border=None, h="right", indent=1, shrink=True))

    looks = {
        "label": _look(wb, bold=True, fill=TOTAL, indent=1),
        "label_right": _look(wb, bold=True, fill=TOTAL, h="right", indent=1),
        "count": _look(wb, bold=True, fill=TOTAL, h="right", fmt=WHOLE, shrink=True),
        "parts": _look(wb, bold=True, fill=TOTAL, h="right", indent=1, fmt=PARTS, shrink=True),
        "money": _look(wb, bold=True, fill=TOTAL, h="right", fmt=MONEY, shrink=True),
    }
    for first, last, value, kind in totals:
        _span(ws, TOTAL_ROW, first, last, value, looks[kind])

    head = _look(wb, size=9, bold=True, color=WHITE, fill=NAVY, h="center", wrap=True)
    for col, (label, _) in enumerate(heads, start=1):
        _put(ws, HEAD_ROW, col, label, head)


def _list_rows(ws, looks, columns, records):
    """One row per record, from FIRST_ROW; returns the last row written (the
    header row when there is nothing to list)."""
    row = HEAD_ROW
    for row, record in enumerate(records, start=FIRST_ROW):
        for col, (_, key, _, kind) in enumerate(columns, start=1):
            if kind == "sr":
                _put(ws, row, col, row - HEAD_ROW, looks["sr"])
            elif kind == "status":
                _put(ws, row, col, record[key], looks[record[key]])
            elif kind == "qty":
                value = _number(record.get(key))
                _put(ws, row, col, value, looks["qty2" if isinstance(value, float) else "qty"])
            elif kind == "level":
                # A quantity coloured by where it stands against the part's levels;
                # a part never counted says so instead of an empty cell.
                value = _number(record.get(key))
                band = record.get("band") or "qty"
                if band == "uncounted":
                    value = NOT_COUNTED_TEXT
                _put(ws, row, col, value, looks[band + ("2" if isinstance(value, float) else "")])
            else:
                _put(ws, row, col, record.get(key), looks[kind])
    return row


def _list_sheet(wb, data, title, tab, columns, records, lead, note, totals, frozen,
                landscape=True, date_cols=2, report=REPORT):
    """A sortable list: headings, rows, panes frozen under the header and after
    the first `frozen` columns, a filter on the header row. `columns` are
    (label, record key, width, kind)."""
    ws = wb.create_sheet(title)
    _list_top(ws, wb, data, title, [(label, width) for label, _, width, _ in columns], lead, note, totals,
              date_cols)
    last = _list_rows(ws, _body_looks(wb), columns, records)
    end = get_column_letter(len(columns))
    ws.auto_filter.ref = f"A{HEAD_ROW}:{end}{last}"
    ws.freeze_panes = f"{get_column_letter(frozen + 1)}{FIRST_ROW}"
    if last >= FIRST_ROW:
        # Banding as a rule on the row number, not a fill on the rows, so it is
        # still every other row after the list has been sorted. The Status
        # column is left out: it keeps its own tint.
        tinted = [col for col, column in enumerate(columns, start=1) if column[3] in ("status", "level")]
        edges = [0, *tinted, len(columns) + 1]
        ranges = " ".join(
            f"{get_column_letter(left + 1)}{FIRST_ROW}:{get_column_letter(right - 1)}{last}"
            for left, right in zip(edges, edges[1:]) if right - left > 1)
        ws.conditional_formatting.add(ranges, FormulaRule(
            formula=["MOD(ROW(),2)=0"], fill=PatternFill("solid", start_color=BAND, end_color=BAND)))
    _page(ws, data["today"], tab, landscape=landscape, repeat_row=HEAD_ROW, one_page=False, report=report)


def _unvalued(count, why="no rate"):
    """The end of a list's note: how many of its parts carry no money, and why."""
    if not count:
        return ""
    has, is_ = ("part has", "is") if count == 1 else ("parts have", "are")
    return f" · {_grouped(count)} {has} {why} and {is_} not valued"


def _detail_sheet(wb, data):
    columns = (
        ("Sr No", None, 5.5, "sr"), ("Section", "section", 14.5, "text"), ("Category", "category", 13.5, "text"),
        ("Part No", "part_no", 10, "code"), ("Description", "name", 29, "text"),
        ("Specification", "spec", 23, "text"), ("Supplier", "supplier", 18, "text"),
        ("Location", "location", 12.5, "text"), ("UOM", "uom", 5.5, "mid"), ("In Stock", "qty", 7.5, "qty"),
        ("Min", "min", 6.5, "qty"), ("Reorder Level", "reorder", 7.5, "qty"), ("Max", "max", 6.5, "qty"),
        ("Status", "status", 12.5, "status"), ("Rate", "rate", 11, "money"),
        ("Stock Value", "value", 13, "money"),
    )
    total = data["total"]
    _list_sheet(
        wb, data, "Stock Detail", NAVY, columns, data["parts"], lead=5, frozen=4,
        note="Every active part, by section and part no." + _unvalued(total["unrated"]),
        totals=((1, 2, "Total", "label"), (3, 4, total["parts"], "parts"),
                (5, 15, "Stock Value", "label_right"), (16, 16, total["stock_value"], "money")))


def _reorder_sheet(wb, data):
    columns = (
        ("Sr No", None, 5.5, "sr"), ("Section", "section", 14.5, "text"), ("Part No", "part_no", 10, "code"),
        ("Description", "name", 32, "text"), ("Supplier", "supplier", 21, "text"),
        ("Location", "location", 12.5, "text"), ("UOM", "uom", 5.5, "mid"), ("In Stock", "qty", 8, "qty"),
        ("Min", "min", 6.5, "qty"), ("Reorder Level", "reorder", 7.5, "qty"), ("Max", "max", 6.5, "qty"),
        ("Status", "status", 13, "status"), ("Order Qty", "order_qty", 8.5, "qty"),
        ("Rate", "rate", 11.5, "money"), ("Order Value", "order_value", 13.5, "money"),
    )
    records = sorted((p for p in data["parts"] if p["status"] in TO_ORDER),
                     key=lambda p: (TO_ORDER[p["status"]], -p["gap"]))
    unvalued = sum(1 for p in records if p["order_value"] is None)
    _list_sheet(
        wb, data, "Critical & Reorder", TINTS[OUT][2], columns, records, lead=4, frozen=3,
        note="Worst first: zero stock, below minimum, then reorder"
             + _unvalued(unvalued, "no rate or no order quantity"),
        totals=((1, 2, "Total", "label"), (3, 4, len(records), "parts"),
                (5, 14, "Order Value", "label_right"),
                (15, 15, round(sum(p["order_value"] or 0 for p in records), 2), "money")))


def _excess_sheet(wb, data):
    columns = (
        ("Sr No", None, 5.5, "sr"), ("Section", "section", 15, "text"), ("Part No", "part_no", 10, "code"),
        ("Description", "name", 36, "text"), ("Supplier", "supplier", 24, "text"),
        ("Location", "location", 13, "text"), ("UOM", "uom", 5.5, "mid"), ("In Stock", "qty", 9, "qty"),
        ("Max", "max", 8, "qty"), ("Excess Qty", "excess_qty", 9, "qty"),
        ("Rate", "rate", 12, "money"), ("Excess Value", "excess_value", 14, "money"),
    )
    # Dearest first; the parts with no rate cannot be ranked by money, so they
    # follow, largest excess first.
    records = sorted((p for p in data["parts"] if p["status"] == EXCESS),
                     key=lambda p: (p["excess_value"] is None, -(p["excess_value"] or 0), -p["excess_qty"]))
    unrated = sum(1 for p in records if p["excess_value"] is None)
    _list_sheet(
        wb, data, "Excess", TINTS[EXCESS][2], columns, records, lead=4, frozen=3,
        note="Above maximum, dearest excess first" + _unvalued(unrated),
        totals=((1, 2, "Total", "label"), (3, 4, len(records), "parts"),
                (5, 11, "Excess Value", "label_right"),
                (12, 12, data["total"]["excess_value"], "money")))


def _category_sheet(wb, data):
    """Parts and value per section and category (the part's sub-category),
    dearest category first within its section — those with no value known
    last — and a subtotal under each section. Not a sortable list — the
    subtotals belong where they are — so no filter."""
    heads = (("Section", 20), ("Category", 40), ("Parts", 11), ("Critical", 11), ("Reorder", 11),
             ("Excess", 11), ("Healthy", 11), ("Stock Value", 18))

    def no_value(tally):
        return tally["unvalued"] == tally["parts"]

    def figures(tally):
        count = tally["count"]
        return (tally["parts"], tally["critical"], count[REORDER], count[EXCESS], count[HEALTHY],
                # With no part both counted and rated the value is not known: empty, not 0.00.
                None if no_value(tally) else tally["stock_value"])

    ws = wb.create_sheet("Category Summary")
    total = data["total"]
    _list_top(
        ws, wb, data, "Category Summary", heads, lead=2,
        note="By section, dearest category first" + _unvalued(total["unvalued"], "no rate or no count"),
        totals=((1, 2, "Grand total", "label"),
                *((col, col, value, "count") for col, value in enumerate(figures(total)[:5], start=3)),
                (8, 8, total["stock_value"], "money")))

    def looks(**common):
        cell = {"size": 9, **common}
        return ([_look(wb, wrap=True, **cell)] * 2 + [_look(wb, h="right", fmt=WHOLE, shrink=True, **cell)] * 5
                + [_look(wb, h="right", fmt=MONEY, shrink=True, **cell)])

    plain, banded, subtotal = looks(), looks(fill=BAND), looks(bold=True, fill=TOTAL)
    row = FIRST_ROW
    for section, parts, tally in data["sections"]:
        groups = {}
        for p in parts:
            groups.setdefault(p["category"] or UNCATEGORISED, []).append(p)
        ranked = sorted(((name, _tally(rows)) for name, rows in groups.items()),
                        key=lambda g: (no_value(g[1]), -g[1]["stock_value"], g[0].lower()))
        for i, (category, group) in enumerate(ranked):
            for col, value in enumerate((section, category, *figures(group)), start=1):
                _put(ws, row, col, value, (banded if i % 2 else plain)[col - 1])
            row += 1
        for col, value in enumerate((section, "Subtotal", *figures(tally)), start=1):
            _put(ws, row, col, value, subtotal[col - 1])
        row += 1
    ws.freeze_panes = f"C{FIRST_ROW}"
    _page(ws, data["today"], TINTS[HEALTHY][2], landscape=True, repeat_row=HEAD_ROW)


def _level_band(part):
    """Where a part's stock stands against its levels, as the store colours it
    (14 Oct 2026: "min level and reorder ya usse niche red, beechwala green,
    excess wala yellow"): "zero" with nothing on the shelf; "low" at or below
    the min or the reorder level — AT the level counts, as he said; "high"
    above the max; "ok" in between; "uncounted" never counted. None — no
    colour — when it has no level to judge it by. A level stored as 0 is a
    level not set (see _gather)."""
    qty = part["qty"]
    if qty is None:
        return "uncounted"
    if qty <= 0:
        return "zero"
    floors = [level for level in (part["min"], part["reorder"]) if level]
    if any(qty <= level for level in floors):
        return "low"
    if part["max"] and qty > part["max"]:
        return "high"
    return "ok" if (floors or part["max"]) else None


def _stock_list_sheet(wb, data):
    """The stock sheet: where each part is, how many are in stock and its
    levels — no status, rate or value. In Stock is coloured by _level_band. A4
    landscape, one page wide, as many pages long as the list."""
    columns = (
        ("Sr No", None, 5.5, "sr"), ("Section", "section", 16, "text"), ("Part No", "part_no", 10.5, "code"),
        ("Description", "name", 40, "text"), ("Location", "location", 14, "text"),
        ("UOM", "uom", 6, "mid"), ("In Stock", "qty", 10.5, "level"), ("Min", "min", 7.5, "qty"),
        ("Reorder Level", "reorder", 8.5, "qty"), ("Max", "max", 7.5, "qty"),
    )
    parts = [{**p, "band": _level_band(p)} for p in data["parts"]]
    # A part never counted has no figure, so it is not "with stock" either.
    held = sum(1 for p in parts if (p["qty"] or 0) > 0)
    _list_sheet(
        wb, data, "Stock List", NAVY, columns, parts, lead=4, frozen=3,
        note="In Stock: dark red 0 · red at / below min or reorder · green between · yellow above max"
             " · grey not counted",
        totals=((1, 2, "Total", "label"), (3, 4, len(parts), "parts"),
                (5, 10, f"With stock: {_grouped(held)}", "label_right")),
        landscape=True, date_cols=4, report=STOCK_ONLY)


# ---- the workbooks ----

def daily_stock_report(store_code="MAINTENANCE", now=None):
    """Build the Daily Stock Report of a store as an .xlsx.

    `now` is the moment the report is for, in UTC like every stamp the app
    stores (default: this moment); the report is dated on the plant clock.
    Returns the attachment the mail engine takes — {"filename", "mime",
    "content"} — which is also what the download route sends."""
    stamp = _utc_naive(now or utcnow()) + _local_offset()
    data = _gather(store_code, stamp)
    wb = Workbook()
    wb.properties.title = REPORT
    wb.properties.creator = SYSTEM
    _summary_sheet(wb, data)
    _detail_sheet(wb, data)
    _reorder_sheet(wb, data)
    _excess_sheet(wb, data)
    _category_sheet(wb, data)
    buf = io.BytesIO()
    wb.save(buf)
    return {"filename": f"{REPORT} {stamp:%d.%m.%Y}.xlsx", "mime": XLSX_MIME, "content": buf.getvalue()}


def stock_only_report(store_code="MAINTENANCE", now=None):
    """Build the Daily Stock Report (Stock Only) of a store as an .xlsx: the one
    Stock List sheet. Same clock, figures and return shape as
    daily_stock_report."""
    stamp = _utc_naive(now or utcnow()) + _local_offset()
    data = _gather(store_code, stamp)
    wb = Workbook()
    wb.remove(wb.active)
    wb.properties.title = STOCK_ONLY
    wb.properties.creator = SYSTEM
    _stock_list_sheet(wb, data)
    buf = io.BytesIO()
    wb.save(buf)
    return {"filename": f"{STOCK_ONLY} {stamp:%d.%m.%Y}.xlsx", "mime": XLSX_MIME, "content": buf.getvalue()}
