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
"""
from datetime import datetime, timezone

from sqlalchemy import func

from app.extensions import db
from app.models.base import utcnow
from app.models.part import Part
from app.models.spare_stock import SpareStockLedger
from app.models.store import Section, Store
from app.services.spare_flow_service import SpareFlowService
from app.services.spare_stock_service import SpareStockService

# Worst first — the order the health bar and the attention list read in.
STATUS_ORDER = ("Out of Stock", "Below Minimum", "Reorder", "Above Maximum", "Healthy", "Not Counted")

# An ERP stock snapshot older than this is reported STALE (same window the
# scan screen's data-status badge uses).
STALE_AFTER_HOURS = 24

_TOP = 10


def _money(v):
    return round(v, 2) if v else 0.0


class SpareDashboardService:
    def __init__(self):
        self.stock = SpareStockService()
        self.flow = SpareFlowService()

    # ------------------------------------------------------------------ public

    def overview(self, store_code, section_id=None):
        rows = self.stock.list_stock(store_code, section_id)
        names = self._section_names(store_code)
        agg = self._aggregate(rows)

        return {
            "store_code": store_code,
            "section_id": section_id,
            "generated_at": utcnow().replace(tzinfo=timezone.utc).isoformat(),
            "kpis": {
                "total_parts": len(rows),
                "counted_parts": agg["counted"],
                "uncounted_parts": len(rows) - agg["counted"],
                "total_qty": round(agg["qty"], 2),
                "stock_value": _money(agg["value"]),
                "valued_parts": agg["valued"],
                "today": self._today(store_code, section_id),
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
            "attention": self._attention(store_code, section_id, agg, names),
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
            "consumption": self._consumption(store_code, section_id),
            "recent_activity": self._recent(store_code, section_id),
            "erp": self._erp(store_code),
            "data_quality": agg["quality"],
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
            if not mx:
                miss["max"] += 1
            if not mn:
                miss["min"] += 1
            if ro is None:
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

    def _attention(self, store_code, section_id, agg, names):
        """Severity-ordered problems. An item is listed even at zero — "no part
        is out of stock" is a reading worth seeing, not an absence to hide."""
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
                       "At or below the reorder point — raise the PO"),
            stock_item("excess", "Above maximum", "Above Maximum", "warning",
                       "Money tied up above the planned maximum",
                       value=agg["excess_value"], value_label="tied up above max"),
        ]
        # The restock spend belongs to the short lines as a group; quote it once,
        # on the first of them, rather than split by a rule the data doesn't hold.
        items[0]["value"] = _money(agg["restock_value"])
        items[0]["value_label"] = "to restock all short parts to max"

        confirm = self._pending_confirmations(store_code, section_id)
        items.append({
            "key": "confirm_pending", "label": "Issues awaiting confirmation",
            "severity": "warning" if confirm else "ok",
            "hint": "Issued by the store, machine / line not yet confirmed by the user",
            "count": confirm, "value": None, "value_label": None, "sections": [],
            "action": {"label": "Confirm on Scan Part", "to": "/scan-part"},
        })
        if section_id is None:
            # SRVs are store-level (a section screen must not quote them).
            pend = self.flow.pending_summary(store_code)
            items.append({
                "key": "srv_pending", "label": "SRV / GRN pending",
                "severity": "warning" if pend["total"] else "ok",
                "hint": "Arrived material waiting for an SRV or an engineer's clearance",
                "count": pend["total"], "value": None, "value_label": None, "sections": [],
                "action": None,
            })
        items.append(stock_item("never_counted", "Never counted", "Not Counted", "info",
                                "No physical count yet — its status is unknown"))
        erp_pending = self.stock.pending_erp_count(store_code) if section_id is None else None
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

    def _today(self, store_code, section_id):
        t = self.stock.today_movements(store_code, section_id)
        return {k: t.get(k) for k in ("since", "received_qty", "received_lines",
                                      "issued_qty", "issued_lines")}

    def _consumption(self, store_code, section_id):
        today = datetime.now().date()
        month_start = today.replace(day=1).isoformat()
        return {
            "comparison": self.stock.consumption_comparison(store_code, section_id),
            "this_month_by_department": sorted(
                self.stock.consumption_by_department(
                    store_code, section_id, date_from=month_start, date_to=today.isoformat()),
                key=lambda d: -d["value"])[:5],
            "month_start": month_start,
            # All-time splits behind the dashboard's three consumption donuts.
            "by_department": self.stock.consumption_by_department(store_code, section_id),
            "by_machine": self.stock.consumption_by_machine(store_code, section_id),
            "by_type": self.stock.consumption_by_type(store_code, section_id),
        }

    def _recent(self, store_code, section_id):
        # A section reads its own movements out of a wider window of the store's.
        rows = self.stock.recent_activity(store_code, 15 if section_id is None else 60)
        if section_id is not None:
            rows = [r for r in rows if r.get("section_id") == section_id]
        return rows[:10]

    @staticmethod
    def _pending_confirmations(store_code, section_id):
        q = (db.session.query(func.count(SpareStockLedger.id))
             .join(Part, Part.id == SpareStockLedger.part_id)
             .filter(Part.store_code == store_code,
                     SpareStockLedger.txn_type == "ISSUE",
                     # Same set the Scan Part queue and the alerts count, so the
                     # dashboard, the bell and the queue never disagree.
                     SpareStockLedger.status.in_(("PENDING_USER_CONFIRMATION", "ISSUED_BY_STORE"))))
        if section_id is not None:
            q = q.filter(Part.section_id == section_id)
        return q.scalar() or 0

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
