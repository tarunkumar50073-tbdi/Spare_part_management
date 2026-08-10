"""Store dashboard aggregation: live child-parts stock, short/excess
indication, part-wise summary, and process-flow pipeline counts.

KPI business rules (per the Toyota Boshoku redesign spec):
- Short Parts: one definition across every screen and count — see
  COVService.is_short(). Coverage below the part's target_cov_days_min, OR
  zero stock (which has no Coverage Day to compare at all), with Dead Stock
  excluded. This page, Live Stock and the Short Parts screen all call it, so
  the same data can no longer produce three different totals.
- Excess Parts (Rack Capacity Exceeded): stock > Rack Capacity (sum of
  bin_capacity x bins_allocated across that part's Rack/Bin entries),
  falling back to Part.max_stock_level when no rack/bin entry exists yet.
- Pending SRVs: SRVs not yet at a terminal status (was "Open SRVs").
- Receiving Today / Issued to Production: SRVs verified / supplied today.
- Pending Gate Entries is intentionally not a KPI here — gate entry is
  fully ERP-API driven now, so there's no manual "pending" backlog to
  surface; PENDING_UNLOAD is still a real workflow stage, just not a
  dashboard card.
- Pending RQC/Tool Room/Production-Consumption clearance: counts of SRVs
  sitting in INSPECTION_PENDING / FORWARDED_TOOL_ROOM / SUPPLIED, i.e.
  waiting on another department's own ERP (RQC, Maintenance, Production)
  to call back — visibility only, this app can't action these itself.
- Short BOP Parts for Today's Production (critical list, distinct from the
  <1 Day Stock KPI card above): COV Days < CRITICAL_COV_THRESHOLD (0.5) —
  tighter than the general Short KPI, meant to flag parts that will run
  out within today's shift specifically."""
from datetime import date, datetime, timedelta, timezone
from sqlalchemy import func
from app.extensions import db
from app.models.srv import SRV, STATUSES
from app.models.part import CATEGORIES
from app.repositories.part_repository import PartRepository
from app.repositories.srv_repository import SRVRepository
from app.repositories.store_stock_repository import PartStockRepository, StockLedgerRepository
from app.repositories.rack_bin_repository import RackBinRepository
from app.repositories.erp_stock_repository import ERPStockRepository
from app.repositories.dashboard_snapshot_repository import DashboardSnapshotRepository
from app.repositories.part_supplier_repository import PartSupplierRepository
from app.repositories.physical_stock_repository import PhysicalStockRepository
from app.services.cov_service import COVService
from app.services.store_stock_service import StoreStockService
from app.services.rack_bin_service import RackBinService
from app.repositories.holding_entry_repository import HoldingEntryRepository
from app.repositories.notification_repository import NotificationRepository
from app.utils.db_tx import atomic
from app.models.store import DEFAULT_STORE_CODE

CRITICAL_COV_THRESHOLD = 0.5
SHORT_STOCK_THRESHOLD = 1  # matches the "Short Parts (<1 Day Stock)" KPI card
CHART_DAYS = 14
LONG_HOLDING_DAYS = 2
TREND_DAYS = 7
COVERAGE_BUCKETS = ["< 1 Day (Short)", "1 - 5 Days", "5 - 15 Days", "> 15 Days (Excess)", "Unknown"]


class StoreDashboardService:
    def __init__(self):
        self.part_repo = PartRepository()
        self.srv_repo = SRVRepository()
        self.stock_repo = PartStockRepository()
        self.ledger_repo = StockLedgerRepository()
        self.rack_bin_repo = RackBinRepository()
        self.erp_stock_repo = ERPStockRepository()
        self.snapshot_repo = DashboardSnapshotRepository()
        self.cov_service = COVService()
        self.store_stock_service = StoreStockService()
        self.rack_bin_service = RackBinService()
        self.holding_repo = HoldingEntryRepository()
        self.notification_repo = NotificationRepository()
        self.part_supplier_repo = PartSupplierRepository()
        self.physical_repo = PhysicalStockRepository()

    def _stock_by_part(self):
        stock_by_part = {}
        for s in self.stock_repo.list_all():
            stock_by_part.setdefault(s.part_id, {})[s.location] = float(s.qty_on_hand)
        return stock_by_part

    @staticmethod
    def _qty_indicator(total, part):
        if total < float(part.min_stock_level or 0):
            return "Short"
        if part.max_stock_level is not None and total > float(part.max_stock_level):
            return "Excess"
        return "Normal"

    def _resolve_indicator(self, part, total_qty, latest_map=None):
        """COV-day indicator when the SCM forecast/BOM makes a peak
        requirement available for this part; otherwise falls back to the
        older min/max qty-threshold indicator. Used by the detailed
        Part-wise Summary table (per-part target_cov_days_min/max), which
        is intentionally more nuanced than the dashboard KPI cards below."""
        cov_status = self.cov_service.get_status(part, latest_map=latest_map)
        if cov_status["basis"] == "COV":
            return cov_status["indicator"], cov_status["cov_days"]
        return self._qty_indicator(total_qty, part), None

    def _is_short(self, part, status, dead_stock_ids):
        """One definition for every count on this page — see
        COVService.is_short(). Out-of-stock parts count as short; Dead Stock
        does not."""
        return self.cov_service.is_short(part, status, dead_stock_ids)

    @staticmethod
    def _is_excess_status(status):
        """Excess Parts: COV Days > target_cov_days_max (falls back to
        DEFAULT_EXCESS_COV_DAYS when unset) — same COV-basis rule as
        _is_short, no longer the physical Rack Capacity check."""
        return status["basis"] == "COV" and status["indicator"] == "Excess"

    @staticmethod
    def _utc_iso(value):
        """Stamps are written UTC but SQLite hands them back naive — attach
        the offset before serializing, or the browser reads a UTC time as
        local and shows it hours off."""
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()

    @staticmethod
    def _joined_excess_today(part, today):
        """excess_since is cleared the moment a part drops off the Excess
        list, so a stamp dated today means it joined today — a part that was
        excess for a week, left, then came back counts as new, not as
        resuming its old run. Mirrors the per-row `added_today` flag from
        LiveStockService.list_excess()."""
        since = part.excess_since
        if since is None:
            return False
        # SQLite hands DateTime(timezone=True) back naive though it is stored
        # UTC; convert to local so both sides of the comparison are the
        # store's own calendar day.
        if since.tzinfo is None:
            since = since.replace(tzinfo=timezone.utc)
        return since.astimezone().date() == today

    def _is_short_kpi(self, part, latest_map=None, dead_stock_ids=frozenset()):
        return self._is_short(part, self.cov_service.get_status(part, latest_map=latest_map), dead_stock_ids)

    def _is_excess_kpi(self, part, latest_map=None):
        return self._is_excess_status(self.cov_service.get_status(part, latest_map=latest_map))

    def get_summary(self):
        """KPI set per the ERP-driven redesign spec — trimmed to exactly the
        cards called for: Pending SRV, Pending Put Away, Pending RQC,
        Available Store Stock, Today's SRV, Today's Verification, Today's
        Put Away, Low Stock, Excess Stock, Rack Utilization. All figures are
        ERP-synced-stock-aware via StoreStockService/COVService."""
        parts = self.part_repo.get_active(DEFAULT_STORE_CODE)
        latest_map = self.cov_service.get_latest_map()
        today = date.today()

        low_stock = 0
        excess_stock = 0
        excess_added_today = 0
        # Same self-healing since-tracking sweep LiveStockService.list_excess()
        # does, so excess_added_today stays honest for someone who only ever
        # opens the dashboard. One shared transaction, and nothing is written
        # unless a part actually entered or left short/excess.
        dead_stock_ids = self.rack_bin_repo.get_dead_stock_part_ids()
        with atomic():
            for part in parts:
                status = self.cov_service.get_status(part, latest_map=latest_map)
                self.cov_service.sync_since_fields(part, status)
                if self._is_short(part, status, dead_stock_ids):
                    low_stock += 1
                if self._is_excess_status(status):
                    excess_stock += 1
                    if self._joined_excess_today(part, today):
                        excess_added_today += 1

        available_parts = len(self.store_stock_service.get_summary()["available"])

        open_holding = self.holding_repo.search().filter(
            self.holding_repo.model.holding_status != "COMPLETED"
        ).all()
        holding_area_parts = len({e.part_id for e in open_holding})
        holding_area_qty = sum(float(e.remaining_qty) for e in open_holding)

        category_counts = {c: 0 for c in CATEGORIES}
        for part in parts:
            if part.category in category_counts:
                category_counts[part.category] += 1

        self.record_snapshot(len(parts), low_stock, excess_stock, category_counts)

        return {
            "pending_srv": self.srv_repo.count_pre_srv(),
            "pending_put_away": self.srv_repo.count_pending_put_away(),
            "pending_rqc": self.srv_repo.search(status="INSPECTION_PENDING").count(),
            "available_store_stock": available_parts,
            "todays_srv": self.srv_repo.count_created_on(today),
            "todays_verification": self.srv_repo.count_verified_on(today),
            "todays_put_away": self.srv_repo.count_put_away_on(today),
            "todays_issue": self.ledger_repo.count_todays_consumption(today),
            "low_stock": low_stock,
            "excess_stock": excess_stock,
            # Parts that joined the Excess list today — a membership figure,
            # deliberately not the same thing as vs_yesterday.excess_stock
            # below, which is a count delta. 3 parts leaving and 3 joining
            # shows as "no change" there but "+3 added" here.
            "excess_added_today": excess_added_today,
            "rack_utilization": self.rack_bin_service.get_utilization_pct(),
            "holding_area_parts": holding_area_parts,
            "holding_area_qty": holding_area_qty,
            "total_parts": len(parts),
            "category_counts": category_counts,
            "vs_yesterday": self.get_vs_yesterday(len(parts), low_stock, excess_stock, category_counts),
        }

    def record_snapshot(self, total_parts, short_parts, excess_parts, category_counts):
        """Upserts today's row so the Inventory Trend chart accumulates one
        data point per calendar day — called from get_summary() on every
        dashboard load, no scheduler needed (matches this app's
        request-driven style everywhere else)."""
        self.snapshot_repo.upsert(date.today(), total_parts, short_parts, excess_parts, category_counts)

    def get_vs_yesterday(self, total_parts, short_parts, excess_parts, category_counts):
        """Delta against the most recent snapshot before today — powers the
        KPI cards' "+N vs yesterday" line. None per field until a prior
        day's snapshot actually exists."""
        prior = self.snapshot_repo.get_before(date.today())
        if not prior:
            return None
        prior_categories = prior.category_counts
        return {
            "total_parts": total_parts - prior.total_parts,
            "low_stock": short_parts - prior.short_parts,
            "excess_stock": excess_parts - prior.excess_parts,
            "category_counts": {c: category_counts[c] - prior_categories.get(c, 0) for c in CATEGORIES},
        }

    def get_trend(self, days=TREND_DAYS):
        rows = self.snapshot_repo.list_recent(days)
        return [{
            "date": r.snapshot_date.isoformat(),
            "total_parts": r.total_parts, "short_parts": r.short_parts, "excess_parts": r.excess_parts,
        } for r in rows]

    def get_category_breakdown(self):
        """Short/Excess parts split by category — powers the two category
        donut charts. Reuses the exact same _is_short_kpi/_is_excess_kpi
        rules as the Short/Excess Parts KPI cards, just grouped by category
        instead of a flat count."""
        parts = self.part_repo.get_active(DEFAULT_STORE_CODE)
        latest_map = self.cov_service.get_latest_map()
        dead_stock_ids = self.rack_bin_repo.get_dead_stock_part_ids()

        short_by_cat = {c: 0 for c in CATEGORIES}
        excess_by_cat = {c: 0 for c in CATEGORIES}
        for part in parts:
            if part.category not in short_by_cat:
                continue
            if self._is_short_kpi(part, latest_map=latest_map, dead_stock_ids=dead_stock_ids):
                short_by_cat[part.category] += 1
            if self._is_excess_kpi(part, latest_map=latest_map):
                excess_by_cat[part.category] += 1

        return {"short_by_category": short_by_cat, "excess_by_category": excess_by_cat}

    def get_coverage_distribution(self):
        """Buckets every active part's Coverage Day value for the donut
        chart: <1 (Short) / 1-5 / 5-15 / >15 (Excess) / Unknown (no
        daily_consumption or no stock count yet, so COV can't be computed —
        this is a data gap, not a business classification; only parts
        actually racked at Mezzanine are Dead Stock/slow-moving, see
        InventoryOverviewService)."""
        counts = {b: 0 for b in COVERAGE_BUCKETS}
        latest_map = self.cov_service.get_latest_map()
        for part in self.part_repo.get_active(DEFAULT_STORE_CODE):
            status = self.cov_service.get_status(part, latest_map=latest_map)
            if status["out_of_stock"]:
                counts["< 1 Day (Short)"] += 1
                continue
            if status["basis"] != "COV" or status["cov_days"] is None:
                counts["Unknown"] += 1
                continue
            cov = status["cov_days"]
            if cov < 1:
                counts["< 1 Day (Short)"] += 1
            elif cov <= 5:
                counts["1 - 5 Days"] += 1
            elif cov <= 15:
                counts["5 - 15 Days"] += 1
            else:
                counts["> 15 Days (Excess)"] += 1
        return counts

    def get_last_erp_sync(self):
        latest = db.session.query(func.max(self.erp_stock_repo.model.synced_at)).scalar()
        return latest.isoformat() if latest else None

    def get_alerts(self):
        """Alert panel — 4 buckets. First 3 come from active Notifications;
        Long Pending Holding Parts is computed directly from HoldingEntry
        rows rather than stored as its own notification type, since it's
        purely a function of holding_date age."""
        rack_space = self.notification_repo.list_active("RACK_SPACE_AVAILABLE")
        fifo_warning = self.notification_repo.list_active("FIFO_VIOLATION_RISK")
        holding_pending = self.notification_repo.list_active("ASSIGNED_RACK_FULL")

        cutoff = datetime.now(timezone.utc) - timedelta(days=LONG_HOLDING_DAYS)
        long_pending = (
            self.holding_repo.search().filter(
                self.holding_repo.model.holding_status != "COMPLETED",
                self.holding_repo.model.holding_date < cutoff,
            ).all()
        )

        def _fmt(n):
            return {"id": n.id, "message": n.message, "created_at": n.created_at.isoformat()}

        return {
            "rack_space_available": [_fmt(n) for n in rack_space],
            "fifo_warning": [_fmt(n) for n in fifo_warning],
            "holding_pending": [_fmt(n) for n in holding_pending],
            "long_pending_holding": [
                {"id": e.id, "part_no": e.part.part_no, "holding_date": e.holding_date.isoformat(),
                 "remaining_qty": float(e.remaining_qty)}
                for e in long_pending
            ],
        }

    def get_daily_receiving(self, days=CHART_DAYS):
        return self.srv_repo.daily_receiving(date.today() - timedelta(days=days))

    def get_todays_issues(self):
        return self.ledger_repo.todays_consumption_rows(date.today())

    def get_pending_srv_detail(self):
        rows = self.srv_repo.pending_srv_rows()
        return {
            "rows": [
                {
                    "srv_id": srv.id, "vendor_code": srv.vendor_code, "supplier_name": srv.supplier_name,
                    "part_no": srv.part_no, "part_name": srv.part_name, "vehicle_no": srv.vehicle_no,
                    "status": srv.status, "gate_entry_time": srv.gate_entry_time.isoformat() if srv.gate_entry_time else None,
                }
                for srv in rows
            ],
        }

    def get_todays_receipts(self):
        return [
            {
                "srv_id": srv.id, "srv_no": srv.srv_no, "vendor_code": srv.vendor_code,
                "part_no": srv.part_no, "part_name": srv.part_name,
                "qty_received": float(srv.qty_received) if srv.qty_received is not None else None,
                "status": srv.status, "time": srv.srv_created_at.isoformat(),
            }
            for srv in self.srv_repo.todays_receipts(date.today())
        ]

    def get_part_consumption_history(self, part_id):
        return [
            {"qty": float(-row.qty_delta), "time": row.created_at.isoformat(), "srv_id": row.srv_id}
            for row in self.ledger_repo.consumption_history_by_part(part_id)
        ]

    def get_part_source_breakdown_monthly(self, part_id):
        """Month-wise Purchased (BOP) vs In-House Made receipts for one part —
        the monthly companion to the cumulative source_breakdown shown on the
        part row, matched to the separate monthly BOP/in-house schedules."""
        return self.ledger_repo.source_breakdown_monthly(part_id)

    def get_daily_stock_movement(self, days=CHART_DAYS):
        return self.ledger_repo.daily_movement(date.today() - timedelta(days=days))

    def get_supplier_receiving_trend(self, days=CHART_DAYS):
        return self.srv_repo.supplier_receiving_trend(date.today() - timedelta(days=days))

    def get_rack_utilization_chart(self):
        return self.rack_bin_service.list_all()

    def get_part_wise_summary(self):
        parts = self.part_repo.get_active(DEFAULT_STORE_CODE)
        stock_by_part = self._stock_by_part()
        latest_map = self.cov_service.get_latest_map()
        supplier_map = self.part_supplier_repo.map_by_part()
        source_map = self.ledger_repo.source_breakdown_map()
        erp_map = {r.part_id: float(r.qty_on_hand) for r in self.erp_stock_repo.list_all()}
        physical_map = self.physical_repo.map_by_part()

        agg_rows = (
            db.session.query(
                SRV.part_id,
                func.sum(SRV.qty_invoiced).label("invoiced"),
                func.sum(SRV.qty_received).label("received"),
                func.sum(SRV.short_qty).label("short"),
            ).group_by(SRV.part_id).all()
        )
        agg_by_part = {row.part_id: row for row in agg_rows}

        rows = []
        for part in parts:
            locs = stock_by_part.get(part.id, {})
            receiving = locs.get("RECEIVING_STORE", 0)
            part_store = locs.get("PART_STORE", 0)
            total = receiving + part_store
            agg = agg_by_part.get(part.id)
            indicator, cov_days = self._resolve_indicator(part, total, latest_map=latest_map)
            erp_qty = erp_map.get(part.id)
            phys = physical_map.get(part.id)
            physical_qty = float(phys.qty) if phys else None
            erp_gap = (physical_qty - erp_qty) if (erp_qty is not None and physical_qty is not None) else None

            rows.append({
                "part_id": part.id,
                "part_no": part.part_no,
                "part_name": part.part_name,
                "uom": part.uom,
                "new_part_no": part.new_part_no,
                "old_part_no": part.old_part_no,
                "category": part.category,
                "sub_category": part.sub_category,
                "package_standard": float(part.package_standard) if part.package_standard is not None else None,
                "supplier_name": part.supplier.supplier_name if part.supplier else None,
                "supplier_sources": [
                    {
                        "supplier_name": s.supplier.supplier_name,
                        "qty": float(s.qty) if s.qty is not None else None,
                        "share_pct": float(s.share_pct) if s.share_pct is not None else None,
                    }
                    for s in supplier_map.get(part.id, [])
                ],
                # Cumulative received-to-date, split Purchase (SRV) vs
                # In-House Production (ProductionReceipt) — see
                # StockLedgerRepository.source_breakdown_map(). Not a live
                # per-lot stock split (consumption isn't source-tagged),
                # only populated once at least one receipt of either kind
                # has actually happened for this part.
                "source_breakdown": source_map.get(part.id),
                "receiving_store_qty": receiving,
                "part_store_qty": part_store,
                "total_qty": total,
                "min_stock_level": float(part.min_stock_level or 0),
                "max_stock_level": float(part.max_stock_level) if part.max_stock_level is not None else None,
                "cov_days": cov_days,
                "indicator": indicator,
                # Rest of the Part Master record, so the part-detail modal can
                # show the whole part rather than a subset. daily_consumption
                # and the target_cov_days pair especially: they are the inputs
                # COV Days is computed from, so a blank COV Days is only
                # explainable with them on screen.
                "part_type": part.part_type,
                "barcode": part.barcode,
                "is_active": part.is_active,
                "daily_consumption": float(part.daily_consumption) if part.daily_consumption is not None else None,
                "unit_price": float(part.unit_price) if part.unit_price is not None else None,
                "total_value": round(total * float(part.unit_price), 2) if part.unit_price is not None else None,
                "target_cov_days_min": float(part.target_cov_days_min) if part.target_cov_days_min is not None else None,
                "target_cov_days_max": float(part.target_cov_days_max) if part.target_cov_days_max is not None else None,
                "bin_capacity": float(part.bin_capacity) if part.bin_capacity is not None else None,
                "short_since": self._utc_iso(part.short_since),
                "excess_since": self._utc_iso(part.excess_since),
                "erp_stock": erp_qty,
                "physical_stock": physical_qty,
                "erp_gap": erp_gap,
                "total_invoiced": float(agg.invoiced) if agg and agg.invoiced else 0,
                "total_received": float(agg.received) if agg and agg.received else 0,
                "total_short": float(agg.short) if agg and agg.short else 0,
            })
        return rows

    def _short_parts_below(self, threshold):
        """Parts with COV Days below `threshold`, sorted most-critical-first.
        Stock shown is the latest Daily Stock Count qty (what COV Days is
        actually computed from), not the SRV-derived PartStock total the
        Part-wise Summary table uses — for parts fed by the daily count
        sheet (not yet flowing through SRVs) those two numbers can
        legitimately differ."""
        parts = self.part_repo.get_active(DEFAULT_STORE_CODE)
        latest_map = self.cov_service.get_latest_map()

        rows = []
        for part in parts:
            status = self.cov_service.get_status(part, latest_map=latest_map)
            if status["basis"] != "COV" or status["cov_days"] is None:
                continue
            if status["cov_days"] >= threshold:
                continue
            rows.append({
                "part_id": part.id,
                "part_no": part.part_no,
                "part_name": part.part_name,
                "uom": part.uom,
                "total_qty": status["counted_qty"],
                "cov_days": status["cov_days"],
                "daily_consumption": status["daily_consumption"],
            })
        rows.sort(key=lambda r: r["cov_days"])
        return rows

    def get_critical_short_parts(self):
        """Short BOP Parts for Today's Production — COV Days < CRITICAL_COV_THRESHOLD
        (0.5), tighter than the general Short Parts (<1 Day Stock) KPI card."""
        return self._short_parts_below(CRITICAL_COV_THRESHOLD)

    def get_short_parts(self):
        """Short Parts (<1 Day Stock) — same rule as the KPI card's
        `low_stock` count (_is_short_kpi), returned as a list for the
        dashboard's scrolling Short Parts ticker."""
        return self._short_parts_below(SHORT_STOCK_THRESHOLD)

    def get_critical_parts(self):
        """Today's Production Critical Parts — Coverage < 1 Day OR Out of
        Stock (the latter regardless of whether daily_consumption is even
        set yet). Feeds the red critical-parts banner. short_qty is how
        much more is needed to cover today's shift (daily_consumption -
        current stock) — None when daily_consumption isn't set yet, since
        there's no honest number to show.

        Excludes Dead Stock (parts racked at Mezzanine) — they're
        deliberately parked slow/non-moving stock, not part of active
        production, so an Out-of-Stock reading there doesn't mean anything
        is actually needed today."""
        parts = self.part_repo.get_active(DEFAULT_STORE_CODE)
        dead_stock_ids = self.rack_bin_repo.get_dead_stock_part_ids()
        latest_map = self.cov_service.get_latest_map()
        rows = []
        for part in parts:
            if part.id in dead_stock_ids:
                continue
            status = self.cov_service.get_status(part, latest_map=latest_map)
            if not self.cov_service.is_short(part, status, dead_stock_ids):
                continue
            counted_qty = status["counted_qty"] or 0
            daily_consumption = status["daily_consumption"]
            short_qty = round(daily_consumption - counted_qty, 2) if daily_consumption and daily_consumption > counted_qty else None
            rows.append({
                "part_id": part.id, "part_no": part.part_no, "part_name": part.part_name, "uom": part.uom,
                "total_qty": status["counted_qty"], "cov_days": status["cov_days"],
                "out_of_stock": status["out_of_stock"], "short_qty": short_qty,
            })
        rows.sort(key=lambda r: r["cov_days"] if r["cov_days"] is not None else -1)
        return rows

    def get_flow_pipeline(self):
        counts = {status: 0 for status in STATUSES}
        for status, count in db.session.query(SRV.status, func.count(SRV.id)).group_by(SRV.status).all():
            counts[status] = count
        return counts
