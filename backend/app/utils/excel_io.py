"""Shared Excel import/export helpers used by every Master page (Part,
Supplier, BOM today — drop-in for future masters). Bulk import collects a
per-row success/error report instead of failing the whole file on one bad
row, and defers the DB commit to the end for bulk-import performance on
large files.

Excel is the ingestion path today; once ERP APIs are live, only the route
that calls `bulk_import` needs to change to accept an API payload instead
of a file — `row_processor` (the per-row validation + create logic) stays
the same, so no UI/service redesign is needed later."""
import csv
import io
import re
from openpyxl import Workbook, load_workbook

# Uploads get sniffed by magic bytes, not by file extension — ERP and MES
# exports routinely hand out an old .xls, or a plain CSV, under a .xlsx name,
# and trusting the name meant openpyxl blew up on a file we could actually
# read. Exports are still always written as .xlsx.
_ZIP_MAGIC = b"PK\x03\x04"          # .xlsx / .xlsm (an OOXML zip)
_OLE2_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"  # .xls (Excel 97-2003)


class AmbiguousSheetError(ValueError):
    """More than one sheet in the workbook carries the required columns.

    Raised rather than picking one: a plant report keeps several months in
    one file ("30 MAY-25" and "JULY" both have Part No + Total Qty), and
    guessing would silently post a two-month-old count as today's. Carries
    the candidate names so the caller can ask which one."""

    def __init__(self, sheet_names):
        self.sheet_names = list(sheet_names)
        names = ", ".join(f"'{n}'" for n in self.sheet_names)
        super().__init__(
            f"This workbook has {len(self.sheet_names)} sheets with the required "
            f"columns ({names}). Choose which sheet to import."
        )


def normalize_header(text):
    """Strips everything but letters/digits, so a template header with a
    parenthetical hint (e.g. "Category (BOP/Import/...)") still matches its
    plain alias ("category") — parens/slashes previously survived
    normalization and silently broke column matching for any header with
    that kind of hint."""
    return re.sub(r"[^a-z0-9]", "", str(text or "").strip().lower())


def match_columns(header_row, field_aliases, required_fields):
    """field_aliases: {field_name: (alias1, alias2, ...)}. Returns
    {field_name: column_index}. Raises ValueError listing missing
    required fields.

    Aliases are tried in the order given, so pass an ordered sequence
    whenever a real sheet could satisfy two of them at once — a report with
    both "Total Qty" and "Total Store Rack Qty" columns must not have the
    winner decided by set iteration order.

    Matches exact first, then falls back to "normalized header starts
    with alias" — so a template header with a parenthetical hint after
    the field name (e.g. "Category (BOP/Import/...)") still matches its
    plain alias ("category") without needing an exact-only alias list."""
    normalized = {normalize_header(cell): idx for idx, cell in enumerate(header_row)}
    columns = {}
    for field, aliases in field_aliases.items():
        for alias in aliases:
            if alias in normalized:
                columns[field] = normalized[alias]
                break
        else:
            for alias in aliases:
                match = next((idx for header, idx in normalized.items() if header.startswith(alias)), None)
                if match is not None:
                    columns[field] = match
                    break
    missing = [f for f in required_fields if f not in columns]
    if missing:
        # Field names are internal snake_case; show them the way they read on
        # the template header instead.
        labels = ", ".join(f.replace("_", " ").title() for f in missing)
        raise ValueError(f"Excel is missing required column(s): {labels}")
    return columns


def _sheets_from_xlsx(data):
    try:
        wb = load_workbook(io.BytesIO(data), data_only=True)
    except Exception as exc:  # noqa: BLE001 - openpyxl raises several types here
        raise ValueError(
            "This looks like an .xlsx file but could not be opened. It may be "
            "password-protected, or saved as 'Strict Open XML Spreadsheet' — "
            "open it in Excel and re-save as plain 'Excel Workbook (.xlsx)'."
        ) from exc
    return [(ws.title, lambda ws=ws: ws.iter_rows(values_only=True)) for ws in wb.worksheets]


def _sheets_from_xls(data):
    try:
        import xlrd
    except ImportError as exc:
        raise ValueError(
            "This is an old .xls workbook and the .xls reader is not installed. "
            "Open it in Excel and re-save as 'Excel Workbook (.xlsx)'."
        ) from exc
    try:
        book = xlrd.open_workbook(file_contents=data)
    except Exception as exc:  # noqa: BLE001 - xlrd raises several types here
        raise ValueError(
            "Could not read this .xls workbook. Open it in Excel and re-save as "
            "'Excel Workbook (.xlsx)'."
        ) from exc

    def rows(sheet):
        # xlrd gives "" for blank cells where openpyxl gives None; normalize so
        # the blank-row skip and to_number/to_text defaults behave identically.
        return (
            tuple(v if v != "" else None for v in sheet.row_values(i))
            for i in range(sheet.nrows)
        )

    return [(sh.name, lambda sh=sh: rows(sh)) for sh in book.sheets()]


def _decode_text(data):
    if data.startswith(b"\xff\xfe") or data.startswith(b"\xfe\xff"):
        return data.decode("utf-16")
    if b"\x00" in data[:4096]:
        raise ValueError(
            "This file is not a spreadsheet we can read. Supported formats are "
            ".xlsx, .xls and .csv."
        )
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError(
        "This file is not a spreadsheet we can read. Supported formats are "
        ".xlsx, .xls and .csv."
    )


def _rows_from_csv(data):
    text = _decode_text(data)
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel  # single-column file, or too little to sniff
    return (
        tuple(v if v.strip() != "" else None for v in row)
        for row in csv.reader(io.StringIO(text), dialect)
    )


def sheets_from_upload(file_stream):
    """Returns [(sheet_name, rows_factory)] for the uploaded file, picking the
    reader off the file's magic bytes rather than its name.

    Every sheet comes back, not just the first: plant reports keep months side
    by side in one workbook ("30 MAY-25", "JULY", "Stock Formate", ...), and
    blindly taking sheet 1 would have imported a two-month-old count as
    today's. Each entry is a factory so the header can be probed and the
    winning sheet then read from the top."""
    data = file_stream.read()
    if not data:
        raise ValueError("The uploaded file is empty.")
    if data.startswith(_ZIP_MAGIC):
        return _sheets_from_xlsx(data)
    if data.startswith(_OLE2_MAGIC):
        return _sheets_from_xls(data)
    return [("(csv)", lambda: _rows_from_csv(data))]


# Real count sheets are rarely header-on-row-1: they open with a plant name,
# a date caption, a logo row or a blank line or two. Scan this far in for the
# row that actually carries the required columns before giving up.
_HEADER_SCAN_ROWS = 15


def _find_header(rows_iter, field_aliases, required_fields):
    """Consumes rows up to and including the header row. Returns
    (header_row_no, {field: column_index})."""
    seen = []
    for row_no, row in enumerate(rows_iter, start=1):
        if row is not None and any(v is not None for v in row):
            seen.append((row_no, row))
            try:
                return row_no, match_columns(row, field_aliases, required_fields)
            except ValueError:
                pass  # not this row — keep looking
        if row_no >= _HEADER_SCAN_ROWS:
            break

    if not seen:
        raise ValueError("The uploaded file has no rows.")
    # Echo back the first few rows as read. A report exported from another
    # system usually buries its header under a title/date banner, and seeing
    # exactly what landed is the difference between "rename your columns" and
    # a guessing game.
    wanted = ", ".join(f.replace("_", " ").title() for f in required_fields)
    preview = "; ".join(
        f"row {no}: {', '.join(str(v) for v in row if v is not None)[:80]}"
        for no, row in seen[:5]
    )
    raise ValueError(
        f"Could not find the required column(s): {wanted}. Checked the first "
        f"{len(seen)} non-empty row(s) — {preview}. Rename the header columns to "
        "match, or start from Download Template."
    )


def read_rows(file_stream, field_aliases, required_fields, sheet_name=None):
    """Returns an iterator of (row_no, {field: raw_value}) over every
    non-empty data row. Accepts .xlsx, .xls and .csv.

    Deliberately not a generator: reading the file and locating the header
    run eagerly, so anything wrong with the file as a whole raises here at
    the call site instead of part-way through the caller's loop — where it
    would escape the per-row error handling and surface as an unhandled 500
    (see bulk_import)."""
    sheets = sheets_from_upload(file_stream)
    if sheet_name:
        sheets = [(n, f) for n, f in sheets if n == sheet_name]
        if not sheets:
            raise ValueError(f"This workbook has no sheet named '{sheet_name}'.")

    matches = []
    misses = []
    for name, make_rows in sheets:
        try:
            header_no, columns = _find_header(iter(make_rows()), field_aliases, required_fields)
            matches.append((name, make_rows, header_no, columns))
        except ValueError as exc:
            misses.append((name, str(exc)))

    if len(matches) > 1:
        raise AmbiguousSheetError(m[0] for m in matches)
    if not matches:
        if len(misses) == 1:
            raise ValueError(misses[0][1])
        detail = " | ".join(f"'{name}': {reason}" for name, reason in misses[:3])
        raise ValueError(f"No sheet in this workbook has the required columns. {detail}")

    name, make_rows, header_no, columns = matches[0]
    rows = iter(make_rows())
    for _ in range(header_no):  # replay past the header row located above
        next(rows, None)
    return _iter_data_rows(rows, columns, header_no + 1)


def _iter_data_rows(rows_iter, columns, start_row):
    for row_no, row in enumerate(rows_iter, start=start_row):
        if row is None or all(v is None for v in row):
            continue
        # CSV and .xls drop trailing empty cells, so a short row is normal and
        # must read as blank rather than blowing up on the index.
        yield row_no, {
            field: (row[idx] if idx < len(row) else None) for field, idx in columns.items()
        }


def bulk_import(file_stream, field_aliases, required_fields, row_processor, sheet_name=None):
    """row_processor(raw_row) does its own validation + `db.session.add(...)`
    per row (no commit), raising ValueError(message) on a bad row. Returns
    a report dict; commits once at the end."""
    from app.extensions import db
    from app.utils.exceptions import BadRequestError

    try:
        rows = read_rows(file_stream, field_aliases, required_fields, sheet_name)
    except AmbiguousSheetError as exc:
        # Structured so the caller can render a sheet picker instead of
        # making the user delete sheets out of the source workbook.
        raise BadRequestError(str(exc), errors={"sheets": exc.sheet_names}) from exc
    except ValueError as exc:
        # Unreadable/empty file or a missing required column — wrong with the
        # file as a whole, so there is no row to attach it to. Surface it as a
        # 400 carrying the reason; without this it reached the catch-all
        # handler and the user got a bare "An unexpected error occurred" with
        # no clue what to fix.
        raise BadRequestError(str(exc)) from exc

    total = 0
    created = 0
    errors = []
    for row_no, raw_row in rows:
        total += 1
        try:
            row_processor(raw_row)
            created += 1
        except ValueError as e:
            errors.append({"row": row_no, "reason": str(e)})
        except Exception as e:  # noqa: BLE001 - keep one bad row from failing the whole batch
            errors.append({"row": row_no, "reason": f"Unexpected error: {e}"})
    db.session.commit()
    return {"total_rows": total, "created": created, "error_count": len(errors), "errors": errors}


def build_template(columns):
    """columns: list of header labels. Returns a header-only BytesIO xlsx.

    Deliberately no sample row: these templates used to ship one, and
    downloading a template and uploading it back unchanged then imported the
    sample as a real record (a part literally named "Example Part Name").
    The header alone is what the importer matches on, so the sample bought
    nothing that was worth that."""
    wb = Workbook()
    ws = wb.active
    ws.append(columns)
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


def to_number(value, default=None):
    if value is None:
        return default
    if isinstance(value, str):
        # CSV and .xls hand every cell over as text, and exports commonly carry
        # thousands separators ("1,234") that float() would reject row by row.
        value = value.strip().replace(",", "")
        if value == "":
            return default
    return float(value)


def to_text(value, default=""):
    if value is None:
        return default
    return str(value).strip()


# Excel/CSV formula-injection guard. A cell whose text begins with one of these
# is treated by Excel/LibreOffice as a formula when the sheet is opened — so a
# value imported from an untrusted vendor/ERP sheet (=HYPERLINK(...), =cmd|...,
# =WEBSERVICE(...)) could fire in whoever later opens our export. Prefixing a
# single quote forces the cell to be read as literal text.
_FORMULA_LEAD = ("=", "+", "-", "@", "\t", "\r")


def _excel_safe(value):
    if isinstance(value, str) and value and value[0] in _FORMULA_LEAD:
        return "'" + value
    return value


def build_export(columns, rows):
    """columns: list of (header_label, dict_key). rows: list of dicts."""
    wb = Workbook()
    ws = wb.active
    ws.append([label for label, _ in columns])
    for row in rows:
        ws.append([_excel_safe(row.get(key, "")) for _, key in columns])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf
