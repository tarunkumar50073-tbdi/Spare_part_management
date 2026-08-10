"""Live Stock module — Part x latest Daily Stock Count x Coverage Day x
Rack x Supplier, assembled in one place for the Live Stock, Short Parts and
Excess Parts screens. Current Stock/Daily Consumption are both Excel-driven
for now (see COVService); Rack Number pulls from Rack/Bin Master; Last ERP
Sync Time pulls from ERPStock when a part has been synced."""
import re
import time
import threading
from datetime import datetime, timezone
from app.repositories.part_repository import PartRepository
from app.repositories.rack_bin_repository import RackBinRepository
from app.repositories.erp_stock_repository import ERPStockRepository
from app.repositories.part_supplier_repository import PartSupplierRepository
from app.repositories.store_stock_repository import StockLedgerRepository
from app.services.cov_service import COVService
from app.utils.db_tx import atomic
from app.utils.excel_io import build_export
from app.utils.pagination import paginate_list
from app.models.store import DEFAULT_STORE_CODE

# The Store Dashboard fires 15+ requests in one burst on page load, and
# several of them (Live Stock's own 2 pages, Inventory Overview's stock-
# status-summary, etc.) each independently trigger a full re-scan of every
# part through _build_rows() below. Under SQLite that queueing was most of
# the dashboard's real-world slowness. A few seconds of caching is enough
# to collapse one burst into a single computation without making the data
# meaningfully stale — the dashboard already auto-refreshes every 30s and
# tolerates that much staleness by design.
_ROWS_CACHE_TTL_SECONDS = 3
_rows_cache = {"data": None, "at": 0.0}
# Serializes the rebuild so a cold burst of ~15 simultaneous dashboard
# requests computes the row set once (the first thread builds it, the rest
# wait on the lock and then find it fresh) instead of every thread scanning
# all parts in parallel — that stampede, not the scan itself, was the bulk
# of the dashboard's load time under SQLite.
_rows_lock = threading.Lock()


class LiveStockService:
    EXPORT_COLUMNS = [
        ("Part No", "part_no"), ("Old Part No", "old_part_no"), ("Part Name", "part_name"), ("Category", "category"),
        ("Sub Category", "sub_category"), ("Supplier", "supplier_name"), ("Rack Number", "rack_no"),
        ("Live Stock", "live_stock"), ("Coverage Day", "cov_days"), ("Status", "status"),
        ("Last ERP Sync Time", "last_erp_sync"),
    ]

    def __init__(self):
        self.part_repo = PartRepository()
        self.rack_bin_repo = RackBinRepository()
        self.erp_stock_repo = ERPStockRepository()
        self.part_supplier_repo = PartSupplierRepository()
        self.ledger_repo = StockLedgerRepository()
        self.cov_service = COVService()

    def _rack_map(self):
        racks = {}
        for r in self.rack_bin_repo.list_all():
            racks.setdefault(r.part_id, []).append(f"{r.location}/{r.rack_no}")
        return racks

    def _row(self, part, rack_map, synced_map, latest_map=None, supplier_map=None, source_map=None, dead_stock_ids=frozenset()):
        status = self.cov_service.get_status(part, latest_map=latest_map)
        indicator = status["indicator"] or "Unknown"
        synced = synced_map.get(part.id)
        live_stock = status["counted_qty"]
        unit_price = float(part.unit_price) if part.unit_price is not None else None
        sources = (supplier_map or {}).get(part.id, [])
        return {
            "part_id": part.id, "part_no": part.part_no, "old_part_no": part.old_part_no,
            "part_name": part.part_name,
            # Shared by every supplier variant of the same part, so callers can
            # group them without re-deriving the rule (see _sob_stem).
            "sob_key": self._sob_stem(part.part_no),
            "category": part.category, "sub_category": part.sub_category,
            "supplier_name": part.supplier.supplier_name if part.supplier else None,
            # Multi-supplier breakdown — populated only for parts genuinely
            # sourced from more than one supplier (see PartSupplier). Empty
            # for the vast majority of single-sourced parts.
            "supplier_sources": [
                {"supplier_name": s.supplier.supplier_name, "qty": float(s.qty) if s.qty is not None else None}
                for s in sources
            ],
            # Cumulative Purchase vs In-House Production receipts — see
            # StoreDashboardService.get_part_wise_summary() docstring note.
            "source_breakdown": (source_map or {}).get(part.id),
            "rack_no": ", ".join(rack_map.get(part.id, [])) or None,
            "uom": part.uom,
            "live_stock": live_stock,
            "cov_days": status["cov_days"],
            "status": indicator,
            # The one shared short rule, decided here so every consumer reads
            # the same answer instead of re-testing cov_days themselves. Note
            # `status` above stays as-is: "Out of Stock" is worth showing as
            # its own badge even though it counts as short.
            "is_short": self.cov_service.is_short(part, status, dead_stock_ids),
            "unit_price": unit_price,
            "total_value": round(live_stock * unit_price, 2) if live_stock is not None and unit_price is not None else None,
            "last_erp_sync": synced.synced_at.isoformat() if synced else None,
        }

    @classmethod
    def invalidate_rows_cache(cls):
        """Call after any write that changes what a row shows (stock count
        submit, SRV verify/consume, rack/bin or part edit) so the next read
        isn't served a stale cached row for the rest of the TTL window."""
        _rows_cache["data"] = None

    def _build_rows(self):
        parts = self.part_repo.get_active(DEFAULT_STORE_CODE)
        rack_map = self._rack_map()
        synced_map = {row.part_id: row for row in self.erp_stock_repo.list_all()}
        latest_map = self.cov_service.get_latest_map()
        supplier_map = self.part_supplier_repo.map_by_part()
        source_map = self.ledger_repo.source_breakdown_map()
        dead_stock_ids = self.rack_bin_repo.get_dead_stock_part_ids()

        return [
            self._row(p, rack_map, synced_map, latest_map=latest_map, supplier_map=supplier_map,
                      source_map=source_map, dead_stock_ids=dead_stock_ids)
            for p in parts
        ]

    def _cached_rows(self):
        def fresh():
            return _rows_cache["data"] is not None and (time.monotonic() - _rows_cache["at"]) <= _ROWS_CACHE_TTL_SECONDS

        if fresh():
            return _rows_cache["data"]
        with _rows_lock:
            # Re-check inside the lock: a thread that waited here while
            # another was rebuilding should reuse that result, not rebuild.
            if fresh():
                return _rows_cache["data"]
            _rows_cache["data"] = self._build_rows()
            _rows_cache["at"] = time.monotonic()
            return _rows_cache["data"]

    def _all_rows(self, keyword=None, category=None, sub_category=None, status=None, supplier=None, critical=False):
        rows = self._cached_rows()

        if critical:
            # The shared short rule (COVService.is_short), precomputed per row
            # in _row(). The Production Status card drills through to here, so
            # filtering on status="Short" instead used to drop the out-of-stock
            # parts and the card said 11 while the list showed 8.
            rows = [r for r in rows if r["is_short"]]

        if keyword:
            kw = keyword.lower()
            matched = [
                r for r in rows
                if kw in r["part_no"].lower() or kw in r["part_name"].lower()
                or (r["old_part_no"] and kw in r["old_part_no"].lower())
            ]
            # A part bought from several suppliers is carried as one part
            # number per supplier, so a search that returns only the number
            # typed hides the thing you usually came to find out: where the
            # rest of this part's stock is sitting. Searching 7S185-X7P01-A
            # (short, 32,000) now also returns 7S185-X7P01-N (88,000). The
            # siblings are additions to the result, not a change to how any
            # part is judged — each is still short or excess on its own.
            keys = {r["sob_key"] for r in matched if r.get("sob_key")}
            matched_ids = {r["part_id"] for r in matched}
            rows = [r for r in rows if r["part_id"] in matched_ids or r.get("sob_key") in keys]
        if category:
            rows = [r for r in rows if r["category"] == category]
        if sub_category:
            rows = [r for r in rows if r["sub_category"] == sub_category]
        if status:
            rows = [r for r in rows if r["status"] == status]
        if supplier:
            # Exact name, not a substring: the dashboard links here with a
            # supplier picked from the data, so a loose match would quietly
            # pull in a differently-named supplier.
            rows = [r for r in rows if r["supplier_name"] == supplier]
        return rows

    def export_excel(self, keyword=None, category=None, status=None, supplier=None, critical=False):
        return build_export(self.EXPORT_COLUMNS, self._all_rows(keyword, category, status=status, supplier=supplier, critical=critical))

    def list_all(self, keyword=None, category=None, status=None, supplier=None, critical=False, page=1, per_page=20):
        return paginate_list(self._all_rows(keyword, category, status=status, supplier=supplier, critical=critical), page, per_page)

    # A part sourced from several suppliers is carried as one part number per
    # supplier, distinguished by a trailing supplier code (-N NEEMRANA, -E
    # ELITE, -W WAHI, -A ATMA, -K KAPILA ...). Nothing in the data links them:
    # old_part_no carries the same suffix on most families, and the
    # description drifts ("SPACER- D (WASHER)" vs "SPACER D  ISS"). So the
    # shared stem is the only honest key — used strictly as a lookup, never
    # shown: every part number stays whole on screen.
    _SOB_SUFFIX = re.compile(r"-[A-Z]{1,2}$")

    @classmethod
    def _sob_stem(cls, part_no):
        return cls._SOB_SUFFIX.sub("", (part_no or "").strip())

    def _sob_map(self, rows):
        """stem -> sibling rows, only for stems genuinely carrying more than
        one supplier variant."""
        by_stem = {}
        for row in rows:
            by_stem.setdefault(self._sob_stem(row["part_no"]), []).append(row)
        return {stem: group for stem, group in by_stem.items() if len(group) > 1}

    def list_short(self, category=None, supplier=None):
        """Short Parts screen — includes Out of Stock, sorted longest-short-first.
        Excludes Dead Stock (Mezzanine-racked, slow/non-moving parts with no
        daily_consumption) — an Out-of-Stock reading there isn't a real
        production shortage.

        category/supplier let the dashboard's Most Affected tiles drill in
        here rather than to Live Stock: someone asking "which parts are
        short?" wants the Short Parts screen, SOB grouping and all. A group
        is kept when any of its short variants matches, and it still shows
        every short variant it has — filtering the family apart would defeat
        the grouping."""
        dead_stock_ids = self.rack_bin_repo.get_dead_stock_part_ids()
        latest_map = self.cov_service.get_latest_map()
        rows = []
        for part in self.part_repo.get_active(DEFAULT_STORE_CODE):
            status = self.cov_service.get_status(part, latest_map=latest_map)
            if not self.cov_service.is_short(part, status, dead_stock_ids):
                continue
            rows.append({
                "part_id": part.id, "part_no": part.part_no, "part_name": part.part_name,
                "category": part.category, "sub_category": part.sub_category,
                "supplier_name": part.supplier.supplier_name if part.supplier else None,
                "live_stock": status["counted_qty"], "cov_days": status["cov_days"],
                "short_since": part.short_since.isoformat() if part.short_since else None,
            })

        # One row per part, not per supplier variant. The same part bought
        # from three suppliers is three part numbers, and when two of them run
        # short the flat list showed that part twice — each time from the
        # other's point of view. Grouped, a short part appears once: the
        # variants that are short, and alongside them what the remaining
        # suppliers are holding. Status is still judged per variant; this only
        # shows where the stock already is.
        sob_map = self._sob_map(self._cached_rows())

        def variant(v):
            return {
                "part_no": v["part_no"], "supplier_name": v["supplier_name"],
                "live_stock": v["live_stock"], "cov_days": v["cov_days"], "status": v["status"],
            }

        grouped = {}
        for row in rows:
            grouped.setdefault(self._sob_stem(row["part_no"]), []).append(row)

        result = []
        for stem, shorts in grouped.items():
            family = sob_map.get(stem) or []
            short_nos = {s["part_no"] for s in shorts}
            others = [variant(v) for v in sorted(family, key=lambda v: v["part_no"]) if v["part_no"] not in short_nos]
            stocks = [v["live_stock"] for v in (family or shorts) if v["live_stock"] is not None]
            first = shorts[0]
            result.append({
                "sob_key": stem,
                "part_name": first["part_name"],
                "category": first["category"], "sub_category": first["sub_category"],
                # Every variant of this part that is short right now.
                "short_variants": [
                    {
                        "part_id": s["part_id"], "part_no": s["part_no"],
                        "supplier_name": s["supplier_name"],
                        "live_stock": s["live_stock"], "cov_days": s["cov_days"],
                        "short_since": s["short_since"],
                    }
                    for s in sorted(shorts, key=lambda s: s["part_no"])
                ],
                "other_suppliers": others,
                "sob_total": sum(stocks) if stocks else None,
                "short_since": min((s["short_since"] for s in shorts if s["short_since"]), default=None),
            })

        if category:
            result = [r for r in result if any(s["category"] == category for s in grouped[r["sob_key"]])]
        if supplier:
            result = [r for r in result if any(v["supplier_name"] == supplier for v in r["short_variants"])]

        result.sort(key=lambda r: r["short_since"] or "")
        return result

    def list_excess(self):
        """Excess Parts screen — Excess Since + Days In Excess (yellow 1-7 /
        orange 8-15 / red >15, colored client-side), sorted oldest-first.

        Days are counted in calendar days rather than 24h blocks, and
        `added_today` marks the parts that were not on yesterday's list. A
        part that sat in excess for a week, dropped off, then came back four
        days later counts as added today — it does not resume its old total,
        because excess_since is cleared on the way out.

        Re-syncs short_since/excess_since as it goes. This list is a pure
        function of the latest Daily Stock Count, daily_consumption and the
        per-part thresholds, so recomputing here catches every way a part can
        enter or leave it — including a Part Master edit to daily_consumption
        or target_cov_days_max, which no stock count would have picked up and
        which would otherwise leave a stale stamp behind. Writing during a
        read follows the same request-driven pattern as
        StoreDashboardService.record_snapshot(); the whole sweep shares one
        transaction and writes nothing when nothing changed.
        """
        # Local calendar day — excess_since is stored UTC and converted below,
        # so both sides of the day comparison are in the store's own timezone.
        today = datetime.now().date()
        latest_map = self.cov_service.get_latest_map()

        excess = []
        with atomic():
            for part in self.part_repo.get_active(DEFAULT_STORE_CODE):
                status = self.cov_service.get_status(part, latest_map=latest_map)
                self.cov_service.sync_since_fields(part, status)
                if status["basis"] == "COV" and status["indicator"] == "Excess":
                    excess.append((part, status))

        rows = []
        for part, status in excess:
            # SQLite hands DateTime(timezone=True) columns back naive even
            # though everything is written as UTC (see utcnow()) — attach the
            # tz before converting, or this raises naive-vs-aware TypeError
            # and the whole screen 500s. Serializing the aware value also
            # keeps the offset on the wire, so the browser renders Excess
            # Since in local time instead of reading UTC as local.
            since = part.excess_since
            if since is not None and since.tzinfo is None:
                since = since.replace(tzinfo=timezone.utc)
            since_date = since.astimezone().date() if since else None
            rows.append({
                "part_id": part.id, "part_no": part.part_no, "part_name": part.part_name,
                "category": part.category, "sub_category": part.sub_category,
                "live_stock": status["counted_qty"], "cov_days": status["cov_days"],
                "excess_since": since.isoformat() if since else None,
                "days_in_excess": (today - since_date).days if since_date else None,
                "added_today": since_date == today,
            })
        rows.sort(key=lambda r: -(r["days_in_excess"] or 0))
        return rows

    def top_oldest_excess(self, limit=10):
        return self.list_excess()[:limit]
