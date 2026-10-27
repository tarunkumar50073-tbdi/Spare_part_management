"""The Spare Parts Store dashboard in ONE response.

The dashboard used to assemble itself from ~15 requests (summary, below-minimum,
today, flow, pending, activity, excess, not-counted, analytics, three
consumption splits, the month comparison, ...), several of which rebuilt the
same ~4,800-row stock list. This service builds the list once and answers the
questions the dashboard exists for, server-side:

    WHAT is wrong   -> `attention`  (severity-ordered, with counts and money)
    WHERE is it     -> each attention item's worst `sections`
    HOW serious     -> `severity` + `value` (to restock / tied up in excess)
    WHAT to do      -> each item's `action` (the screen + filter that fixes it)

Everything is read from real rows. Nothing is estimated or back-filled: a
figure the data can't support is left out or returned as None, never shown as
a confident zero.

Material the store holds but may not issue is never folded into on-hand:
`receiving_pending` (ERP GRN lines quality has not cleared in ERP — receiving
is read from ERP, with the mirror's freshness), `returns_pending` (returns
waiting for the store inspection) and `rgp` (supplier rework), the last two
from the store's own documents (models/spare_flow.py).
"""
from datetime import date, datetime, timezone

from sqlalchemy import and_, case, func

from app.extensions import db
from app.models.base import utcnow
from app.models.part import Part
from app.models.spare_flow import RETURN_OPEN, RGP_OPEN, SpareReturn, SpareRgp
from app.models.store import Section, Store
from app.services.erp_grn_posting_service import ErpGrnPostingService
from app.services.spare_stock_service import SpareStockService

# Worst first — the order the health bar and the attention list read in.
STATUS_ORDER = ("Out of Stock", "Below Minimum", "Reorder", "Above Maximum", "Healthy", "Discontinued",
                "Not Counted")

# An ERP stock snapshot older than this is reported STALE (same window the
# scan screen's data-status badge uses).
STALE_AFTER_HOURS = 24

_TOP = 10


def _money(v):
    return round(v, 2) if v else 0.0


def _q(v):
    return round(float(v or 0), 2)


def _iso_utc(value):
    """A stored UTC time (naive from SQLite) as an aware ISO string, so the
    browser shows it in local time."""
    if value is None:
        return None
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value)
        except ValueError:
            return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _as_date(value):
    if value is None or isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _erp_as_of(erp):
    """The ERP GRN mirror's freshness (ErpGrnPostingService.mirror_freshness)
    as a sentence on the plant clock, so a figure read from a stale mirror is
    never taken for today's."""
    synced = (erp or {}).get("synced_at")
    if not synced:
        return "No ERP GRN data has been read yet."
    at = datetime.fromisoformat(synced)
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    text = f"ERP GRN data as read {at.astimezone().strftime('%d %b %Y %H:%M')}"
    newest = _as_date(erp.get("newest_grn_date"))
    if newest:
        text += f", newest GRN {newest.strftime('%d %b %Y')}"
    return text + "."


class SpareDashboardService:
    def __init__(self):
        self.stock = SpareStockService()
        self.erp_grn = ErpGrnPostingService()

    # ------------------------------------------------------------------ public

    def overview(self, store_code, section_id=None, section_ids=None):
        """A store's dashboard, or one section's, or a section GROUP's. When
        section_ids (a set/list) is given it scopes everything to that group
        (Tool Room = Press Tool Room + General Tool Room) and takes precedence
        over section_id; neither = the whole store. section_ids threads through
        every panel so the group's figures are real, not the store's."""
        rows = self.stock.list_stock(store_code, section_id, section_ids=section_ids)
        names = self._section_names(store_code)
        agg = self._aggregate(rows)
        receiving = self._receiving_pending(store_code, section_id, section_ids)

        return {
            "store_code": store_code,
            "section_id": section_id,
            "section_ids": sorted(section_ids) if section_ids else None,
            "generated_at": utcnow().replace(tzinfo=timezone.utc).isoformat(),
            "kpis": {
                "total_parts": len(rows),
                "counted_parts": agg["counted"],
                "uncounted_parts": len(rows) - agg["counted"],
                "total_qty": round(agg["qty"], 2),
                "stock_value": _money(agg["value"]),
                "valued_parts": agg["valued"],
                "today": self._today(store_code, section_id, section_ids),
            },
            "health": [
                {
                    "status": s,
                    "count": agg["by_status"][s]["count"],
                    "pct": round(agg["by_status"][s]["count"] / len(rows) * 100, 1) if rows else None,
                    "value": _money(agg["by_status"][s]["value"]),
                }
                for s in STATUS_ORDER
            ],
            "attention": self._attention(store_code, section_id, agg, names, receiving, section_ids),
            "value": {
                "total": _money(agg["value"]),
                "by_section": sorted(
                    ({"section_id": sid, "name": names.get(sid, "Unassigned"),
                      "value": _money(v["value"]), "parts": v["parts"]}
                     for sid, v in agg["by_section"].items() if v["value"]),
                    key=lambda r: -r["value"]),
                # Part type (sub_category) — `category` is one value for every
                # spare, so it would chart as a single bar. Top 8 + the rest.
                "by_type": _top_n(agg["by_type"], 8),
                "to_restock": _money(agg["restock_value"]),
                "excess": _money(agg["excess_value"]),
            },
            "critical_parts": self._critical(rows, names),
            "excess_parts": self._excess(rows, names),
            "consumption": self._consumption(store_code, section_id, section_ids),
            "recent_activity": self._recent(store_code, section_id, section_ids),
            "erp": self._erp(store_code),
            "data_quality": agg["quality"],
            # Held by the store, not issuable — each from its own documents.
            "receiving_pending": receiving,
            "returns_pending": self._returns_pending(store_code, section_id, section_ids),
            "rgp": self._rgp(store_code, section_id, section_ids),
        }

    # --------------------------------------------------------------- building

    @staticmethod
    def _section_names(store_code):
        return {
            sid: name for sid, name in
            db.session.query(Section.id, Section.name)
            .join(Store, Store.id == Section.store_id)
            .filter(Store.code == store_code)
        }

    @staticmethod
    def _scope_clause(section_id, section_ids):
        """A SQLAlchemy WHERE clause scoping Part.section_id to a group (several
        sections), one section, or None (whole store). Group wins over a single
        section — the same precedence list_stock uses."""
        if section_ids:
            return Part.section_id.in_(list(section_ids))
        if section_id is not None:
            return Part.section_id == section_id
        return None

    @staticmethod
    def _aggregate(rows):
        by_status = {s: {"count": 0, "value": 0.0} for s in STATUS_ORDER}
        by_section = {}
        by_type = {}
        # Per attention status, which sections hold the parts (the "where").
        where = {s: {} for s in ("Out of Stock", "Below Minimum", "Reorder", "Above Maximum", "Not Counted")}
        counted = valued = 0
        qty = value = restock_value = excess_value = 0.0
        miss = {"max": 0, "min": 0, "reorder": 0, "rate": 0, "location": 0}
        reorder_outside = 0

        for r in rows:
            st = r["status"]
            q = r["qty_on_hand"]
            rate = r["unit_price"]
            sv = r["stock_value"] or 0.0
            by_status[st]["count"] += 1
            by_status[st]["value"] += sv
            sec = by_section.setdefault(r["section_id"], {"value": 0.0, "parts": 0})
            sec["parts"] += 1
            sec["value"] += sv
            ty = by_type.setdefault((r["sub_category"] or "").strip() or "Uncategorised", {"value": 0.0, "parts": 0})
            ty["parts"] += 1
            ty["value"] += sv
            if st in where:
                where[st][r["section_id"]] = where[st].get(r["section_id"], 0) + 1
            if q is not None:
                counted += 1
                qty += q
            if r["stock_value"] is not None:
                valued += 1
                value += r["stock_value"]
            # Money to get the short parts back up to their maximum (the same
            # "order qty" the reorder list and its Excel use), and the money
            # sitting above maximum.
            if st in ("Out of Stock", "Below Minimum", "Reorder") and rate:
                need = r["shortfall"]
                if need is None:
                    gap = (r["min_stock_level"] or 0) - (q or 0)
                    need = gap if gap > 0 else None
                if need:
                    restock_value += need * rate
            if st == "Above Maximum" and rate and r["max_stock_level"]:
                excess_value += (q - r["max_stock_level"]) * rate

            mx, mn, ro = r["max_stock_level"], r["min_stock_level"], r["reorder_level"]
            # A discontinued part needs no levels: none is "missing".
            levels_due = not r.get("discontinued")
            if levels_due and not mx:
                miss["max"] += 1
            if levels_due and not mn:
                miss["min"] += 1
            if levels_due and ro is None:
                miss["reorder"] += 1
            if rate is None:
                miss["rate"] += 1
            if not (r["location"] or "").strip():
                miss["location"] += 1
            if ro is not None and mx and mn and not (mn <= ro <= mx):
                reorder_outside += 1

        n = len(rows)
        # Completeness = share of the planning fields filled across all parts
        # (max, min, reorder, rate, location — five per part).
        filled = n * 5 - sum(miss.values())
        return {
            "by_status": by_status, "by_section": by_section, "by_type": by_type, "where": where,
            "counted": counted, "valued": valued, "qty": qty, "value": value,
            "restock_value": restock_value, "excess_value": excess_value,
            "quality": {
                "parts": n,
                "completeness_pct": round(filled / (n * 5) * 100, 1) if n else None,
                "missing_max": miss["max"],
                "missing_min": miss["min"],
                "missing_reorder": miss["reorder"],
                "missing_rate": miss["rate"],
                "missing_location": miss["location"],
                "never_counted": n - counted,
                "reorder_outside_min_max": reorder_outside,
            },
        }

    def _attention(self, store_code, section_id, agg, names, receiving, section_ids=None):
        """Severity-ordered problems. An item is listed even at zero — "no part
        is out of stock" is a reading worth seeing, not an absence to hide."""
        # The store-level lines (GRN/quality, ERP-pending) belong only to the
        # true whole-store view — not a single section, and not a group either.
        store_level = section_id is None and not section_ids
        def where(status):
            counts = agg["where"][status]
            return [
                {"section_id": sid, "name": names.get(sid, "Unassigned"), "count": c}
                for sid, c in sorted(counts.items(), key=lambda kv: -kv[1])[:3]
            ]

        def stock_item(key, label, status, severity, hint, value=None, value_label=None):
            return {
                "key": key, "label": label, "severity": severity, "hint": hint,
                "count": agg["by_status"][status]["count"],
                "value": _money(value) if value is not None else None,
                "value_label": value_label,
                "sections": where(status),
                "action": {"label": "Open list", "to": "/store-stock-spare", "status": status},
            }

        # Restock money split by status, so each line quotes its own spend.
        items = [
            stock_item("zero_stock", "Zero stock", "Out of Stock", "critical",
                       "Counted and found empty — nothing to issue"),
            stock_item("below_min", "Below minimum", "Below Minimum", "critical",
                       "Under the planned minimum — order now"),
            stock_item("reorder", "At reorder level", "Reorder", "warning",
                       "At or below the reorder point — raise the indent"),
            stock_item("excess", "Above maximum", "Above Maximum", "warning",
                       "Money tied up above the planned maximum",
                       value=agg["excess_value"], value_label="tied up above max"),
        ]
        # The restock spend belongs to the short lines as a group; quote it once,
        # on the first of them, rather than split by a rule the data doesn't hold.
        items[0]["value"] = _money(agg["restock_value"])
        items[0]["value_label"] = "to restock all short parts to max"

        if store_level:
            # Spec 1: a spare has no separate SRV step. What this line used to
            # count (SRV records) is now the ERP GRN lines whose quality ERP
            # has not cleared — receiving is read from ERP. The key stays
            # "srv_pending" so every screen reading it (the wallboard tile
            # included) keeps working; like before, it is a store-level line.
            items.append({
                "key": "srv_pending", "label": "GRN / Quality pending",
                "severity": "warning" if receiving["total"] else "ok",
                "hint": ("ERP GRN lines waiting for the Maintenance / Tool Room quality clearance in "
                         "ERP — not issuable yet. " + _erp_as_of(receiving["erp"])),
                "count": receiving["total"], "value": None, "value_label": None, "sections": [],
                "action": {"label": "Open Receiving & GRN", "to": "/receiving"},
            })
        items.append(stock_item("never_counted", "Never counted", "Not Counted", "info",
                                "No physical count yet — its status is unknown"))
        erp_pending = self.stock.pending_erp_count(store_code) if store_level else None
        if erp_pending is not None:
            write = self.stock.erp_write_status()
            items.append({
                "key": "erp_pending", "label": "Movements not yet in ERP",
                "severity": "info", "hint": write["reason"],
                "count": erp_pending, "value": None, "value_label": None, "sections": [],
                "action": {"label": "Open Store Stock", "to": "/store-stock-spare"},
            })
        # A zero count is never critical — it is simply "ok".
        for it in items:
            if not it["count"]:
                it["severity"] = "ok"
        return items

    @staticmethod
    def _critical(rows, names):
        order = {"Out of Stock": 0, "Below Minimum": 1}
        crit = [r for r in rows if r["status"] in order]
        # Worst status first; within it, the part whose restock costs most (the
        # dearest gap) — that is the one a manager asks about.
        def cost(r):
            need = r["shortfall"] if r["shortfall"] is not None else max(
                (r["min_stock_level"] or 0) - (r["qty_on_hand"] or 0), 0)
            return -(need * (r["unit_price"] or 0))
        crit.sort(key=lambda r: (order[r["status"]], cost(r)))
        return [_brief(r, names) for r in crit[:_TOP]]

    @staticmethod
    def _excess(rows, names):
        out = []
        for r in rows:
            if r["status"] != "Above Maximum" or not r["max_stock_level"]:
                continue
            ex = round(r["qty_on_hand"] - r["max_stock_level"], 2)
            b = _brief(r, names)
            b["excess_qty"] = ex
            b["excess_value"] = _money(ex * r["unit_price"]) if r["unit_price"] else None
            out.append(b)
        out.sort(key=lambda b: -(b["excess_value"] or 0))
        return out[:_TOP]

    def _today(self, store_code, section_id, section_ids=None):
        t = self.stock.today_movements(store_code, section_id, section_ids=section_ids)
        return {k: t.get(k) for k in ("since", "received_qty", "received_lines",
                                      "issued_qty", "issued_lines")}

    def _consumption(self, store_code, section_id, section_ids=None):
        today = datetime.now().date()
        month_start = today.replace(day=1).isoformat()
        return {
            "comparison": self.stock.consumption_comparison(store_code, section_id, section_ids=section_ids),
            "this_month_by_department": sorted(
                self.stock.consumption_by_department(
                    store_code, section_id, date_from=month_start, date_to=today.isoformat(),
                    section_ids=section_ids),
                key=lambda d: -d["value"])[:5],
            "month_start": month_start,
            "issue_month": self._issue_month(store_code, section_id, section_ids, month_start, today.isoformat()),
            # All-time splits behind the dashboard's three consumption donuts.
            "by_department": self.stock.consumption_by_department(store_code, section_id, section_ids=section_ids),
            "by_machine": self.stock.consumption_by_machine(store_code, section_id, section_ids=section_ids),
            "by_type": self.stock.consumption_by_type(store_code, section_id, section_ids=section_ids),
        }

    @staticmethod
    def _issue_month(store_code, section_id, section_ids, month_start, today):
        """This month's issues for the Live Board's Issue & Consumption panel
        (the store, 22 Oct 2026: "kitna issue hua and kahan consume hua wo data
        mile"): how much went out — issues, qty, ₹, what came back — per
        consuming department, and where it was used: the line / machine the
        fitter recorded on Confirm Installation ("Not recorded yet" until
        then). Read through the Issuance & Consumption Report's own department
        and machine views, so the board and the report never disagree. A
        section group (Tool Room) is read as the department its sections
        belong to."""
        from app.services.consumption_analytics_service import consumer_of, consumers
        from app.services.consumption_table_service import ConsumptionTableService
        one, department = section_id, None
        if section_ids:
            owner, _ = consumers(store_code)
            names = {consumer_of(owner, sid) for sid in section_ids}
            one, department = None, (names.pop() if len(names) == 1 else None)
        tables = ConsumptionTableService()
        args = {"date_from": month_start, "date_to": today, "section_id": one, "department": department}
        by_dept = tables.table(store_code, "department", **args)
        by_place = tables.table(store_code, "machine", **args)

        def figures(row):
            return {"issues": row.get("Issues") or 0, "qty": row.get("Qty Issued") or 0,
                    "value": row.get("Value"), "returned": row.get("Qty Returned") or 0,
                    "net_qty": row.get("Net Qty") or 0, "net_value": row.get("Net Value")}

        def add(a, b):
            # A money figure unknown on both sides (no rate) stays unknown.
            return None if a is None and b is None else round((a or 0) + (b or 0), 2)

        # The department view is one row per department and section: the board
        # wants the department alone.
        depts = {}
        for row in by_dept["rows"][:-1]:
            f, name = figures(row), row.get("Department")
            if name not in depts:
                depts[name] = {"name": name, **f}
                continue
            d = depts[name]
            for key in ("issues", "qty", "returned", "net_qty"):
                d[key] = round(d[key] + f[key], 2)
            for key in ("value", "net_value"):
                d[key] = add(d[key], f[key])
        places = [{"department": row.get("Department"), "line": row.get("Line"), "machine": row.get("Machine"),
                   **figures(row)} for row in by_place["rows"][:-1]]
        places.sort(key=lambda p: (-p["net_qty"], -p["qty"]))
        return {
            "from": month_start, "to": today,
            "total": figures(by_dept["rows"][-1]),
            "departments": sorted(depts.values(), key=lambda d: (-d["qty"], d["name"] or "")),
            "places": places[:6],
            "place_count": len(places),
            "unrated_issues": by_dept["unrated_issues"],
        }

    def _recent(self, store_code, section_id, section_ids=None):
        # A section (or group) reads its own movements out of a wider window.
        scoped = section_id is not None or bool(section_ids)
        rows = self.stock.recent_activity(store_code, 15 if not scoped else 60)
        if section_ids:
            rows = [r for r in rows if r.get("section_id") in section_ids]
        elif section_id is not None:
            rows = [r for r in rows if r.get("section_id") == section_id]
        return rows[:10]

    # ------------------------------------------------ held, not issuable

    def _receiving_pending(self, store_code, section_id, section_ids=None):
        """Receiving is read from ERP (spec 1 / 9, user decision 2026-09-26):
        the store's ERP GRN lines, counted per (part, GRN no.) in the states
        ErpGrnPostingService gives them — quality_pending = GRN created in ERP,
        Maintenance / Tool Room have not accepted it in ERP yet (not issuable);
        check = ERP now accepts less than the app already added; to_add =
        accepted in ERP, to be added to store stock by the next sync. `total`
        is what waits on quality. There is no "awaiting GRN" step to count any
        more — the GRN is created in ERP before the app sees the line — so
        awaiting_grn is None, not an invented zero. `erp` is the mirror's
        freshness, which every one of these figures depends on."""
        lines = self.erp_grn.lines(store_code)
        scope = self._scope_clause(section_id, section_ids)
        if scope is not None:
            in_section = {pid for (pid,) in db.session.query(Part.id).filter(
                Part.store_code == store_code, scope)}
            lines = [ln for ln in lines if ln["part_id"] in in_section]
        by = {state: [ln for ln in lines if ln["state"] == state]
              for state in ("QUALITY_PENDING", "CHECK", "WILL_POST")}
        qc, check, to_add = by["QUALITY_PENDING"], by["CHECK"], by["WILL_POST"]

        def oldest(rows):
            return min((ln["grn_date"] for ln in rows if ln["grn_date"]), default=None)

        return {
            "quality_pending": len(qc),
            "check": len(check),
            "to_add": len(to_add),
            "total": len(qc),
            "awaiting_grn": None,
            "qty": {"quality_pending": _q(sum(ln["receipt_qty"] or 0 for ln in qc)),
                    "to_add": _q(sum(ln["to_post"] or 0 for ln in to_add)),
                    "total": _q(sum(ln["receipt_qty"] or 0 for ln in qc))},
            "oldest_grn_date": oldest(qc),
            "oldest_check_grn_date": oldest(check),
            "erp": self.erp_grn.mirror_freshness(),
        }

    @staticmethod
    def _returns_pending(store_code, section_id, section_ids=None):
        """Parts departments sent back that are not available again (spec 13 /
        14), counted in returns holding a quantity in each bucket (one return can
        sit in two): inspection = not inspected yet, hold = inspected
        "Inspection Required", damaged = inspected damaged (RGP or scrap next)."""
        R = SpareReturn

        def bucket(col):
            return (func.coalesce(func.sum(case((col > 0, 1), else_=0)), 0),
                    func.coalesce(func.sum(col), 0))

        base = (db.session.query(R)
                .join(Part, Part.id == R.part_id)
                .filter(Part.store_code == store_code, R.status.in_(RETURN_OPEN)))
        scope = SpareDashboardService._scope_clause(section_id, section_ids)
        if scope is not None:
            base = base.filter(scope)
        n_pend, q_pend, n_hold, q_hold, n_dmg, q_dmg = base.with_entities(
            *bucket(R.qty_pending), *bucket(R.qty_hold), *bucket(R.qty_damaged)).one()
        oldest = base.filter(R.qty_pending > 0).with_entities(func.min(R.created_at)).scalar()
        return {
            "inspection": int(n_pend or 0),
            "hold": int(n_hold or 0),
            "damaged": int(n_dmg or 0),
            "qty": {"inspection": _q(q_pend), "hold": _q(q_hold), "damaged": _q(q_dmg)},
            "oldest_inspection_at": _iso_utc(oldest),
        }

    @staticmethod
    def _rgp(store_code, section_id, section_ids=None):
        """Supplier rework under RGP (spec 15-19), counted in RGPs: with_supplier
        = some quantity still at the supplier; grn_pending = the supplier sent it
        back and the RGP GRN is not recorded yet; overdue = still at the supplier
        past its expected return date (an RGP with no expected date is never
        called overdue — there is nothing to be late against)."""
        G = SpareRgp
        out = G.qty_out - G.qty_returned
        back = G.qty_returned - G.qty_grn
        today = datetime.now().date()     # expected dates are plant dates
        late = and_(out > 0, G.expected_return_date.isnot(None), G.expected_return_date < today)
        q = (db.session.query(
                func.coalesce(func.sum(case((out > 0, 1), else_=0)), 0),
                func.coalesce(func.sum(case((out > 0, out), else_=0)), 0),
                func.coalesce(func.sum(case((back > 0, 1), else_=0)), 0),
                func.coalesce(func.sum(case((back > 0, back), else_=0)), 0),
                func.coalesce(func.sum(case((late, 1), else_=0)), 0),
                func.min(case((late, G.expected_return_date))),
                func.min(case((back > 0, G.supplier_returned_at))))
             .join(Part, Part.id == G.part_id)
             .filter(Part.store_code == store_code, G.status.in_(RGP_OPEN)))
        scope = SpareDashboardService._scope_clause(section_id, section_ids)
        if scope is not None:
            q = q.filter(scope)
        n_out, q_out, n_back, q_back, n_late, first_due, first_back = q.one()
        first_due = _as_date(first_due)
        return {
            "with_supplier": int(n_out or 0),
            "grn_pending": int(n_back or 0),
            "overdue": int(n_late or 0),
            "qty": {"with_supplier": _q(q_out), "grn_pending": _q(q_back)},
            "oldest_overdue_date": first_due.isoformat() if first_due else None,
            "oldest_grn_pending_at": _iso_utc(first_back),
        }

    def _erp(self, store_code):
        """What the app actually knows about ERP — never a fabricated "live"."""
        from app.models.erp_stock import ERPStock
        from app.services.erp_sync_service import ERPSyncService

        last, rows = (db.session.query(func.max(ERPStock.synced_at), func.count(ERPStock.id))
                      .join(Part, Part.id == ERPStock.part_id)
                      .filter(Part.store_code == store_code).one())
        age_h = None
        if last is not None:
            ref = last if last.tzinfo else last.replace(tzinfo=timezone.utc)
            age_h = round((datetime.now(timezone.utc) - ref).total_seconds() / 3600, 1)
        if last is None:
            snapshot = "NONE"
        elif age_h is not None and age_h > STALE_AFTER_HOURS:
            snapshot = "STALE"
        else:
            snapshot = "SYNCED"
        db_sync = ERPSyncService().status()
        return {
            "stock_snapshot": {
                "state": snapshot,
                "synced_at": last.isoformat() if last else None,
                "age_hours": age_h,
                "parts": rows,
                "stale_after_hours": STALE_AFTER_HOURS,
            },
            "db_sync": {
                "configured": db_sync["configured"],
                "last_sync_at": db_sync["last_sync_at"],
                "last_error": db_sync["last_error"],
            },
            "write": {**self.stock.erp_write_status(),
                      "pending": self.stock.pending_erp_count(store_code)},
        }


def _top_n(groups, n):
    ranked = sorted(({"name": k, "value": _money(v["value"]), "parts": v["parts"]}
                     for k, v in groups.items() if v["value"]), key=lambda g: -g["value"])
    head, rest = ranked[:n], ranked[n:]
    if rest:
        head.append({"name": f"Other ({len(rest)} types)", "value": _money(sum(g["value"] for g in rest)),
                     "parts": sum(g["parts"] for g in rest), "other": True})
    return head


def _brief(r, names):
    return {
        "part_id": r["part_id"], "part_no": r["part_no"], "part_name": r["part_name"],
        "section": names.get(r["section_id"], "Unassigned"), "section_id": r["section_id"],
        "location": r["location"], "uom": r["uom"],
        "qty_on_hand": r["qty_on_hand"], "min_stock_level": r["min_stock_level"],
        "reorder_level": r["reorder_level"], "max_stock_level": r["max_stock_level"],
        "shortfall": r["shortfall"], "unit_price": r["unit_price"],
        "stock_value": r["stock_value"], "status": r["status"],
    }
