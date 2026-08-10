"""Shared Coverage Day calculation — used by Daily Stock Count, Live Stock,
Short/Excess Parts screens and the Store Dashboard.

Coverage Day = latest Daily Stock Count qty / Part.daily_consumption. Both
inputs are Excel-uploaded for now (Daily Stock Count already was; Part's
daily_consumption is a new Part Master field) — same Excel-now/API-later
shape as everywhere else in this app, real ERP feed can replace either
input later without callers changing.

Short if below target_cov_days_min (default 1 day). Excess if above
target_cov_days_max, falling back to DEFAULT_EXCESS_COV_DAYS (5) when that
per-part override isn't set. `basis` comes back "NONE" when either input
is missing, so callers can fall back to the older min/max qty-threshold
indicator instead. A part with zero counted stock is always flagged
out-of-stock/short regardless of whether daily_consumption is known."""
from app.models.base import utcnow
from app.repositories.stock_count_repository import StockCountRepository
from app.repositories.part_repository import PartRepository

DEFAULT_EXCESS_COV_DAYS = 5


class COVService:
    def __init__(self):
        self.stock_count_repo = StockCountRepository()
        self.part_repo = PartRepository()

    def get_latest_map(self):
        """Latest Daily Stock Count per part_id in a single query — pass this
        into get_status() when processing many parts in a loop, so the loop
        doesn't issue one query per part (N+1)."""
        return self.stock_count_repo.latest_by_part_map()

    def get_status(self, part, latest_map=None):
        latest = latest_map.get(part.id) if latest_map is not None else self.stock_count_repo.get_latest_by_part(part.id)
        counted_qty = float(latest.counted_qty) if latest else None
        daily_consumption = float(part.daily_consumption) if part.daily_consumption else None

        base = {
            "counted_qty": counted_qty,
            "count_date": latest.count_date.isoformat() if latest else None,
            "daily_consumption": daily_consumption,
            "cov_days": None,
            "indicator": None,
            "basis": "NONE",
            "out_of_stock": counted_qty == 0,
        }
        if counted_qty is None:
            return base
        if counted_qty == 0:
            base["indicator"] = "OutOfStock"
            return base
        if not daily_consumption or daily_consumption <= 0:
            return base

        cov_days = counted_qty / daily_consumption
        excess_threshold = float(part.target_cov_days_max) if part.target_cov_days_max is not None else DEFAULT_EXCESS_COV_DAYS
        if cov_days < float(part.target_cov_days_min or 0):
            indicator = "Short"
        elif cov_days > excess_threshold:
            indicator = "Excess"
        else:
            indicator = "Normal"

        base.update({"cov_days": round(cov_days, 2), "indicator": indicator, "basis": "COV"})
        return base

    def is_short(self, part, status, dead_stock_ids=frozenset()):
        """The single definition of "short", used by every screen and count.

        Short = Coverage below the part's target_cov_days_min, OR no stock at
        all. Zero stock has no Coverage Day to compare (0 / consumption says
        nothing), so a purely COV-based test silently dropped exactly the
        parts in the worst shape — which is how the dashboard card counted 12
        while the KPI counted 8 off the same data.

        Dead Stock is excluded: parts racked at Mezzanine are deliberately
        parked slow/non-moving stock, so an Out-of-Stock reading there isn't
        a production shortage. Callers pass the id set once rather than have
        this re-query per part.
        """
        if part.id in dead_stock_ids:
            return False
        if status["out_of_stock"]:
            return True
        return (
            status["basis"] == "COV"
            and status["cov_days"] is not None
            and status["cov_days"] < float(part.target_cov_days_min or 0)
        )

    def is_critical(self, part):
        """Today's Production Critical Parts rule: Coverage < 1 Day OR Out of Stock."""
        status = self.get_status(part)
        if status["out_of_stock"]:
            return True
        return status["basis"] == "COV" and status["cov_days"] is not None and status["cov_days"] < 1

    def refresh_since_tracking(self, part):
        """Called whenever this part's Daily Stock Count changes (submit/
        bulk import) — sets short_since/excess_since the first time a part
        enters that state, clears it when it leaves. No scheduled job:
        recomputed exactly at the point the underlying data changes."""
        return self.sync_since_fields(part, self.get_status(part))

    def sync_since_fields(self, part, status):
        """Same set/clear rule as refresh_since_tracking(), but driven by an
        already-computed status so a caller looping over every part doesn't
        re-query each one's latest count (N+1).

        The stamp is what "since when has this part been continuously short/
        excess" rests on, so it has to survive every route in and out of the
        state — not just a Daily Stock Count. Coverage Day is
        counted_qty / daily_consumption judged against target_cov_days_max,
        and a Part Master edit to either of the latter two flips a part in or
        out of the list with no stock count involved. Leaving the stamp
        untouched there would make a part that left and came back keep
        counting from its first spell, so LiveStockService re-syncs from the
        live list as well.

        Returns True when the part row actually changed.
        """
        is_short = status["out_of_stock"] or (status["basis"] == "COV" and status["indicator"] == "Short")
        is_excess = status["basis"] == "COV" and status["indicator"] == "Excess"

        fields = {}
        if is_short and not part.short_since:
            fields["short_since"] = utcnow()
        elif not is_short and part.short_since:
            fields["short_since"] = None
        if is_excess and not part.excess_since:
            fields["excess_since"] = utcnow()
        elif not is_excess and part.excess_since:
            fields["excess_since"] = None

        if not fields:
            return False
        self.part_repo.update(part, **fields)
        return True
