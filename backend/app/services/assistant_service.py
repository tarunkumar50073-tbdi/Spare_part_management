"""A small, self-contained in-app assistant.

No external LLM and no subscription — it answers from THIS app's own data and
screens. Given a question it (1) reads the live spare-stock figures for a few
common intents (a part's stock, the short / reorder / excess buckets, the total
stock value, the most-consumed parts) and (2) suggests the screens that match,
each with a deep link the UI can open. Understands plain English and the common
Hinglish a keeper actually types.

Suggestions and the screen catalogue respect the caller's rights: a screen the
user may not open (per-module or admin-only) is never suggested or listed, so a
link never lands on an "access restricted" dead-end.
"""
from urllib.parse import quote

from app.services.service_catalog import SERVICES
from app.services.spare_stock_service import SpareStockService

STORE = "MAINTENANCE"

# Query phrases -> the stock status they ask about.
_STATUS_INTENTS = [
    (("out of stock", "zero stock", "no stock", "khatam", "khtm", "nil stock", "stock nahi", "stock zero"),
     "Out of Stock"),
    (("below min", "below minimum", "under min", "kam se kam", "minimum se kam", "min se kam", "short stock"),
     "Below Minimum"),
    (("reorder", "re-order", "to order", "order karna", "mangwana", "mangana", "needs order", "purchase"),
     "Reorder"),
    (("above max", "above maximum", "over max", "excess", "extra stock", "zyada stock", "jyada stock", "surplus"),
     "Above Maximum"),
    (("never counted", "not counted", "uncounted", "count nahi", "gina nahi", "no count"),
     "Not Counted"),
]
_VALUE_WORDS = ("stock value", "total value", "kitne ka", "kitna paisa", "worth", "valuation", "inventory value")
_CONSUMPTION_WORDS = ("consumption", "consume", "consumed", "kharch", "khapat", "most used", "usage", "top issued")

_STATUS_ROUTE = "/store-stock-spare"


def _has(text, words):
    return any(w in text for w in words)


def _allowed(service, user):
    """May this user open this screen? Mirrors the sidebar's gating: admin-only
    screens need an admin, module-gated screens need that module's view right,
    and an ungated screen is open to any signed-in user. A None user (e.g. a
    machine caller) gets only ungated screens."""
    if service.get("admin") and not (user and user.is_admin):
        return False
    mod = service.get("mod")
    if mod and not (user and user.can(mod)):
        return False
    return True


class AssistantService:
    def __init__(self):
        self.stock = SpareStockService()

    def services(self, user=None):
        """The screen catalogue for the launcher — only screens this user may open."""
        return [s for s in SERVICES if _allowed(s, user)]

    # ---- the one entry point ----

    def ask(self, query, user=None):
        q = (query or "").strip()
        ql = q.lower()
        if not q:
            return self._reply("Type what you're looking for — a part number, a stock status "
                               "(short, reorder, excess), a report, or a screen name.", [], self._suggest("", user))

        if _has(ql, _VALUE_WORDS):
            return self._value_answer(user)
        if _has(ql, _CONSUMPTION_WORDS):
            return self._consumption_answer(user)

        status = self._status_for(ql)
        if status:
            return self._status_answer(status, user)

        parts = self._search_parts(q)
        if parts:
            return self._reply(
                f"Found {len(parts)} part{'s' if len(parts) != 1 else ''} matching “{q}”.",
                parts, self._suggest(ql, user))

        suggestions = self._suggest(ql, user)
        if suggestions:
            return self._reply(f"I couldn't find stock data for “{q}”, but these screens might help:",
                               [], suggestions)
        return self._reply(
            f"Nothing matched “{q}”. Try a part number, or a word like stock, reorder, scan, or report.",
            [], self._suggest("", user))

    # ---- intent handlers ----

    def _value_answer(self, user):
        s = self.stock.get_summary(STORE)
        val = s.get("stock_value") or 0
        answer = (f"Total counted stock value is ₹{val:,.0f} across {s.get('valued_parts', 0)} "
                  f"priced parts. {s.get('counted_parts', 0)} of {s.get('total_parts', 0)} parts are counted.")
        results = [{
            "title": "Stock value", "subtitle": f"{s.get('valued_parts', 0)} parts carry a rate",
            "right": f"₹{val:,.0f}", "route": _STATUS_ROUTE, "kind": "stat",
        }]
        return self._reply(answer, results, self._suggest("stock value", user))

    def _consumption_answer(self, user):
        rows = self.stock.top_consumed(STORE, limit=6, days=30)
        if not rows:
            return self._reply("No parts have been issued in the last 30 days.", [],
                               self._suggest("consumption", user))
        results = [{
            "title": r["part_no"], "subtitle": r.get("part_name") or "",
            "right": f"{r['qty']:,.0f} used", "route": "/store/MAINTENANCE", "kind": "part",
        } for r in rows]
        return self._reply("Most-consumed parts in the last 30 days:", results,
                           self._suggest("consumption", user))

    def _status_answer(self, status, user):
        if status == "Reorder":
            # reorder_list returns {items, count, total_reorder_value}.
            rows = (self.stock.reorder_list(STORE) or {}).get("items", [])
        else:
            rows = self.stock.list_by_status(STORE, status, limit=50) or []
        total = len(rows)
        label = {
            "Out of Stock": "out of stock", "Below Minimum": "below minimum",
            "Reorder": "that need reordering (at or below minimum)", "Above Maximum": "above maximum",
            "Not Counted": "never counted",
        }.get(status, status.lower())
        answer = (f"{total} part{'s' if total != 1 else ''} {label}."
                  if total else f"No parts are {label} right now.")
        results = [self._row_result(r) for r in rows[:6]]
        # Every bucket lands on Store Stock, which has the matching filter chips.
        for r in results:
            r["route"] = _STATUS_ROUTE
        return self._reply(answer, results, self._suggest(status.lower(), user))

    # ---- part search ----

    def _search_parts(self, q):
        tokens = [t for t in q.lower().split() if len(t) > 1]
        if not tokens:
            return []
        out = []
        for r in self.stock.list_stock(STORE):
            hay = f"{r.get('part_no', '')} {r.get('part_name', '')} {r.get('location', '')}".lower()
            if all(t in hay for t in tokens):
                out.append(self._row_result(r))
            if len(out) >= 6:
                break
        return out

    @staticmethod
    def _row_result(r):
        bits = []
        if r.get("qty_on_hand") is not None:
            bits.append(f"In stock {r['qty_on_hand']:,.0f}")
        if r.get("location"):
            bits.append(r["location"])
        return {
            "title": r.get("part_no"),
            "subtitle": r.get("part_name") or "",
            "detail": " · ".join(bits),
            "right": r.get("status"),
            "route": f"/parts?keyword={quote(str(r.get('part_no') or ''))}",
            "kind": "part",
        }

    # ---- helpers ----

    @staticmethod
    def _status_for(ql):
        for words, status in _STATUS_INTENTS:
            if _has(ql, words):
                return status
        return None

    @staticmethod
    def _suggest(ql, user=None, limit=3):
        """Screens whose title/keywords overlap the query — the "did you mean this
        page?" chips, limited to screens the user may actually open."""
        pool = [s for s in SERVICES if _allowed(s, user)]
        tokens = [t for t in ql.split() if len(t) > 1]
        if not tokens:
            picks = [s for s in pool if s["key"] in ("store_stock", "scan_part", "part_master")]
        else:
            scored = []
            for s in pool:
                hay = (s["title"] + " " + " ".join(s["keywords"])).lower()
                score = sum(1 for t in tokens if t in hay)
                # A whole-phrase hit on the title ranks a screen higher.
                if ql.strip() and ql.strip() in hay:
                    score += 2
                if score:
                    scored.append((score, s))
            scored.sort(key=lambda x: x[0], reverse=True)
            picks = [s for _, s in scored[:limit]]
        return [{"title": s["title"], "route": s["route"], "icon": s["icon"]} for s in picks[:limit]]

    @staticmethod
    def _reply(answer, results, suggestions):
        return {"answer": answer, "results": results, "suggestions": suggestions}
