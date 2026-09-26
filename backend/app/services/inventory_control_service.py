"""Inventory Control: the Critical / Short / Reorder / Excess lists in one call.

Four connected views over the same stock list, built once server-side so the
four tabs, their counts and their money can never disagree with each other or
with Store Stock (membership follows the same `status` the stock list carries):

    critical  zero stock, below minimum, or fast-moving with little cover left
    short     below the planned minimum, with what to order
    reorder   at or below the reorder point, with the order-up-to-max quantity
    excess    above the planned maximum, the money tied up, and for how long

Everything is read from real rows. What the app does not track (lead time,
safety stock, the history of a part's max) is stated in `rules` / `notes`, never
guessed. Days of cover is the one estimate here, and it is labelled as one.
"""
from datetime import timezone

from sqlalchemy import func

from app.extensions import db
from app.models.base import utcnow
from app.models.part import Part
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.models.store import Section, Store
from app.services.spare_stock_service import SpareStockService

# Under this many days of estimated cover, a part that is being issued is
# critical even while it still sits above its minimum.
COVER_THRESHOLD_DAYS = 15
# part_facts' issued_90d window.
ISSUE_WINDOW_DAYS = 90

REORDER_STATUSES = ("Out of Stock", "Below Minimum", "Reorder")
_STATUS_RANK = {"Out of Stock": 0, "Below Minimum": 1, "Reorder": 2}

# Excess aging buckets, oldest last. "before_tracking" = above max already at
# the part's first ledger row; "no_ledger" = the part has no ledger row at all,
# so only the date the app last recorded its quantity is known; "unknown" = the
# ledger's last balance is not above max, so the change that put it over was
# never recorded and cannot be dated.
AGING_BUCKETS = (
    ("0-30", "0-30 days"),
    ("31-60", "31-60 days"),
    ("61-90", "61-90 days"),
    ("90+", "Over 90 days"),
    ("before_tracking", "Before tracking"),
    ("no_ledger", "No ledger row"),
    ("unknown", "Change not recorded"),
)

# Why a listed part has no order quantity. Each says what is actually missing,
# so a part that has levels is never told to set them.
NO_QTY_ACTIONS = {
    "at_max": "At or above max: no order needed",
    "no_max": "No max set and stock is at or above min: set a max to size the order",
    "no_levels": "Set a min or max first: no order quantity can be worked out",
}

RULES = {
    "critical": (f"Zero stock, below minimum, or issued recently with under {COVER_THRESHOLD_DAYS} "
                 "days of estimated cover (in stock / average daily issue)."),
    "short": "In stock below the planned minimum. Short qty = min - in stock.",
    "reorder": ("Order up to max (up to min where no max is set). "
                "Lead time and safety stock are not tracked, so they are not in the quantity."),
    "excess": "In stock above the planned maximum. Excess qty = in stock - max, valued at the part's rate.",
}


def _naive_utc(dt):
    """SQLite hands back naive UTC; utcnow() is aware. Compare them as naive UTC."""
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _iso(dt):
    """A ledger instant as an explicit UTC ISO string, so the browser shows it
    on the plant clock rather than reading the naive value as local."""
    return dt.replace(tzinfo=timezone.utc).isoformat() if dt else None


def _q(v):
    """A quantity for a sentence: 19, not 19.0."""
    v = round(float(v), 2)
    return str(int(v)) if v.is_integer() else f"{v:g}"


def _rated_sum(rows, key):
    """Total of `key` over the rows that carry it: 0.0 for no rows, None when
    rows exist but none is rated (unknown money is not zero money)."""
    rated = [r[key] for r in rows if r[key] is not None]
    if rows and not rated:
        return None
    return round(sum(rated), 2)


def _bucket_for(days):
    if days <= 30:
        return "0-30"
    if days <= 60:
        return "31-60"
    if days <= 90:
        return "61-90"
    return "90+"


def excess_age(history, max_level, now, recorded_at=None):
    """How long a part now above max has been there, read off its ledger rows
    [(balance_after, created_at), ...] (oldest first) against the CURRENT max.

    The excess started at the last row where the balance moved from <= max to
    > max. Already above max at its first row means the excess predates what
    the ledger can date ("before tracking"). No row at all means the ledger
    never saw the part move: `recorded_at` (the latest time the app recorded
    its current quantity) is the only date that can be vouched for."""
    if not history:
        return {
            "aging_bucket": "no_ledger", "aging_basis": "no_ledger",
            "days_in_excess": None, "excess_since": None,
            # Not the store's ledger start: the app's own first count writes an
            # OPENING row, so a part without one got its quantity some other
            # way, possibly long after the ledger began.
            "excess_since_at_least": _iso(recorded_at),
        }
    since = None
    above_from_first = False
    prev = None
    for bal, at in history:
        bal = float(bal)
        if bal > max_level:
            if prev is None:
                above_from_first = True
            elif prev <= max_level:
                since, above_from_first = at, False
        else:
            since, above_from_first = None, False
        prev = bal
    if prev <= max_level:
        # The ledger ends at or under max, yet the part is over it now: the
        # change that put it there has no ledger row.
        return {"aging_bucket": "unknown", "aging_basis": "ledger_not_above",
                "days_in_excess": None, "excess_since": None, "excess_since_at_least": None}
    if since is not None:
        since = _naive_utc(since)
        days = max(0, (now - since).days)
        return {"aging_bucket": _bucket_for(days), "aging_basis": "crossing",
                "days_in_excess": days, "excess_since": _iso(since), "excess_since_at_least": None}
    first_at = _naive_utc(history[0][1])
    return {"aging_bucket": "before_tracking", "aging_basis": "above_at_first_row",
            "days_in_excess": None, "excess_since": None, "excess_since_at_least": _iso(first_at)}


class InventoryControlService:
    def __init__(self):
        self.stock = SpareStockService()

    # ------------------------------------------------------------------ public

    def overview(self, store_code, section_id=None):
        rows = self.stock.list_stock(store_code, section_id)
        facts = self.stock.part_facts(store_code)
        names = self._section_names(store_code)
        now = _naive_utc(utcnow())
        ledger_since = self._ledger_since(store_code)
        window = self._cover_window(ledger_since, now)

        critical, short, reorder, excess = [], [], [], []
        not_counted = 0
        for r in rows:
            q = r["qty_on_hand"]
            if q is None:
                not_counted += 1
                continue
            row = self._base(r, names, facts.get(str(r["part_id"]), {}), window)
            st, mn, rate = r["status"], r["min_stock_level"], r["unit_price"]
            need, basis = self._order_qty(r)
            order = {
                "recommended_order_qty": need,
                "order_basis": basis,
                # A rate of 0 is a missing rate, not a free part.
                "order_value": round(need * rate, 2) if (need and rate) else None,
                "recommended_action": self._action(need, basis),
            }

            reasons = []
            if st == "Out of Stock":
                reasons.append("Zero stock")
            elif st == "Below Minimum":
                reasons.append("Below minimum")
            # An empty shelf has no cover to estimate — it is already zero stock.
            if q > 0 and row["days_cover"] is not None and row["days_cover"] < COVER_THRESHOLD_DAYS:
                reasons.append("Low cover (est.)")
            if reasons:
                low_cover = "Low cover (est.)" in reasons
                crit = {**row, **order, "reasons": reasons, "reason": reasons[0], "low_cover": low_cover}
                if low_cover and basis == "at_max":
                    # The levels say "enough"; only the estimate says otherwise.
                    crit["recommended_action"] = ("At or above max: no order needed by the levels "
                                                  "(low cover is an estimate; review the max)")
                critical.append(crit)

            if mn and q < mn:
                short.append({**row, **order})

            if st in REORDER_STATUSES:
                reorder.append({**row, **order})

            if st == "Above Maximum" and r["max_stock_level"]:
                mx = r["max_stock_level"]
                ex = round(q - mx, 2)
                excess.append({
                    **row,
                    "excess_qty": ex,
                    "excess_pct": round(ex / mx * 100, 1),
                    "excess_value": round(ex * rate, 2) if rate else None,
                })

        self._age_excess(store_code, section_id, excess, now)
        self._sort(critical, short, reorder, excess)

        # None, not 0, when parts are listed but none carries a rate: the money
        # is unknown, and a firm zero would read as "nothing tied up".
        ordered = [r for r in reorder if r["recommended_order_qty"] is not None]
        excess_value = _rated_sum(excess, "excess_value")
        restock_value = _rated_sum(ordered, "order_value")
        no_qty = {b: sum(1 for r in reorder if r["order_basis"] == b) for b in NO_QTY_ACTIONS}
        return {
            "store_code": store_code,
            "section_id": section_id,
            "generated_at": utcnow().isoformat(),
            "ledger_since": _iso(ledger_since),
            "cover": {
                "threshold_days": COVER_THRESHOLD_DAYS,
                "window_days": window,
                "is_estimate": True,
                "basis": self._cover_basis(window, ledger_since),
            },
            "rules": RULES,
            "totals": {
                "parts": len(rows),
                "counted": len(rows) - not_counted,
                "not_counted": not_counted,
                "critical": len(critical),
                "critical_zero": sum(1 for c in critical if c["status"] == "Out of Stock"),
                "critical_below_min": sum(1 for c in critical if c["status"] == "Below Minimum"),
                "critical_low_cover": sum(1 for c in critical if c["low_cover"]),
                "short": len(short),
                "reorder": len(reorder),
                "excess": len(excess),
                "excess_value": excess_value,
                # Parts whose money is missing from the total (no rate).
                "excess_unrated": sum(1 for e in excess if e["excess_value"] is None),
                "restock_value": restock_value,
                "restock_unrated": sum(1 for r in ordered if r["order_value"] is None),
                # Listed with no order quantity, and why: no levels at all, a min
                # but no max, or already at/above max.
                "reorder_no_qty": len(reorder) - len(ordered),
                "reorder_no_levels": no_qty["no_levels"],
                "reorder_no_max": no_qty["no_max"],
                "reorder_at_max": no_qty["at_max"],
                "ledger_since": _iso(ledger_since),
            },
            "critical": critical,
            "short": short,
            "reorder": reorder,
            "excess": excess,
            "aging": {
                "buckets": self._buckets(excess, ledger_since),
                "notes": [
                    "Max changes are not versioned: time above max is measured against today's max.",
                    "Read from the app's own stock ledger (the balance after each movement)"
                    + (f", which starts {ledger_since.date().isoformat()}." if ledger_since
                       else "; no ledger movement is recorded yet."),
                    "Already above max at its first ledger row: 'Before tracking', dated by that row. "
                    "No ledger row at all: 'No ledger row', known only to be above today's max since "
                    "the app last recorded its quantity. Neither can be dated further back.",
                ],
            },
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
    def _ledger_since(store_code):
        """When the app's ledger started for this store — the horizon every
        movement-based figure here is limited to."""
        first = (db.session.query(func.min(SpareStockLedger.created_at))
                 .join(Part, Part.id == SpareStockLedger.part_id)
                 .filter(Part.store_code == store_code)
                 .scalar())
        return _naive_utc(first)

    @staticmethod
    def _cover_window(ledger_since, now):
        """Days of issue history behind issued_90d. A ledger younger than 90
        days holds fewer days of issues; dividing by 90 anyway would treat the
        unrecorded days as zero use and overstate the cover."""
        if ledger_since is None:
            return ISSUE_WINDOW_DAYS
        return max(1, min(ISSUE_WINDOW_DAYS, (now - ledger_since).days))

    @staticmethod
    def _cover_basis(window, ledger_since):
        text = (f"Estimate: in stock / (issued in the last {window} days / {window}). "
                "Not a forecast; lead time is not tracked.")
        if ledger_since and window < ISSUE_WINDOW_DAYS:
            text += (f" The ledger starts {ledger_since.date().isoformat()}, "
                     f"so only {window} days of issues exist.")
        return text

    @staticmethod
    def _base(r, names, f, window):
        q = r["qty_on_hand"]
        issued = float(f.get("issued_90d") or 0)
        mn = r["min_stock_level"]
        return {
            "part_id": r["part_id"], "part_no": r["part_no"], "part_name": r["part_name"],
            "old_part_no": r["old_part_no"],
            # sub_category is the useful grouping; category is one value for every spare.
            "type": (r["sub_category"] or "").strip() or "Uncategorised",
            "section_id": r["section_id"], "section": names.get(r["section_id"], "Unassigned"),
            "location": r["location"], "uom": r["uom"],
            "qty_on_hand": q, "min_stock_level": mn,
            "reorder_level": r["reorder_level"], "max_stock_level": r["max_stock_level"],
            "unit_price": r["unit_price"], "stock_value": r["stock_value"], "status": r["status"],
            # None where no minimum is planned — "not short of a plan" is not 0.
            "short_qty": (round(mn - q, 2) if q < mn else 0.0) if mn else None,
            "last_issue_at": f.get("last_issue_at"),
            "issued_90d": round(issued, 2),
            "days_cover": round(q / (issued / window), 1) if issued > 0 else None,
            "supplier": f.get("supplier"), "supplier_code": f.get("supplier_code"),
            "last_arrival": f.get("last_arrival"),
            "last_counted_at": r["last_counted_at"],
        }

    @staticmethod
    def _order_qty(r):
        """(qty, basis): up to max when a max is set and not yet reached, else
        up to min. With no quantity the basis says why: "at_max" (already at
        or above max), "no_max" (a min, no max, stock at or above the min) or
        "no_levels" (neither level set)."""
        q, mn, mx = r["qty_on_hand"], r["min_stock_level"], r["max_stock_level"]
        if mx and mx > q:
            return round(mx - q, 2), "max"
        if mn and mn > q:
            return round(mn - q, 2), "min"
        if mx:
            return None, "at_max"
        if mn:
            return None, "no_max"
        return None, "no_levels"

    @staticmethod
    def _action(need, basis):
        if basis == "max":
            return f"Order {_q(need)} to max"
        if basis == "min":
            return f"Order {_q(need)} to min (no max set)"
        return NO_QTY_ACTIONS[basis]

    def _age_excess(self, store_code, section_id, excess, now):
        """Attach days-in-excess to every excess row from ONE ledger read (plus
        one stamp read for the parts with no ledger row). The filter
        (qty > max > 0) is the SQL form of "Above Maximum", so neither query
        needs an id list however many parts are over."""
        if not excess:
            return
        over = [Part.store_code == store_code, Part.is_active.is_(True),
                Part.max_stock_level > 0, SpareStock.qty_on_hand > Part.max_stock_level]
        if section_id:
            over.append(Part.section_id == section_id)
        wanted = {e["part_id"] for e in excess}
        history = {}
        rows = (db.session.query(SpareStockLedger.part_id, SpareStockLedger.balance_after,
                                 SpareStockLedger.created_at)
                .join(Part, Part.id == SpareStockLedger.part_id)
                .join(SpareStock, SpareStock.part_id == Part.id)
                .filter(*over)
                .order_by(SpareStockLedger.part_id, SpareStockLedger.created_at, SpareStockLedger.id))
        for pid, bal, at in rows:
            if pid in wanted:
                history.setdefault(pid, []).append((bal, at))

        # A part the ledger never saw move has held its quantity since the app
        # last wrote it: the latest of its count, its stock-row write and its
        # own creation is the one date that can be vouched for.
        recorded = {}
        if wanted - history.keys():
            stamps = (db.session.query(Part.id, Part.created_at, SpareStock.updated_at,
                                       SpareStock.last_counted_at)
                      .join(SpareStock, SpareStock.part_id == Part.id)
                      .filter(*over))
            for pid, *at in stamps:
                known = [_naive_utc(a) for a in at if a is not None]
                recorded[pid] = max(known) if known else None
        for e in excess:
            pid = e["part_id"]
            e.update(excess_age(history.get(pid, []), e["max_stock_level"], now, recorded.get(pid)))

    @staticmethod
    def _buckets(excess, ledger_since):
        out = {k: {"key": k, "label": label, "count": 0, "value": 0.0, "unrated": 0}
               for k, label in AGING_BUCKETS}
        out["before_tracking"]["since"] = _iso(ledger_since)
        for e in excess:
            b = out[e["aging_bucket"]]
            b["count"] += 1
            if e["excess_value"] is None:
                b["unrated"] += 1
            else:
                b["value"] += e["excess_value"]
        for b in out.values():
            # Every part in the bucket unrated: its money is unknown, not 0.
            b["value"] = None if (b["count"] and b["unrated"] == b["count"]) else round(b["value"], 2)
        return list(out.values())

    @staticmethod
    def _sort(critical, short, reorder, excess):
        def rank(r):
            return _STATUS_RANK.get(r["status"], 3)

        # Empty shelves first, then below min, then the low-cover-only parts
        # soonest to run out; within a group, the dearest restock first.
        critical.sort(key=lambda r: (rank(r), r["days_cover"] if r["days_cover"] is not None else 1e9,
                                     -(r["order_value"] or 0)))
        short.sort(key=lambda r: (rank(r), -(r["order_value"] or 0), -(r["short_qty"] or 0)))
        reorder.sort(key=lambda r: (rank(r), -(r["order_value"] or 0)))
        # Where the money is tied up; unrated excess after every rated one.
        excess.sort(key=lambda e: (e["excess_value"] is None, -(e["excess_value"] or 0), -e["excess_qty"]))
