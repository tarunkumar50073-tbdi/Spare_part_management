"""Data Browser — every table of the app's database, READ ONLY, for an
administrator (the store, 27 Oct 2026: "mere db me kon kon se table bani huyi h
and unme ko kon sa data h ye meri app me add ho sakta h taaki agar jarurat pade
to dekh sake" -> "haan data browser bana de").

What it does: lists the tables (grouped, with what each holds and how many
rows), shows a table's rows a page at a time with search and sort, and
downloads them to Excel. Nothing can be changed from here: every read runs in a
read-only transaction on PostgreSQL, tables and columns are only those the
database itself reports (no name from the request reaches SQL unchecked), and
values go out as text.

Never shown: passwords, password hashes, tokens, keys, secrets, captchas — any
column whose name says so, and the same names inside a JSON setting
(app_settings.value) — each shows as "hidden". Binary data shows its size only.
"""
import io
import json
import re
from datetime import date, datetime
from decimal import Decimal

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from sqlalchemy import MetaData, String, Table, cast, func, inspect, or_, select, text

from app.extensions import db
from app.utils.exceptions import BadRequestError, NotFoundError

HIDDEN = "•••• hidden"
SECRET = re.compile(r"pass(word)?|pwd|secret|token|api_?key|hash|otp|salt|captcha|private_?key|credential", re.I)
PAGE_MAX = 200
EXPORT_MAX = 100_000
CELL_MAX = 300           # characters of one cell on screen (the download has it whole)

# What each table holds, by group — the store reads this list, so plain words.
# A table not named here is listed under "Other".
GROUPS = (
    ("Spare store", {
        "parts": "Part Master — every part, its levels, location, rate",
        "spare_stock": "Physical stock of each part (In Stock)",
        "spare_stock_ledger": "Every stock movement: issue, receipt, return, count, adjustment",
        "spare_transactions": "Journal of every step (issue, return, install …), never changed",
        "spare_returns": "Returns against an issue (fresh / job work)",
        "spare_location_history": "Location changes of parts",
        "spare_batches": "Receipt batches for packets (GRN / opening)",
        "spare_packets": "Packets and individual units with their own QR",
        "put_away_log": "Put-away confirmations",
        "label_print_audit": "Label prints and reprints",
        "part_barcodes": "Barcodes mapped to parts (supplier codes)",
        "daily_stock_counts": "Daily stock counts",
        "scan_audit": "Every scan on Scan Part",
        "rgp_return_links": "Job work return linked to its ERP RGP",
        "part_requests": "Old kiosk part requests (kiosk removed)",
        "spare_receipts": "Old in-app receipts",
        "spare_rgps": "Old in-app RGPs (RGP is made in ERP now)",
        "challan_register": "Urgent challan register",
        "challan_register_history": "Urgent challan changes",
        "challan_register_links": "Urgent challan ↔ GRN links",
        "rejection_requests": "Rejection mail drafts",
        "rejection_request_history": "Rejection mail history",
        "sections": "Sections of each store",
        "stores": "Stores (Plant / store master)",
        "departments": "Department master",
        "employees": "People parts are issued to (from the Maintenance / Tool Room rosters)",
    }),
    ("ERP copy (read from ERP)", {
        "gate_entries": "ERP gate entries",
        "receiving_register": "ERP GRN register (srv_report)",
        "erp_stock": "ERP stock per part",
        "erp_line_rejections": "ERP line rejection slips",
        "erp_rgp_lines": "ERP RGPs (returnable gate pass)",
        "current_stock": "Old ERP stock table (not used)",
        "pending_grn": "Old pending GRN table",
        "stock_valuation": "Old stock valuation table",
        "rgps": "Old ERP RGP table",
    }),
    ("Users, mail & settings", {
        "users": "App logins and their rights (passwords hidden)",
        "user_store_access": "Which stores each login may open",
        "app_settings": "App settings (secrets hidden)",
        "login_attempts": "Wrong login tries",
        "audit_logs": "Audit trail of changes",
        "email_messages": "Mails made by the app",
        "email_attempts": "Mail send attempts",
        "email_attachments": "Mail attachments",
        "mail_send_logs": "Mail send log",
        "department_recipients": "Who gets which department mail",
        "report_recipients": "Report mail recipients",
        "notifications": "In-app notifications",
        "notification_state": "Notification read state",
        "dashboard_snapshots": "Daily dashboard snapshots",
    }),
    ("Child Part store (older module)", {
        "boms": "Bills of material", "customer_forecasts": "Customer forecasts",
        "finished_goods": "Finished goods", "production_receipts": "Production receipts",
        "srvs": "SRV workflow", "srv_scan_events": "SRV scans", "part_stock": "Child part stock",
        "stock_ledger": "Child part stock ledger", "rack_bins": "Rack / bin master",
        "holding_entries": "Holding area", "milkrun_groups": "Milkrun groups",
        "supplier_milkrun_mapping": "Supplier ↔ milkrun", "supplier_vehicle_windows": "Supplier vehicle windows",
        "supplier_window_schedules": "Supplier window schedules", "suppliers": "Supplier master",
        "part_suppliers": "Part ↔ supplier", "equipment": "Equipment", "quarterly_inventory": "Quarterly inventory",
        "physical_stock": "Physical stock (child parts)", "gate_exits": "Gate exits",
        "part_import_history": "Part imports",
    }),
)
ABOUT = {t: (g, d) for g, tables in GROUPS for t, d in tables.items()}
GROUP_ORDER = [g for g, _ in GROUPS] + ["Other"]


def _plain(v, limit=None):
    """A value as the screen and the file show it (text, numbers, dates)."""
    if v is None:
        return None
    if isinstance(v, (bytes, bytearray, memoryview)):
        return f"[binary {len(bytes(v)):,} bytes]"
    if isinstance(v, Decimal):
        v = float(v)
    if isinstance(v, float):
        return int(v) if v.is_integer() else round(v, 4)
    if isinstance(v, (int, bool)):
        return v
    if isinstance(v, (datetime, date)):
        return v.isoformat(sep=" ", timespec="minutes") if isinstance(v, datetime) else v.isoformat()
    t = str(v)
    return t[:limit] + "…" if limit and len(t) > limit else t


def _mask_json(v):
    if isinstance(v, dict):
        return {k: (HIDDEN if SECRET.search(str(k)) else _mask_json(x)) for k, x in v.items()}
    if isinstance(v, list):
        return [_mask_json(x) for x in v]
    return v


class DataBrowserService:

    @staticmethod
    def _read_only(conn):
        if conn.dialect.name == "postgresql":
            conn.execute(text("SET TRANSACTION READ ONLY"))

    def tables(self):
        """Every table: its group, what it holds, its row count, its columns."""
        insp = inspect(db.engine)
        names = sorted(insp.get_table_names())
        out = []
        with db.engine.connect() as conn:
            self._read_only(conn)
            for name in names:
                t = Table(name, MetaData())
                rows = conn.execute(select(func.count()).select_from(t)).scalar()
                group, about = ABOUT.get(name, ("Other", ""))
                out.append({"name": name, "group": group, "about": about, "rows": rows,
                            "columns": len(insp.get_columns(name))})
        out.sort(key=lambda x: (GROUP_ORDER.index(x["group"]), x["name"]))
        return {"tables": out, "groups": GROUP_ORDER, "total_rows": sum(x["rows"] for x in out)}

    @staticmethod
    def _table(name):
        if name not in set(inspect(db.engine).get_table_names()):
            raise NotFoundError(f"No table '{name}'")
        return Table(name, MetaData(), autoload_with=db.engine)

    @staticmethod
    def _hidden(table, column):
        return bool(SECRET.search(column))

    def _cell(self, table, column, v, limit):
        if v is None:
            return None
        if self._hidden(table, column):
            return HIDDEN
        if table == "app_settings" and column == "value":
            try:
                v = json.dumps(_mask_json(json.loads(v)), ensure_ascii=False)
            except (TypeError, ValueError):
                pass
        return _plain(v, limit)

    def _query(self, t, q, sort, desc):
        stmt = select(t)
        text_ = (q or "").strip()
        if text_:
            like = f"%{text_}%"
            cols = [c for c in t.columns if not self._hidden(t.name, c.name)]
            stmt = stmt.where(or_(*[cast(c, String).ilike(like) for c in cols]))
        if sort:
            if sort not in t.columns:
                raise BadRequestError(f"No column '{sort}' in {t.name}")
            col = t.columns[sort]
            stmt = stmt.order_by(col.desc() if desc else col.asc())
        elif "id" in t.columns:
            stmt = stmt.order_by(t.columns["id"].desc())
        return stmt

    def rows(self, name, q=None, sort=None, desc=False, page=1, page_size=50):
        t = self._table(name)
        size = max(1, min(int(page_size or 50), PAGE_MAX))
        page = max(1, int(page or 1))
        stmt = self._query(t, q, sort, desc)
        with db.engine.connect() as conn:
            self._read_only(conn)
            total = conn.execute(select(func.count()).select_from(stmt.order_by(None).subquery())).scalar()
            got = conn.execute(stmt.limit(size).offset((page - 1) * size)).mappings().all()
        cols = [c.name for c in t.columns]
        group, about = ABOUT.get(name, ("Other", ""))
        return {
            "name": name, "group": group, "about": about,
            "columns": [{"name": c.name, "type": str(c.type), "hidden": self._hidden(name, c.name)} for c in t.columns],
            "rows": [{c: self._cell(name, c, r[c], CELL_MAX) for c in cols} for r in got],
            "total": total, "page": page, "pages": max(1, -(-total // size)), "page_size": size,
        }

    def export(self, name, q=None, sort=None, desc=False):
        """(xlsx bytes, file name) of the table — every matching row up to EXPORT_MAX, secrets hidden."""
        t = self._table(name)
        stmt = self._query(t, q, sort, desc).limit(EXPORT_MAX)
        cols = [c.name for c in t.columns]
        wb = Workbook()
        ws = wb.active
        ws.title = name[:31]
        ws.append(cols)
        for cell in ws[1]:
            cell.font = Font(name="Arial", bold=True, color="FFFFFF")
            cell.fill = PatternFill("solid", fgColor="1F2A44")
        with db.engine.connect() as conn:
            self._read_only(conn)
            for r in conn.execute(stmt).mappings():
                ws.append([self._cell(name, c, r[c], None) for c in cols])
        ws.freeze_panes = "A2"
        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        return buf, f"{name}.xlsx"
