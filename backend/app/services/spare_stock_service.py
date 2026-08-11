"""Spare on-hand stock: setting it, moving it, and the figures it unlocks.

Min/Max on a spare meant nothing until this existed — the store could record
that a part should never fall below 2, with nothing anywhere to say how many
were actually on the shelf. Everything here is scoped to a store, so the
Child Parts screens are untouched.
"""
from datetime import datetime, timedelta

from app.models.base import utcnow
from app.models.part import Part
from app.repositories.supplier_window_schedule_repository import SHIFT_START
from app.repositories.part_repository import PartRepository
from app.repositories.spare_stock_repository import (
    SpareStockLedgerRepository, SpareStockRepository,
)
from app.repositories.erp_stock_repository import ERPStockRepository
from app.services.erp_gap_service import ERPGapService
from app.utils.db_tx import atomic
from app.utils.excel_io import bulk_import, build_export, build_template, to_number, to_text
from app.utils.exceptions import BadRequestError, NotFoundError

FIELD_ALIASES = {
    "part_no": {"partno", "partnumber", "itemcode", "itemno"},
    "qty_on_hand": {"qtyonhand", "qty", "quantity", "openingqty", "openingstock",
                    "physicalstock", "physicalqty", "stock", "closingstock", "totalqty"},
}
REQUIRED_FIELDS = ["part_no", "qty_on_hand"]

# Shop-floor departments that draw spares — the split behind Department-wise
# Consumption. Recorded on every ISSUE.
DEPARTMENTS = ("Press Shop", "Maintenance", "Tool Room")

TEMPLATE_COLUMNS = ["Part No", "Part Name", "Qty On Hand"]

EXPORT_COLUMNS = [
    ("Part No", "part_no"), ("Part Name", "part_name"), ("Location", "location"),
    ("Qty On Hand", "qty_on_hand"), ("Min", "min_stock_level"), ("Max", "max_stock_level"),
    ("Shortfall", "shortfall"), ("Rate", "unit_price"), ("Stock Value", "stock_value"),
    ("Status", "status"), ("Last Counted", "last_counted_at"),
]


class SpareStockService:
    def __init__(self):
        self.repo = SpareStockRepository()
        self.ledger_repo = SpareStockLedgerRepository()
        self.part_repo = PartRepository()
        self.erp_repo = ERPStockRepository()

    # ---- movement ----

    def _write(self, part_id, new_qty, txn_type, reference=None, remarks=None,
               user=None, counted=False, department=None, machine=None,
               returnable=False, return_of_id=None):
        """Set a part's quantity and record why, in one go. The ledger row and
        the maintained qty are written together — a balance that moved with no
        row to explain it is worse than no history at all."""
        row = self.repo.get_or_create(part_id)
        before = float(row.qty_on_hand or 0)
        delta = round(new_qty - before, 2)

        row.qty_on_hand = new_qty
        if counted:
            row.last_counted_at = utcnow()

        # An import that re-states the same figure is not a movement. Writing a
        # zero-delta row for all 481 parts on every upload would bury the real
        # ones within a week.
        if delta != 0:
            self.ledger_repo.create(
                part_id=part_id, qty_delta=delta, balance_after=new_qty,
                txn_type=txn_type, reference=reference, remarks=remarks,
                created_by=user, department=department, machine=machine,
                returnable=returnable, return_of_id=return_of_id,
            )
        return row, delta

    def set_quantity(self, part_id, qty, txn_type="ADJUSTMENT", reference=None,
                     remarks=None, user=None):
        part = self.part_repo.get_by_id(part_id)
        if not part:
            raise NotFoundError(f"Part {part_id} not found")
        if qty is None or float(qty) < 0:
            raise BadRequestError("Quantity must be zero or more")
        with atomic():
            row, _ = self._write(
                part.id, round(float(qty), 2), txn_type,
                reference=reference, remarks=remarks, user=user,
                counted=txn_type in ("OPENING", "ADJUSTMENT"),
            )
        return self._row_dict(part, row)

    def issue(self, part_id, qty, department, machine=None, returnable=False,
              reference=None, remarks=None, user=None):
        """Issue a spare to a department, fitted on a machine — the movement that
        fills Department-wise and Machine-wise Consumption. Deducts on-hand and
        writes an ISSUE ledger row tagged with department + machine; refuses to
        issue more than is on the shelf, so the count can never go negative."""
        part = self.part_repo.get_by_id(part_id)
        if not part:
            raise NotFoundError(f"Part {part_id} not found")
        qty = float(qty) if qty is not None else 0.0
        if qty <= 0:
            raise BadRequestError("Issue quantity must be greater than zero")
        if department not in DEPARTMENTS:
            raise BadRequestError(f"department must be one of {list(DEPARTMENTS)}")
        machine = (machine or "").strip() or None
        with atomic():
            row = self.repo.get_or_create(part.id)
            on_hand = float(row.qty_on_hand or 0)
            if qty > on_hand:
                raise BadRequestError(f"Cannot issue {qty:g}: only {on_hand:g} on hand")
            row, _ = self._write(
                part.id, round(on_hand - qty, 2), "ISSUE",
                reference=reference, remarks=remarks, user=user,
                department=department, machine=machine, returnable=bool(returnable),
            )
        return self._row_dict(part, row)

    def return_item(self, ledger_id, user=None):
        """Bring a returnable tool/die back to the shelf — a RETURN that adds the
        quantity back and closes out the ISSUE it came from. Rejects anything
        that isn't a still-outstanding returnable issue."""
        from app.models.spare_stock import SpareStockLedger
        issue_row = self.ledger_repo.get_by_id(ledger_id)
        if not issue_row or issue_row.txn_type != "ISSUE" or not issue_row.returnable:
            raise BadRequestError("That is not a returnable issue")
        if SpareStockLedger.query.filter_by(return_of_id=ledger_id).first():
            raise BadRequestError("This issue has already been returned")
        part = issue_row.part
        qty_back = abs(float(issue_row.qty_delta))
        with atomic():
            row = self.repo.get_or_create(issue_row.part_id)
            new_qty = round(float(row.qty_on_hand or 0) + qty_back, 2)
            row, _ = self._write(
                issue_row.part_id, new_qty, "RETURN",
                reference=issue_row.reference, remarks="Returned to store", user=user,
                department=issue_row.department, machine=issue_row.machine,
                return_of_id=ledger_id,
            )
        return self._row_dict(part, row)

    def outstanding_returnables(self, store_code):
        """Returnable tools/dies still out on the floor — every returnable ISSUE
        that no RETURN has closed out yet, newest first."""
        from app.extensions import db
        from app.models.spare_stock import SpareStockLedger
        returned = (
            db.session.query(SpareStockLedger.return_of_id)
            .filter(SpareStockLedger.return_of_id.isnot(None))
        )
        rows = (
            db.session.query(SpareStockLedger)
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(
                Part.store_code == store_code,
                SpareStockLedger.txn_type == "ISSUE",
                SpareStockLedger.returnable.is_(True),
                SpareStockLedger.id.notin_(returned),
            )
            .order_by(SpareStockLedger.created_at.desc(), SpareStockLedger.id.desc())
            .all()
        )
        return [{
            "id": r.id,
            "part_no": r.part.part_no if r.part else None,
            "part_name": r.part.part_name if r.part else None,
            "qty": abs(float(r.qty_delta)),
            "department": r.department,
            "machine": r.machine,
            "reference": r.reference,
            "issued_at": r.created_at.isoformat() if r.created_at else None,
        } for r in rows]

    # ---- reading ----

    @staticmethod
    def _row_dict(part, stock):
        qty = float(stock.qty_on_hand) if stock and stock.qty_on_hand is not None else None
        minimum = float(part.min_stock_level or 0)
        maximum = float(part.max_stock_level) if part.max_stock_level is not None else None
        rate = float(part.unit_price) if part.unit_price is not None else None

        if qty is None:
            status = "Not Counted"
        elif qty <= 0:
            status = "Out of Stock"
        elif minimum > 0 and qty < minimum:
            status = "Below Minimum"
        elif maximum and qty > maximum:
            status = "Above Maximum"
        else:
            status = "Healthy"

        return {
            "part_id": part.id, "part_no": part.part_no, "part_name": part.part_name,
            "location": part.location, "rework_location": part.rework_location,
            "uom": part.uom, "section_id": part.section_id,
            "qty_on_hand": qty,
            "min_stock_level": minimum,
            "max_stock_level": maximum,
            # What it would take to get back to the maximum — the reorder
            # quantity, once anyone wants to raise one.
            "shortfall": round(maximum - qty, 2) if (maximum and qty is not None and qty < maximum) else None,
            "unit_price": rate,
            "stock_value": round(qty * rate, 2) if (qty is not None and rate is not None) else None,
            "status": status,
            "last_counted_at": stock.last_counted_at.isoformat() if stock and stock.last_counted_at else None,
        }

    def get_for_part(self, part_id):
        """One part's stock, read-only — no row is created, so asking about a
        part does not silently record it as counted at zero."""
        part = self.part_repo.get_by_id(part_id)
        if not part:
            raise NotFoundError(f"Part {part_id} not found")
        return self._row_dict(part, self.repo.get_by_part(part_id))

    def list_stock(self, store_code, section_id=None):
        return [self._row_dict(part, stock)
                for part, stock in self.repo.list_for_store(store_code, section_id)]

    def get_summary(self, store_code, section_id=None):
        """The figures the store dashboard asks for. Counted separately from
        "not counted": a part nobody has counted is not a part with none, and
        reporting it as zero would invent a shortage.

        section_id narrows it to one section, because the section screen shows
        the same dashboard and must not quote the whole store's stock."""
        rows = self.list_stock(store_code, section_id)
        counted = [r for r in rows if r["qty_on_hand"] is not None]
        valued = [r for r in counted if r["stock_value"] is not None]
        return {
            "total_parts": len(rows),
            "counted_parts": len(counted),
            "uncounted_parts": len(rows) - len(counted),
            "total_qty": round(sum(r["qty_on_hand"] for r in counted), 2),
            "stock_value": round(sum(r["stock_value"] for r in valued), 2),
            "valued_parts": len(valued),
            "out_of_stock": sum(1 for r in counted if r["status"] == "Out of Stock"),
            "below_minimum": sum(1 for r in counted if r["status"] == "Below Minimum"),
            "above_maximum": sum(1 for r in counted if r["status"] == "Above Maximum"),
            "healthy": sum(1 for r in counted if r["status"] == "Healthy"),
        }

    def list_below_minimum(self, store_code, limit=None, section_id=None):
        rows = [r for r in self.list_stock(store_code, section_id)
                if r["status"] in ("Out of Stock", "Below Minimum")]
        # Worst first: out of stock before merely low, then by how far short.
        rows.sort(key=lambda r: (r["status"] != "Out of Stock", -(r["min_stock_level"] - r["qty_on_hand"])))
        return rows[:limit] if limit else rows

    def list_by_status(self, store_code, status, limit=None, section_id=None):
        """One status at a time, for the dashboard's Action Required entries.
        Sorted so the worst case in each list is the first row read."""
        rows = [r for r in self.list_stock(store_code, section_id) if r["status"] == status]
        if status == "Above Maximum":
            # Furthest over first — that is where the money is tied up.
            rows.sort(key=lambda r: -(r["qty_on_hand"] - (r["max_stock_level"] or 0)))
        elif status == "Below Minimum":
            rows.sort(key=lambda r: -(r["min_stock_level"] - r["qty_on_hand"]))
        else:
            # Out of Stock and Not Counted have no depth to rank by, so the
            # dearest part is the one worth seeing first.
            rows.sort(key=lambda r: -(r["unit_price"] or 0))
        return rows[:limit] if limit else rows

    def list_excess(self, store_code, limit=None, section_id=None):
        """Above maximum, with how far over. `excess_since` is carried straight
        off the part rather than derived — nothing back-dates it yet, so it
        stays None instead of being guessed from the ledger."""
        rows = self.list_by_status(store_code, "Above Maximum", limit, section_id)
        for r in rows:
            r["excess_qty"] = round(r["qty_on_hand"] - (r["max_stock_level"] or 0), 2)
        return rows

    def movements_between(self, store_code, since, until=None):
        """What moved in a window, split by direction. RECEIPT and ISSUE are
        the two the floor is asked about; OPENING and ADJUSTMENT are counted
        separately so a stock-take is never reported as a day's receipts."""
        entries = self.ledger_repo.list_for_store_between(store_code, since, until)
        out = {
            "received_qty": 0.0, "received_lines": 0,
            "issued_qty": 0.0, "issued_lines": 0,
            "adjusted_lines": 0, "opening_lines": 0,
        }
        for e in entries:
            delta = float(e.qty_delta)
            if e.txn_type == "RECEIPT":
                out["received_qty"] += delta
                out["received_lines"] += 1
            elif e.txn_type == "ISSUE":
                out["issued_qty"] += abs(delta)
                out["issued_lines"] += 1
            elif e.txn_type == "ADJUSTMENT":
                out["adjusted_lines"] += 1
            elif e.txn_type == "OPENING":
                out["opening_lines"] += 1
        out["received_qty"] = round(out["received_qty"], 2)
        out["issued_qty"] = round(out["issued_qty"], 2)
        return out

    def today_movements(self, store_code):
        """Since the shift started, not since midnight — the plant's day runs
        08:30 to about 03:20 the next morning, so a midnight cut would split
        one night shift's receipts across two days.

        The shift boundary is a plant wall-clock time but created_at is stored
        in UTC, so the boundary is converted before it is compared. Reading one
        against the other is what once put every vehicle window 5.5 hours out.
        The offset is measured rather than hardcoded, so this holds wherever
        the server is set.
        """
        now_local = datetime.now()
        offset = now_local - datetime.utcnow()

        start_local = now_local.replace(hour=SHIFT_START.hour, minute=SHIFT_START.minute,
                                        second=0, microsecond=0)
        if now_local < start_local:
            start_local -= timedelta(days=1)

        summary = self.movements_between(store_code, start_local - offset)
        # Reported as the plant clock, which is the shift anyone is thinking of.
        summary["since"] = start_local.isoformat()
        return summary

    @staticmethod
    def _pct(part, whole):
        """None, not zero, when there is nothing to divide by. A gauge reading
        0% claims it measured something and found none; a gauge with no
        denominator has measured nothing at all, and the two must not look
        alike on a screen."""
        if not whole:
            return None
        return round(part / whole * 100, 1)

    def analytics(self, store_code):
        """Every percentage the dashboard's gauges show, worked out here rather
        than in the browser — one definition per metric, and the same figure
        whoever asks."""
        rows = self.list_stock(store_code)
        counted = [r for r in rows if r["qty_on_hand"] is not None]
        by = lambda s: sum(1 for r in counted if r["status"] == s)  # noqa: E731

        healthy, below, above = by("Healthy"), by("Below Minimum"), by("Above Maximum")
        zero = by("Out of Stock")
        critical = below + zero

        # Utilisation is on-hand against the planned maximum — how full the
        # store is against what it decided to hold, which is the only capacity
        # figure a spares store has. Only parts that are both counted and
        # planned can take part, or the ratio compares against a missing limit.
        planned_counted = [r for r in counted if r["max_stock_level"]]
        on_hand = sum(r["qty_on_hand"] for r in planned_counted)
        capacity = sum(r["max_stock_level"] for r in planned_counted)

        with_min = sum(1 for r in rows if r["min_stock_level"])
        with_max = sum(1 for r in rows if r["max_stock_level"])
        with_both = sum(1 for r in rows if r["min_stock_level"] and r["max_stock_level"])

        valued = [r for r in counted if r["stock_value"] is not None]
        value_bands = {"Normal Stock": 0.0, "Critical Stock": 0.0, "Excess Stock": 0.0}
        for r in valued:
            if r["status"] in ("Out of Stock", "Below Minimum"):
                value_bands["Critical Stock"] += r["stock_value"]
            elif r["status"] == "Above Maximum":
                value_bands["Excess Stock"] += r["stock_value"]
            else:
                value_bands["Normal Stock"] += r["stock_value"]

        return {
            "counted_parts": len(counted),
            "total_parts": len(rows),
            "gauges": {
                "stock_utilisation": {
                    "pct": self._pct(on_hand, capacity),
                    "caption": f"{round(on_hand)} of {round(capacity)} planned max",
                    "basis": len(planned_counted),
                },
                "inventory_health": {
                    "pct": self._pct(healthy, len(counted)),
                    "caption": f"{healthy} of {len(counted)} counted parts healthy",
                    "basis": len(counted),
                },
                "min_max_coverage": {
                    "pct": self._pct(with_both, len(rows)),
                    "caption": f"{with_both} of {len(rows)} have both limits",
                    "basis": len(rows),
                },
                "planning_coverage": {
                    "pct": self._pct(with_max, len(rows)),
                    "caption": f"{with_max} of {len(rows)} have a maximum",
                    "basis": len(rows),
                },
                "critical_parts": {
                    "pct": self._pct(critical, len(counted)),
                    "caption": f"{critical} critical of {len(counted)} counted",
                    "basis": len(counted),
                },
                "excess_stock": {
                    "pct": self._pct(above, len(counted)),
                    "caption": f"{above} above maximum of {len(counted)} counted",
                    "basis": len(counted),
                },
                "stock_counted": {
                    "pct": self._pct(len(counted), len(rows)),
                    "caption": f"{len(counted)} of {len(rows)} parts ever counted",
                    "basis": len(rows),
                },
            },
            "status_distribution": [
                {"name": "Healthy", "value": healthy},
                {"name": "Below Minimum", "value": below},
                {"name": "Above Maximum", "value": above},
                {"name": "Zero Stock", "value": zero},
            ],
            "value_distribution": [
                {"name": k, "value": round(v, 2)} for k, v in value_bands.items()
            ],
            "total_value": round(sum(value_bands.values()), 2),
            "short_vs_excess": [
                {"name": "Below Minimum", "value": below},
                {"name": "Healthy", "value": healthy},
                {"name": "Above Maximum", "value": above},
            ],
            "top_value": [{
                "part_id": r["part_id"], "part_no": r["part_no"], "part_name": r["part_name"],
                "qty_on_hand": r["qty_on_hand"], "unit_price": r["unit_price"],
                "stock_value": r["stock_value"], "status": r["status"],
            } for r in sorted(valued, key=lambda r: -r["stock_value"])[:10]],
            "monthly_consumption": self.monthly_consumption(store_code),
        }

    def monthly_consumption(self, store_code, months=12):
        """Issued quantity per month, off the ledger. Real usage — an empty
        list means nothing has been issued, not that the query failed."""
        entries = [e for e in self.ledger_repo.recent_for_store(store_code, 5000)
                   if e.txn_type == "ISSUE" and e.created_at]
        by_month = {}
        for e in entries:
            key = e.created_at.strftime("%Y-%m")
            by_month[key] = by_month.get(key, 0) + abs(float(e.qty_delta))
        return [{"name": k, "value": round(v, 2)} for k, v in sorted(by_month.items())][-months:]

    def consumption_by_department(self, store_code):
        """Total issued quantity per department — the split behind Department-wise
        Consumption. Only ISSUE rows carry a department, so opening/receipt/
        adjustment rows never appear here."""
        from app.extensions import db
        from sqlalchemy import func
        from app.models.spare_stock import SpareStockLedger
        rows = (
            db.session.query(
                SpareStockLedger.department,
                func.sum(func.abs(SpareStockLedger.qty_delta)),
            )
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code, SpareStockLedger.txn_type == "ISSUE")
            .group_by(SpareStockLedger.department)
            .all()
        )
        return [{"name": dept or "Unspecified", "value": round(float(total or 0), 2)}
                for dept, total in rows if total]

    def consumption_by_machine(self, store_code):
        """Total issued quantity per machine — the split behind Machine-wise
        Consumption (which machine eats the most spares). Only ISSUE rows carry
        a machine."""
        from app.extensions import db
        from sqlalchemy import func
        from app.models.spare_stock import SpareStockLedger
        rows = (
            db.session.query(
                SpareStockLedger.machine,
                func.sum(func.abs(SpareStockLedger.qty_delta)),
            )
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code, SpareStockLedger.txn_type == "ISSUE")
            .group_by(SpareStockLedger.machine)
            .all()
        )
        out = [{"name": mc or "Unspecified", "value": round(float(total or 0), 2)}
               for mc, total in rows if total]
        out.sort(key=lambda r: r["value"], reverse=True)
        return out

    def consumption_by_type(self, store_code):
        """Total issued quantity per component type (Part.sub_category) — the
        split behind Part-type-wise Consumption. Parts with no type group under
        'Uncategorised'."""
        from app.extensions import db
        from sqlalchemy import func
        from app.models.spare_stock import SpareStockLedger
        rows = (
            db.session.query(Part.sub_category, func.sum(func.abs(SpareStockLedger.qty_delta)))
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code, SpareStockLedger.txn_type == "ISSUE")
            .group_by(Part.sub_category)
            .all()
        )
        out = [{"name": t or "Uncategorised", "value": round(float(total or 0), 2)}
               for t, total in rows if total]
        out.sort(key=lambda r: r["value"], reverse=True)
        return out

    def machines_used(self, store_code):
        """Distinct machine names already recorded for this store — the source
        for the issue form's type-ahead, so the same machine is always spelled
        the same way."""
        from app.extensions import db
        from app.models.spare_stock import SpareStockLedger
        rows = (
            db.session.query(SpareStockLedger.machine)
            .join(Part, Part.id == SpareStockLedger.part_id)
            .filter(Part.store_code == store_code, SpareStockLedger.machine.isnot(None))
            .distinct()
            .all()
        )
        return sorted({m for (m,) in rows if m})

    def erp_completeness(self, store_code):
        """How much of this store's list ERP has ever reported a stock figure
        for. Reported separately because it measures the feed, not the store."""
        from app.models.erp_stock import ERPStock
        from app.extensions import db
        from sqlalchemy import func
        total = len(self.part_repo.get_active(store_code))
        synced = (
            db.session.query(func.count(func.distinct(ERPStock.part_id)))
            .join(Part, Part.id == ERPStock.part_id)
            .filter(Part.store_code == store_code)
            .scalar() or 0
        )
        return {"pct": self._pct(synced, total), "synced": synced, "total": total}

    # ---- ERP vs Physical gap (spare store) ----
    #
    # The same reconciliation the Child Parts store gets, but scoped to one
    # store and — deliberately — reading physical straight from the in-app count
    # (SpareStock.qty_on_hand), not the separate physical-snapshot upload the
    # Child Parts gap uses. ERP is the feed (erp_stock); physical is whatever
    # the store has counted, so there is nothing to key in twice. A part with an
    # ERP figure but no count reads NO_PHYSICAL; one counted but never pushed by
    # ERP reads NOT_SYNCED. Status rule is shared with ERPGapService so the two
    # stores can never disagree on what SHORT/EXCESS means.

    def erp_gap(self, store_code, keyword=None, category=None, status=None):
        erp_map = {r.part_id: (float(r.qty_on_hand), r.synced_at)
                   for r in self.erp_repo.list_all()}
        rows = []
        for part, spare in self.repo.list_for_store(store_code):
            erp = erp_map.get(part.id)
            erp_qty = erp[0] if erp else None
            physical_qty = float(spare.qty_on_hand) if spare is not None else None
            if erp_qty is None and physical_qty is None:
                continue
            gap_qty = (physical_qty - erp_qty) if (erp_qty is not None and physical_qty is not None) else None
            rows.append({
                "part_id": part.id, "part_no": part.part_no, "part_name": part.part_name,
                "category": part.category, "location": part.location,
                "erp_qty": erp_qty, "physical_qty": physical_qty, "gap_qty": gap_qty,
                "status": ERPGapService._status(erp_qty, physical_qty),
                "erp_synced_at": erp[1].isoformat() if erp else None,
                "last_counted_at": spare.last_counted_at.isoformat() if (spare and spare.last_counted_at) else None,
            })
        if keyword:
            kw = keyword.lower()
            rows = [r for r in rows if kw in r["part_no"].lower() or kw in (r["part_name"] or "").lower()]
        if category:
            rows = [r for r in rows if r["category"] == category]
        if status:
            rows = [r for r in rows if r["status"] == status]
        rows.sort(key=lambda r: abs(r["gap_qty"]) if r["gap_qty"] is not None else -1, reverse=True)
        return rows

    def erp_gap_summary(self, store_code):
        rows = self.erp_gap(store_code)
        reconciled = [r for r in rows if r["gap_qty"] is not None]
        matched = sum(1 for r in reconciled if r["status"] == "MATCH")
        return {
            "total": len(rows),
            "matched": matched,
            "short": sum(1 for r in rows if r["status"] == "SHORT"),
            "excess": sum(1 for r in rows if r["status"] == "EXCESS"),
            "no_physical": sum(1 for r in rows if r["status"] == "NO_PHYSICAL"),
            "not_synced": sum(1 for r in rows if r["status"] == "NOT_SYNCED"),
            "accuracy_pct": round(matched / len(reconciled) * 100, 2) if reconciled else None,
        }

    def recent_activity(self, store_code, limit=20):
        """The store's own event feed, off the ledger. Every row is something
        that actually happened to stock — no synthesised "system" events."""
        return [{
            "id": e.id,
            "at": e.created_at.isoformat() if e.created_at else None,
            "part_id": e.part_id,
            "part_no": e.part.part_no if e.part else None,
            "part_name": e.part.part_name if e.part else None,
            "uom": e.part.uom if e.part else None,
            "section_id": e.part.section_id if e.part else None,
            "txn_type": e.txn_type,
            "qty_delta": float(e.qty_delta),
            "balance_after": float(e.balance_after),
            "reference": e.reference,
            "remarks": e.remarks,
            "created_by": e.created_by,
        } for e in self.ledger_repo.recent_for_store(store_code, limit)]

    def history_for_part(self, part_id, limit=25):
        return [{
            "id": e.id,
            "at": e.created_at.isoformat() if e.created_at else None,
            "qty_delta": float(e.qty_delta),
            "balance_after": float(e.balance_after),
            "txn_type": e.txn_type,
            "reference": e.reference,
            "remarks": e.remarks,
            "created_by": e.created_by,
        } for e in self.ledger_repo.list_for_part(part_id, limit)]

    # ---- Excel ----

    def build_template(self, store_code=None):
        """Pre-filled with the store's own parts, so opening stock is a matter
        of typing one column rather than retyping 481 part numbers."""
        parts = self.part_repo.get_active(store_code) if store_code else []
        qty_map = self.repo.map_by_part(store_code) if store_code else {}
        rows = [{
            "part_no": p.part_no, "part_name": p.part_name,
            "qty_on_hand": qty_map.get(p.id, ""),
        } for p in parts]
        if not rows:
            return build_template(TEMPLATE_COLUMNS)
        return build_export([(c, k) for c, k in
                             zip(TEMPLATE_COLUMNS, ("part_no", "part_name", "qty_on_hand"))], rows)

    def bulk_import(self, file_stream, store_code=None, user=None, sheet_name=None):
        """Upload opening stock. Blank quantity cells are skipped rather than
        read as zero — a half-filled sheet must not wipe the shelves it does
        not mention."""
        applied = {"updated": 0, "unchanged": 0}

        def row_processor(raw_row):
            part_no = to_text(raw_row.get("part_no"))
            if not part_no:
                raise ValueError("Part No is required")
            part = self.part_repo.get_by_part_no(part_no)
            if not part:
                raise ValueError(f"Unknown Part No: {part_no}")
            if store_code and part.store_code != store_code:
                raise ValueError(f"{part_no} does not belong to {store_code}")

            qty = to_number(raw_row.get("qty_on_hand"), None)
            if qty is None:
                return  # nothing stated for this row
            if qty < 0:
                raise ValueError(f"{part_no}: quantity cannot be negative")

            _, delta = self._write(
                part.id, round(float(qty), 2), "OPENING",
                remarks="Opening stock upload", user=user, counted=True,
            )
            applied["updated" if delta else "unchanged"] += 1

        with atomic():
            report = bulk_import(file_stream, FIELD_ALIASES, REQUIRED_FIELDS, row_processor, sheet_name)
        report.update(applied)
        return report

    def export_excel(self, store_code, section_id=None):
        return build_export(EXPORT_COLUMNS, self.list_stock(store_code, section_id))
