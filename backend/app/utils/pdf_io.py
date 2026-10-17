"""Shared PDF table export — the PDF counterpart to excel_io.build_export,
same (columns, rows) shape so report_service can build both formats from
one row-assembly method per report.

A table the page can show is drawn as it always was. One a little wider than
the page moves onto narrow side margins, type unchanged. One wider than those
too (many columns, long descriptions) would be centred and run off both edges,
so it is fitted to the page instead: narrow side margins, smaller type, every
column at least as wide as its longest word, the width left over going to the
columns with the longest text, and a cell too long for its column broken onto
more lines. No column is cut off."""
import io
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch, mm

FONT = "Helvetica"  # the table's cell font (reportlab's default)
# The font of a row drawn bold (a subtotal or a total): measured as bold when a
# table is fitted, so its wider text still fits its column.
BOLD = "Helvetica-Bold"
# A fitted table: side margins, type size, line height and cell side padding.
FIT_MARGIN, FIT_SIZE, FIT_LEADING, FIT_PAD = 10 * mm, 6.5, 8, 3
# The page frame's own side padding inside the margins (platypus' default).
FRAME_PAD = 6

_LOOK = [
    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1a2b4c")),
    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
    ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
]
STYLE = TableStyle(_LOOK + [("FONTSIZE", (0, 0), (-1, -1), 8)])
FIT_STYLE = TableStyle(_LOOK + [
    ("FONTSIZE", (0, 0), (-1, -1), FIT_SIZE), ("LEADING", (0, 0), (-1, -1), FIT_LEADING),
    ("LEFTPADDING", (0, 0), (-1, -1), FIT_PAD), ("RIGHTPADDING", (0, 0), (-1, -1), FIT_PAD),
])


def _document(buf, side_margin):
    return SimpleDocTemplate(buf, pagesize=landscape(A4), leftMargin=side_margin, rightMargin=side_margin,
                             topMargin=15 * mm, bottomMargin=15 * mm)


def _room(doc):
    """The width a table can take on the page."""
    return doc.width - 2 * FRAME_PAD


def _w(text, font=FONT):
    """The width of one line of text in the fitted type."""
    return stringWidth(text, font, FIT_SIZE)


def _cut_to(widths, room):
    """`widths` brought down to add up to `room` by trimming only the widest:
    every column under the resulting cap keeps its width."""
    left, count = room, len(widths)
    for width in sorted(widths):
        if width * count > left:
            break
        left, count = left - width, count - 1
    cap = left / count
    return [min(width, cap) for width in widths]


def _fonts(data, bold):
    """The font each row of `data` is drawn in: BOLD for the rows in `bold`."""
    marked = set(bold)
    return [BOLD if i in marked else FONT for i in range(len(data))]


def _fitted_widths(data, room, bold=()):
    """How wide each column's text may run (padding aside), `room` in all: each
    column as wide as its longest word, the width left over shared in
    proportion to how much more each column needs to show all its text on one
    line. When even the longest words do not fit side by side, the columns
    with the longest words give way (and those words break). The rows in
    `bold` are measured in the bold font they are drawn in."""
    fonts = _fonts(data, bold)
    full = [max(_w(line, font) for cell, font in zip(column, fonts) for line in cell.split("\n"))
            for column in zip(*data)]
    if sum(full) <= room:
        return full
    least = [max((_w(word, font) for cell, font in zip(column, fonts) for word in cell.split()), default=0)
             for column in zip(*data)]
    spare = room - sum(least)
    if spare < 0:
        return _cut_to(least, room)
    want = sum(full) - sum(least)
    return [lo + (hi - lo) * spare / want for lo, hi in zip(least, full)]


def _lines(text, width, font=FONT):
    """`text` broken into lines no wider than `width`: at spaces, and inside a
    word only when the word alone is wider."""
    out = []
    for para in text.split("\n"):
        line = ""
        for word in para.split():
            joined = f"{line} {word}" if line else word
            if _w(joined, font) <= width:
                line = joined
                continue
            if line:
                out.append(line)
            while len(word) > 1 and _w(word, font) > width:
                cut = len(word) - 1
                while cut > 1 and _w(word[:cut], font) > width:
                    cut -= 1
                out.append(word[:cut])
                word = word[cut:]
            line = word
        out.append(line)
    return "\n".join(out)


def _fitted_table(data, room, bold=()):
    """`data` fitted to `room`; the rows in `bold` (indexes into `data`, the
    header being 0) drawn bold, and measured so."""
    pad = 2 * FIT_PAD
    fits = _fitted_widths(data, room - pad * len(data[0]), bold)
    cells = [[cell if all(_w(line, font) <= fit for line in cell.split("\n")) else _lines(cell, fit, font)
              for cell, fit in zip(row, fits)] for row, font in zip(data, _fonts(data, bold))]
    table = Table(cells, colWidths=[fit + pad for fit in fits], repeatRows=1)
    table.setStyle(FIT_STYLE)
    if bold:
        table.setStyle(TableStyle([("FONTNAME", (0, r), (-1, r), BOLD) for r in bold]))
    return table


def build_pdf_table(title, columns, rows):
    """columns: list of (header_label, dict_key). rows: list of dicts."""
    buf = io.BytesIO()
    doc = _document(buf, inch)
    styles = getSampleStyleSheet()

    data = [[label for label, _ in columns]]
    for row in rows:
        data.append([str(row.get(key, "")) for _, key in columns])

    table = Table(data, repeatRows=1)
    table.setStyle(STYLE)
    # Measured against the page it is drawn on. Wider than the inch margins
    # leave: onto narrow margins as it is; wider than those too: fitted to
    # them. (Measured against the narrow margins alone, a table between the
    # two widths stayed on the inch page and ran off both edges.)
    width = table.wrap(_room(doc), doc.height)[0]
    if width > _room(doc):
        doc = _document(buf, FIT_MARGIN)
        if width > _room(doc):
            table = _fitted_table(data, _room(doc))

    doc.build([Paragraph(title, styles["Heading2"]), Spacer(1, 8), table])
    buf.seek(0)
    return buf
