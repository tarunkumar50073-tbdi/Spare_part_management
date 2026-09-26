"""The Spare Parts Store's Notification Center, computed on request.

Nothing here is stored, acknowledged or invented. Every alert is a reading of
rows that exist right now (the stock list, the issue-confirmation queue, the
receipt / return / RGP documents, the ERP snapshot), so an alert goes away the
moment the thing it reports is fixed. A type with nothing to report is left out
rather than listed at zero: "0 parts out of stock" in a bell is noise. The
exceptions are the two ERP states, which are conditions of the feed rather than
counts of parts.

The stock, document and ERP figures come from SpareDashboardService.overview,
so the bell, this screen and the dashboard's attention board cannot disagree.

An alert is a headline; the per-part / per-issue lines listed under one (their
`parent` names it) are its detail. The summary, and so the bell's badge, counts
headlines only — counting the detail lines too would make the number depend on
how many of them are listed.

Deliberately NOT alerted: "count due". The app keeps no count frequency per
part, so any due date would be made up.
"""
from datetime import datetime, timezone
from urllib.parse import quote, urlencode

from sqlalchemy import func
from sqlalchemy.orm import contains_eager

from app.extensions import db
from app.models.base import utcnow
from app.models.part import Part
from app.models.spare_stock import SpareStockLedger
from app.models.store import Store
from app.services.spare_dashboard_service import STALE_AFTER_HOURS, SpareDashboardService
from app.services.spare_stock_service import SpareStockService
from app.utils.exceptions import BadRequestError, NotFoundError

SEVERITIES = ("critical", "warning", "info")
_RANK = {s: i for i, s in enumerate(SEVERITIES)}

# Per-part zero-stock alerts under the headline count: the dearest to restock.
TOP_ZERO_STOCK = 5
# Per-issue confirmation alerts: the longest-waiting ones. Past this the
# headline alert carries the count and Scan Part holds the full queue.
MAX_ISSUE_ALERTS = 10
# An ISSUE still waiting for the user's line / machine confirmation — the Scan
# Part queue's own filter (SpareStockService.pending_confirmations).
AWAITING_CONFIRMATION = ("PENDING_USER_CONFIRMATION", "ISSUED_BY_STORE")

OMITTED = [
    {"type": "count_due",
     "reason": "No count frequency is kept per part, so no count can be called due."},
]


def _go(label, to, module):
    """An alert's action: the screen it opens and the module right that screen's
    route asks for (App.jsx RequirePermission). Any store user may read the
    alerts, so the UI needs `module` to avoid offering a button that only lands
    on "Access restricted"."""
    return {"label": label, "to": to, "module": module}


def _stock_list(status):
    # quote (not quote_plus): the Store Stock filter reads "Out%20of%20Stock".
    return _go("Open list", "/store-stock-spare?" + urlencode({"status": status}, quote_via=quote),
               "store_stock")


def _erp_control():
    return _go("Open ERP Control", "/erp-control", "erp_gap")


def _work_queue():
    # Receipts, returns and RGPs are worked from the Work Queue (the Scan Part
    # right), which deep-links each document into Scan Part.
    return _go("Open Work Queue", "/work-queue", "scan_part")


def _naive_utc(value):
    """Ledger and snapshot times come back naive from SQLite (stored as UTC),
    utcnow() is aware, and some callers hand over ISO strings. One footing."""
    if value is None:
        return None
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value)
        except ValueError:
            return None
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def _iso(value):
    """ISO with an explicit UTC offset, so the browser shows local time rather
    than reading a bare UTC stamp as if it were already local."""
    v = _naive_utc(value)
    return v.replace(tzinfo=timezone.utc).isoformat() if v else None


def _hours_since(value, now):
    v = _naive_utc(value)
    return round((now - v).total_seconds() / 3600, 1) if v else None


def _age(hours):
    if hours is None:
        return None
    if hours < 1:
        return "under an hour"
    if hours < 48:
        return f"{int(hours)} h"
    return f"{int(hours // 24)} days"


def _count(n, noun, plural=None):
    return f"{n:,} {noun if n == 1 else (plural or noun + 's')}"


def _qty(v):
    return ("%.2f" % float(v)).rstrip("0").rstrip(".")


def _inr(v):
    """Rupees in Indian grouping (1,23,456), the way the screens print them."""
    n = int(round(v))
    s = str(abs(n))
    if len(s) > 3:
        head, groups = s[:-3], [s[-3:]]
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        s = ",".join(groups)
    return ("-" if n < 0 else "") + "₹" + s


def _where(sections):
    """The attention item's worst (up to three) sections, as a sentence to
    append: " Top sections: Press Shop 12, Nut-Bolt 3." — or nothing."""
    if not sections:
        return ""
    return " Top sections: " + ", ".join(f"{s['name']} {s['count']:,}" for s in sections) + "."


def _alert(id, severity, type, title, message, count=None, *, part=None, at=None,
           action=None, parent=None, **extra):
    return {
        "id": id, "severity": severity, "type": type,
        "title": title, "message": message, "count": count,
        "part_id": part["part_id"] if part else None,
        "part_no": part["part_no"] if part else None,
        "at": at, "action": action, "parent": parent,
        **extra,
    }


class SpareAlertsService:
    def __init__(self):
        self.dashboard = SpareDashboardService()
        self.stock = SpareStockService()

    def alerts(self, store_code):
        store = Store.query.filter_by(code=store_code).first()
        if store is None:
            raise NotFoundError(f"Store '{store_code}' not found")
        if not store.is_active:
            raise BadRequestError(f"{store.name} is switched off")

        now = _naive_utc(utcnow())
        ov = self.dashboard.overview(store_code)
        att = {a["key"]: a for a in ov["attention"]}

        out = []
        out += self._zero_stock(att["zero_stock"], ov["critical_parts"])
        out += self._below_min(att["below_min"])
        out += self._erp_sync(ov["erp"]["db_sync"], now)
        out += self._confirmations(store_code, now)
        out += self._reorder(att["reorder"])
        out += self._excess(store_code, att["excess"])
        out += self._receipts(ov["receiving_pending"], now)
        out += self._returns(ov["returns_pending"], now)
        out += self._rgp_overdue(ov["rgp"])
        out += self._rgp_grn(ov["rgp"], now)
        out += self._erp_snapshot(ov["erp"]["stock_snapshot"], now)
        out += self._erp_queue(store_code, ov["erp"]["write"], now)
        out += self._never_counted(att["never_counted"])
        out += self._master_data(ov["data_quality"])

        # Worst first; within a severity the order built above (a headline
        # before the parts/issues listed under it) is kept — sort is stable.
        out.sort(key=lambda a: _RANK[a["severity"]])
        # Headlines only: 300 parts at zero stock is one alert, however many of
        # them are listed under it.
        heads = [a for a in out if a["parent"] is None]
        summary = {s: sum(1 for a in heads if a["severity"] == s) for s in SEVERITIES}
        summary["total"] = len(heads)
        return {
            "store_code": store_code,
            "generated_at": _iso(now),
            "summary": summary,
            "alerts": out,
            "omitted": OMITTED,
        }

    # ------------------------------------------------------------ stock state

    @staticmethod
    def _zero_stock(item, critical_parts):
        n = item["count"]
        if not n:
            return []
        out = [_alert(
            "zero_stock", "critical", "zero_stock",
            f"{_count(n, 'part')} at zero stock",
            "Counted and found empty: nothing to issue until restocked." + _where(item["sections"]),
            n, action=_stock_list("Out of Stock"),
        )]
        # critical_parts is worst status first, then dearest restock — so its
        # zero-stock head is the top of the list by value.
        parts = [p for p in critical_parts if p["status"] == "Out of Stock"][:TOP_ZERO_STOCK]
        for p in parts:
            if p["shortfall"] is not None:
                need, basis = p["shortfall"], "max"
            else:
                gap = (p["min_stock_level"] or 0) - (p["qty_on_hand"] or 0)
                need, basis = (gap if gap > 0 else None), "min"
            value = round(need * p["unit_price"], 2) if (need and p["unit_price"]) else None
            if need and value is not None:
                restock = f"Restock to {basis}: {_qty(need)} {p['uom'] or ''}".rstrip() \
                    + f", {_inr(value)} at std rate."
            elif need:
                restock = f"Restock to {basis}: {_qty(need)} {p['uom'] or ''}".rstrip() + " (no std rate)."
            else:
                restock = "No min / max set, so the order quantity is unknown."
            place = " · ".join(x for x in (p["section"], p["location"]) if x)
            out.append(_alert(
                f"zero_stock:{p['part_id']}", "critical", "zero_stock_part",
                f"Zero stock: {p['part_no']}",
                f"{p['part_name'] or p['part_no']}" + (f" ({place})" if place else "") + f". {restock}",
                part=p, parent="zero_stock", value=value, action=_stock_list("Out of Stock"),
            ))
        return out

    @staticmethod
    def _below_min(item):
        n = item["count"]
        if not n:
            return []
        return [_alert(
            "below_min", "critical", "below_min",
            f"{_count(n, 'part')} below minimum",
            "Under the planned minimum: order now." + _where(item["sections"]),
            n, action=_stock_list("Below Minimum"),
        )]

    @staticmethod
    def _reorder(item):
        n = item["count"]
        if not n:
            return []
        return [_alert(
            "reorder", "warning", "reorder",
            f"{_count(n, 'part')} at reorder level",
            "At or below the reorder point, still above minimum: raise the PO." + _where(item["sections"]),
            n, action=_stock_list("Reorder"),
        )]

    def _excess(self, store_code, item):
        n = item["count"]
        if not n:
            return []
        # The overview's money covers only parts with a rate; say how many it
        # leaves out rather than let a partial sum read as the whole. The list
        # is the one the overview just built (cached for a few seconds).
        unrated = sum(1 for r in self.stock.list_stock(store_code)
                      if r["status"] == "Above Maximum" and r["unit_price"] is None)
        value = item["value"] or 0
        if value:
            money = f"{_inr(value)} tied up above the planned maximum (qty over max × std rate)."
            if unrated:
                money += f" {_count(unrated, 'part')} without a rate not included."
        else:
            money = "No std rate on these parts, so the money tied up is unknown."
        return [_alert(
            "excess", "warning", "excess",
            f"{_count(n, 'part')} above maximum", money, n,
            value=value or None,
            action=_go("Review excess", "/inventory-control?tab=excess", "store_stock"),
        )]

    @staticmethod
    def _never_counted(item):
        n = item["count"]
        if not n:
            return []
        return [_alert(
            "never_counted", "info", "never_counted",
            f"{_count(n, 'part')} never counted",
            "No physical count yet, so their stock status is unknown and they "
            "cannot raise a zero-stock or below-minimum alert.",
            n, action=_stock_list("Not Counted"),
        )]

    @staticmethod
    def _master_data(dq):
        out = []
        if dq["missing_max"]:
            out.append(_alert(
                "missing_max", "info", "missing_max",
                f"{_count(dq['missing_max'], 'part')} with no maximum level",
                "Without a max, excess cannot be flagged and the order quantity cannot be worked out.",
                dq["missing_max"], action=_go("Open Data Quality", "/data-quality", "part_master"),
            ))
        if dq["missing_rate"]:
            out.append(_alert(
                "missing_rate", "info", "missing_rate",
                f"{_count(dq['missing_rate'], 'part')} with no std rate",
                "Their stock cannot be valued, so every value total leaves them out.",
                dq["missing_rate"], action=_go("Open Data Quality", "/data-quality", "part_master"),
            ))
        return out

    # ------------------------------------------------------------------ flows

    @staticmethod
    def _confirmation_queue(store_code):
        """(count, longest-waiting rows) of the Scan Part confirmation queue —
        the same filter as SpareStockService.pending_confirmations, but counted
        in SQL and only the listed rows loaded, with their part in the same
        query rather than one lazy load per row."""
        base = (db.session.query(SpareStockLedger)
                .join(Part, Part.id == SpareStockLedger.part_id)
                .filter(Part.store_code == store_code,
                        SpareStockLedger.txn_type == "ISSUE",
                        SpareStockLedger.status.in_(AWAITING_CONFIRMATION)))
        n = base.with_entities(func.count(SpareStockLedger.id)).scalar() or 0
        if not n:
            return 0, []
        rows = (base.options(contains_eager(SpareStockLedger.part))
                .order_by(SpareStockLedger.created_at.asc(), SpareStockLedger.id.asc())
                .limit(MAX_ISSUE_ALERTS).all())
        return n, [{
            "id": r.id, "part_id": r.part_id,
            "part_no": r.part.part_no, "part_name": r.part.part_name,
            "qty": abs(float(r.qty_delta)), "uom": r.part.uom, "department": r.department,
            "issued_to": r.issued_to, "issued_by": r.created_by, "issued_at": r.created_at,
        } for r in rows]

    def _confirmations(self, store_code, now):
        # The queue Scan Part works through, so the count here is the number
        # of rows the user finds there.
        n, queue = self._confirmation_queue(store_code)
        if not n:
            return []
        oldest = _age(_hours_since(queue[0]["issued_at"], now))
        listed = len(queue)
        msg = "Issued by the store; where each was fitted (line / machine) is not confirmed yet."
        if oldest:
            msg += f" Oldest waiting {oldest}."
        if n > listed:
            msg += f" The {listed} longest waiting are listed below."
        action = _go("Confirm on Scan Part", "/scan-part", "scan_part")
        out = [_alert("confirm_pending", "warning", "confirm_pending",
                      f"{_count(n, 'issue')} awaiting user confirmation", msg, n, action=action)]
        for r in queue:
            hours = _hours_since(r["issued_at"], now)
            who = " / ".join(x for x in (r["department"], r["issued_to"]) if x)
            text = f"{_qty(r['qty'])} {r['uom'] or ''}".rstrip() + " issued" + (f" to {who}" if who else "")
            if r["issued_by"]:
                text += f" by {r['issued_by']}"
            text += f", waiting {_age(hours)}." if hours is not None else "."
            out.append(_alert(
                f"confirm_pending:{r['id']}", "warning", "confirm_pending_issue",
                f"Confirm issue of {r['part_no'] or 'a part'}"
                + (f" ({r['part_name']})" if r["part_name"] else ""),
                text, part=r if r["part_id"] else None, at=_iso(r["issued_at"]),
                parent="confirm_pending", age_hours=hours, ledger_id=r["id"], action=action,
            ))
        return out

    # ------------------------------------------------ held, not issuable
    #
    # Spec 1: a spare has no separate SRV step — receiving is one flow
    # (received -> ERP GRN -> quality -> stock), read from spare_receipts. The
    # returns and RGP alerts read spare_returns / spare_rgps the same way. All
    # four quote the overview's blocks, so the bell and the dashboard agree.

    @staticmethod
    def _receipts(rp, now):
        n = rp["total"]
        if not n:
            return []
        parts = []
        if rp["awaiting_grn"]:
            parts.append(f"{rp['awaiting_grn']:,} waiting for the ERP GRN")
        if rp["quality_pending"]:
            parts.append(f"{rp['quality_pending']:,} with Maintenance / Tool Room for quality")
        hours = _hours_since(rp["oldest_at"], now)
        msg = "; ".join(parts) + ". Not issuable until quality clears them."
        if hours is not None:
            msg += f" Oldest received {_age(hours)} ago."
        return [_alert(
            "receipts_pending", "warning", "receipts_pending",
            f"{_count(n, 'receipt')} awaiting GRN / quality", msg, n,
            at=_iso(rp["oldest_at"]), age_hours=hours,
            awaiting_grn=rp["awaiting_grn"], quality_pending=rp["quality_pending"],
            action=_work_queue(),
        )]

    @staticmethod
    def _returns(ret, now):
        n, hold = ret["inspection"], ret["hold"]
        if not (n or hold):
            return []
        hours = _hours_since(ret["oldest_inspection_at"], now)
        if n:
            title = f"{_count(n, 'return')} awaiting inspection"
            msg = (f"{_qty(ret['qty']['inspection'])} returned by departments and not inspected yet — "
                   "not available until the store inspects it.")
            if hours is not None:
                msg += f" Oldest returned {_age(hours)} ago."
            if hold:
                msg += f" {_count(hold, 'more return')} on hold (inspection required)."
        else:
            title = f"{_count(hold, 'return')} on hold — inspection required"
            msg = (f"{_qty(ret['qty']['hold'])} inspected as needing a closer look; "
                   "decide good, damaged or scrap.")
        return [_alert(
            "returns_inspection", "warning", "returns_inspection", title, msg, n or hold,
            at=_iso(ret["oldest_inspection_at"]) if n else None, age_hours=hours if n else None,
            inspection=n, hold=hold, action=_work_queue(),
        )]

    @staticmethod
    def _rgp_overdue(rgp):
        n = rgp["overdue"]
        if not n:
            return []
        msg = "Still with the supplier for rework past the expected return date."
        due = rgp["oldest_overdue_date"]
        if due:
            late = (datetime.now().date() - datetime.fromisoformat(due).date()).days
            msg += f" Oldest was due {_count(late, 'day')} ago ({due})."
        return [_alert(
            "rgp_overdue", "warning", "rgp_overdue",
            f"{_count(n, 'RGP')} overdue at the supplier", msg, n,
            oldest_due=due, action=_work_queue(),
        )]

    @staticmethod
    def _rgp_grn(rgp, now):
        n = rgp["grn_pending"]
        if not n:
            return []
        hours = _hours_since(rgp["oldest_grn_pending_at"], now)
        msg = (f"The supplier returned {_qty(rgp['qty']['grn_pending'])} after rework; until the RGP GRN "
               "is recorded it is not available stock.")
        if hours is not None:
            msg += f" Oldest waiting {_age(hours)}."
        return [_alert(
            "rgp_grn_pending", "warning", "rgp_grn_pending",
            f"{_count(n, 'RGP')} waiting for the RGP GRN", msg, n,
            at=_iso(rgp["oldest_grn_pending_at"]), age_hours=hours, action=_work_queue(),
        )]

    # -------------------------------------------------------------------- ERP

    @staticmethod
    def _erp_sync(db_sync, now):
        """The ERP DB poller's last error. Held in the server's memory only, so
        it reflects runs since the backend last started."""
        if not db_sync.get("last_error"):
            return []
        last_ok = _naive_utc(db_sync.get("last_sync_at"))
        since = (f" Last successful sync {_age(_hours_since(last_ok, now))} ago."
                 if last_ok else " No successful sync since the server started.")
        # The error text itself stays on ERP Control (erp_gap right): a driver
        # error names the ERP DB host, port and user, and this list goes to
        # every user of the store.
        return [_alert(
            "erp_sync_error", "critical", "erp_sync_error",
            "ERP database sync is failing",
            "Gate entries and the GRN register stop refreshing until it succeeds; "
            f"the error is on ERP Control.{since}",
            last_sync_at=_iso(last_ok), action=_erp_control(),
        )]

    @staticmethod
    def _erp_snapshot(snap, now):
        action = _erp_control()
        if snap["state"] == "NONE":
            return [_alert(
                "erp_snapshot_none", "warning", "erp_snapshot",
                "No ERP stock snapshot",
                "ERP has not sent stock figures for this store's parts, so ERP and "
                "physical stock cannot be compared.",
                state="NONE", action=action,
            )]
        if snap["state"] != "STALE":
            return []
        hours = _hours_since(snap["synced_at"], now)
        return [_alert(
            "erp_snapshot_stale", "warning", "erp_snapshot",
            f"ERP stock snapshot is {_age(hours)} old",
            f"The last ERP stock figures cover {_count(snap['parts'], 'part')}; anything that "
            "moved in ERP since then is not reflected here. "
            f"A snapshot older than {STALE_AFTER_HOURS} h counts as stale.",
            snap["parts"], at=_iso(snap["synced_at"]), state="STALE", age_hours=hours,
            action=action,
        )]

    def _erp_queue(self, store_code, write, now):
        n = write.get("pending") or 0
        if not n:
            return []
        oldest = self.stock.pending_erp_movements(store_code, limit=1)
        oldest_at = oldest[0]["at"] if oldest else None
        hours = _hours_since(oldest_at, now)
        msg = write["reason"] + "."
        if hours is not None:
            msg += f" Oldest queued {_age(hours)} ago."
        return [_alert(
            "erp_write_queue", "info", "erp_write_queue",
            f"{_count(n, 'movement')} not yet in ERP", msg, n,
            at=_iso(oldest_at), write_active=write.get("active"), action=_erp_control(),
        )]
