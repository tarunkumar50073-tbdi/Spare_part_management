"""The Part Master's QR list as a PDF (the store, 13 Nov 2026: "part master k
according qr list dekh sake download ka sake pdf file").

One card per part on A4 portrait, 3 across and 7 down: the part's QR (its QR
Code, else its Part No.), the Part No. in bold, the Item Description, the Model
No. and the location. The parts are the ones the Part Master shows with the
same filters, in Part No. order.
"""
import io
from datetime import datetime

from reportlab.graphics.barcode.qrencoder import QRCode, QRErrorCorrectLevel
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

COLS, ROWS = 3, 7
MARGIN, HEAD = 10 * mm, 14 * mm
QR = 24 * mm


def _wrap(text, font, size, width, lines):
    """`text` in at most `lines` lines of `width`; the last one cut with an ellipsis."""
    words, out, cur = str(text or "").split(), [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if stringWidth(trial, font, size) <= width:
            cur = trial
            continue
        if cur:
            out.append(cur)
        cur = w
        if len(out) == lines:
            break
    if cur and len(out) < lines:
        out.append(cur)
    out = out[:lines]
    if len(out) == lines and " ".join(out) != " ".join(words):
        last = out[-1]
        while last and stringWidth(last + "…", font, size) > width:
            last = last[:-1]
        out[-1] = last + "…"
    return out


def _qr(c, value, x, y, size):
    """The QR straight onto the page: each row's dark run as one rectangle, in
    one path (13 Nov 2026: the drawing widget took 79 s for the whole store)."""
    qr = QRCode(None, QRErrorCorrectLevel.M)
    qr.addData(value)
    # One fixed mask (any of the eight is a valid QR) instead of trying all
    # eight for the "best" one: eight times faster over a whole store.
    qr.version = qr.calculate_version()
    qr.makeImpl(False, 0)
    n = qr.getModuleCount()
    m = size / (n + 2)                               # a one-module quiet zone each side
    # In module units (whole numbers) straight into the page's content stream:
    # formatting thousands of float rectangles was most of the time.
    runs = []
    for r in range(n):
        col = 0
        while col < n:
            if qr.isDark(r, col):
                start = col
                while col < n and qr.isDark(r, col):
                    col += 1
                runs.append(f"{start + 1} {r + 1} {col - start} 1 re")
            else:
                col += 1
    c.saveState()
    c.setFillGray(0)
    # Top-left origin, y down, one unit = one module.
    c.transform(m, 0, 0, -m, x, y + size)
    c._code.append(" ".join(runs) + " f")
    c.restoreState()


def build(parts, title, subtitle=""):
    """The PDF's bytes. `parts` are Part rows (or anything with part_no,
    part_name, specification, location, barcode)."""
    buf = io.BytesIO()
    page_w, page_h = A4
    c = canvas.Canvas(buf, pagesize=A4)
    c.setTitle(title)
    cell_w = (page_w - 2 * MARGIN) / COLS
    cell_h = (page_h - 2 * MARGIN - HEAD) / ROWS
    per_page = COLS * ROWS
    pages = max(1, -(-len(parts) // per_page))
    stamp = datetime.now().strftime("%d.%m.%Y %H:%M")
    for page in range(pages):
        c.setFont("Helvetica-Bold", 12)
        c.drawString(MARGIN, page_h - MARGIN - 5 * mm, title)
        c.setFont("Helvetica", 8)
        c.drawRightString(page_w - MARGIN, page_h - MARGIN - 5 * mm, f"{len(parts)} parts · {stamp}")
        if subtitle:
            c.drawString(MARGIN, page_h - MARGIN - 9.5 * mm, subtitle)
        c.drawRightString(page_w - MARGIN, MARGIN - 5 * mm, f"Page {page + 1} of {pages}")
        for i, p in enumerate(parts[page * per_page:(page + 1) * per_page]):
            col, row = i % COLS, i // COLS
            x = MARGIN + col * cell_w
            y = page_h - MARGIN - HEAD - (row + 1) * cell_h
            c.setLineWidth(0.4)
            c.setStrokeGray(0.75)
            c.roundRect(x + 1 * mm, y + 1 * mm, cell_w - 2 * mm, cell_h - 2 * mm, 2 * mm)
            value = (p.barcode or p.part_no or "").strip()
            _qr(c, value, x + 2.5 * mm, y + (cell_h - QR) / 2, QR)
            tx = x + 4 * mm + QR
            tw = cell_w - (tx - x) - 3 * mm
            ty = y + cell_h - 6.5 * mm
            c.setFillGray(0)
            c.setFont("Helvetica-Bold", 10)
            c.drawString(tx, ty, (p.part_no or "")[:24])
            ty -= 4.2 * mm
            c.setFont("Helvetica", 7)
            for line in _wrap(p.part_name, "Helvetica", 7, tw, 3):
                c.drawString(tx, ty, line)
                ty -= 3.2 * mm
            c.setFont("Helvetica", 6.5)
            c.setFillGray(0.3)
            for label, text in (("Model No", p.specification), ("Location", p.location)):
                if text and ty > y + 3 * mm:
                    c.drawString(tx, ty, _wrap(f"{label}: {text}", "Helvetica", 6.5, tw, 1)[0])
                    ty -= 3 * mm
            c.setFillGray(0)
        c.showPage()
    c.save()
    return buf.getvalue()
