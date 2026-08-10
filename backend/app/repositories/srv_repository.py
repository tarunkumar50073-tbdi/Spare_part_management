"""SRV (Store process-flow) data access layer with search/filter support."""
from sqlalchemy import func
from app.extensions import db
from app.models.srv import SRV
from app.repositories.base_repository import BaseRepository
from app.utils.db_tx import maybe_commit


class SRVRepository(BaseRepository):
    model = SRV

    def claim_status(self, srv_id, from_status, to_status, **fields):
        """Atomic compare-and-set on status: flip from_status -> to_status
        (applying any transition fields) in one conditional UPDATE, but only
        while the row is still in from_status. Returns the SRV if this caller
        won the transition, or None if it was already advanced by a concurrent
        caller — so a racing duplicate request can be rejected before it moves
        any stock (audit finding DATA-2). synchronize_session="fetch" keeps an
        already-loaded SRV in step with what was just written."""
        rows = (
            self.model.query
            .filter(self.model.id == srv_id, self.model.status == from_status)
            .update({"status": to_status, **fields}, synchronize_session="fetch")
        )
        maybe_commit()
        if rows != 1:
            return None
        return self.model.query.get(srv_id)

    def search(self, status=None, vendor_code=None, part_id=None, is_short=None, keyword=None):
        query = self.model.query
        if status:
            query = query.filter(self.model.status == status)
        if vendor_code:
            query = query.filter(self.model.vendor_code == vendor_code)
        if part_id:
            query = query.filter(self.model.part_id == part_id)
        if is_short is not None:
            query = query.filter(self.model.is_short == is_short)
        if keyword:
            like = f"%{keyword}%"
            query = query.filter(
                (self.model.srv_no.ilike(like))
                | (self.model.part_no.ilike(like))
                | (self.model.part_name.ilike(like))
                | (self.model.supplier_name.ilike(like))
                | (self.model.invoice_no.ilike(like))
            )
        return query.order_by(self.model.created_at.desc())

    def count_by_status_for_store(self, store_code):
        """status -> line count, for one store only. SRV carries part_id, so a
        store's own inbound lines are separable from the other's — without this
        join the Spare Parts flow would be counting Child Parts arrivals."""
        from app.models.part import Part
        rows = (
            db.session.query(self.model.status, func.count(self.model.id))
            .join(Part, Part.id == self.model.part_id)
            .filter(Part.store_code == store_code)
            .group_by(self.model.status)
            .all()
        )
        return {status: count for status, count in rows}

    def list_for_store_by_statuses(self, store_code, statuses, limit=None):
        from app.models.part import Part
        query = (
            self.model.query
            .join(Part, Part.id == self.model.part_id)
            .filter(Part.store_code == store_code, self.model.status.in_(statuses))
            .order_by(self.model.gate_entry_time.asc())
        )
        return query.limit(limit).all() if limit else query.all()

    def get_open(self):
        """SRV lines not yet at a terminal state (CONSUMED / RETURNED_TO_SUPPLIER / FORWARDED_TOOL_ROOM)."""
        return self.model.query.filter(
            ~self.model.status.in_(["CONSUMED", "RETURNED_TO_SUPPLIER", "FORWARDED_TOOL_ROOM"])
        ).order_by(self.model.created_at.desc())

    def list_by_gate_entry(self, gate_entry_no, status=None):
        query = self.model.query.filter(self.model.gate_entry_no == gate_entry_no)
        if status:
            query = query.filter(self.model.status == status)
        return query.order_by(self.model.id.asc()).all()

    def find_for_gate_out(self, on_date, vendor_code=None, gate_entry_no=None, vehicle_no=None):
        """Every SRV line that came in on one vehicle, so a gate-out stamp
        covers the whole truck. gate_entry_no alone is enough when ERP sends
        its gate pass; without one, a vendor's vehicle on a given day is what
        identifies the truck. Never matches on the date alone — that would
        stamp out every vehicle in the yard."""
        if not gate_entry_no and not (vendor_code and vehicle_no):
            return []
        query = self.model.query.filter(self.model.gate_entry_time.isnot(None))
        if gate_entry_no:
            query = query.filter(self.model.gate_entry_no == gate_entry_no)
        else:
            query = query.filter(
                self.model.vendor_code == vendor_code,
                self.model.vehicle_no == vehicle_no,
                func.date(self.model.gate_entry_time) == on_date,
            )
        return query.order_by(self.model.id.asc()).all()

    def find_earliest_arrival(self, vendor_code, vehicle_no):
        """Earliest ERP-pushed gate_entry_time for this vendor+vehicle — a
        vehicle arrives once even though it unloads multiple SRV lines.
        Powers Supplier Vehicle Management's On-Time/Late computation."""
        return (
            self.model.query.filter(
                self.model.vendor_code == vendor_code,
                self.model.vehicle_no == vehicle_no,
                self.model.gate_entry_time.isnot(None),
            ).order_by(self.model.gate_entry_time.asc()).first()
        )

    def find_earliest_arrival_on_date(self, vendor_codes, on_date):
        """Earliest ERP-pushed gate_entry_time for any of these vendor codes
        on a given date — no vehicle_no needed, since which vehicle actually
        shows up is only known once ERP pushes the gate entry. Powers the
        schedule-driven "today's vehicle status" view, which needs zero
        manual per-day/per-vehicle entry (the standard window comes from
        SupplierWindowSchedule, the real arrival comes straight from ERP)."""
        return (
            self.model.query.filter(
                self.model.vendor_code.in_(vendor_codes),
                func.date(self.model.gate_entry_time) == on_date,
                self.model.gate_entry_time.isnot(None),
            ).order_by(self.model.gate_entry_time.asc()).first()
        )

    def list_arrivals_on_date(self, vendor_codes, on_date):
        """Every vehicle these vendor codes sent on a date, earliest first —
        one entry per vehicle, not per SRV line, since a truck unloading eight
        part numbers is still one arrival. Used to match a supplier's several
        delivery windows to its several trucks; find_earliest_arrival_on_date
        answers only "did anything come at all", which is not enough when a
        supplier runs seven windows in a day."""
        rows = (
            self.model.query.filter(
                self.model.vendor_code.in_(vendor_codes),
                func.date(self.model.gate_entry_time) == on_date,
                self.model.gate_entry_time.isnot(None),
            ).order_by(self.model.gate_entry_time.asc()).all()
        )
        seen = set()
        arrivals = []
        for row in rows:
            # ERP's own gate pass identifies the vehicle when it sends one;
            # otherwise the vehicle and the minute it came in do.
            key = row.gate_entry_no or (row.vendor_code, row.vehicle_no, row.gate_entry_time)
            if key in seen:
                continue
            seen.add(key)
            arrivals.append(row)
        return arrivals

    def find_earliest_arrival_among(self, vendor_codes, vehicle_no):
        """Same as find_earliest_arrival, but across a whole set of vendor
        codes sharing one vehicle (a milkrun group) — whichever supplier's
        invoice/SRV line gets entered into ERP first is the vehicle's real
        arrival moment; the group's other suppliers must not show their own,
        later-entered timestamps as if they arrived separately."""
        return (
            self.model.query.filter(
                self.model.vendor_code.in_(vendor_codes),
                self.model.vehicle_no == vehicle_no,
                self.model.gate_entry_time.isnot(None),
            ).order_by(self.model.gate_entry_time.asc()).first()
        )

    def count_verified_on(self, on_date):
        """"Receiving Today" KPI — material verified (received) on the given date."""
        return self.model.query.filter(func.date(self.model.verified_at) == on_date).count()

    def count_supplied_on(self, on_date):
        """"Issued to Production" KPI — material supplied to production on the given date."""
        return self.model.query.filter(func.date(self.model.supplied_at) == on_date).count()

    def count_created_on(self, on_date):
        """"Today's SRV" KPI."""
        return self.model.query.filter(func.date(self.model.srv_created_at) == on_date).count()

    def todays_receipts(self, on_date):
        """Today's Receipt detail list — excludes INSPECTION_PENDING rows
        (created today but still awaiting RQC's own ERP clearance, not yet
        a real receipt into store stock)."""
        return (
            self.model.query
            .filter(func.date(self.model.srv_created_at) == on_date)
            .filter(self.model.status != "INSPECTION_PENDING")
            .order_by(self.model.srv_created_at.desc())
            .all()
        )

    def count_put_away_on(self, on_date):
        """"Today's Put Away" KPI."""
        return self.model.query.filter(func.date(self.model.put_away_at) == on_date).count()

    def count_pending_put_away(self):
        return self.model.query.filter(self.model.put_away_status == "PENDING").count()

    def list_pending_put_away(self):
        return self.model.query.filter(self.model.put_away_status == "PENDING").order_by(self.model.srv_created_at.asc()).all()

    PRE_SRV_STATUSES = ["PENDING_UNLOAD", "UNLOADED", "VERIFIED"]

    def count_pre_srv(self):
        """"Pending SRV" KPI — lines that have arrived but not yet had an SRV created."""
        return self.model.query.filter(self.model.status.in_(self.PRE_SRV_STATUSES)).count()

    def pending_srv_rows(self):
        """Detail rows behind the "Pending SRV" KPI — every line still stuck
        before SRV creation (gate entry arrived but not yet unloaded/verified/
        SRV-raised), newest gate entry first within each vendor."""
        return (
            self.model.query
            .filter(self.model.status.in_(self.PRE_SRV_STATUSES))
            .order_by(self.model.vendor_code.asc(), self.model.gate_entry_time.desc())
            .all()
        )

    def daily_receiving(self, since_date):
        """Daily Receiving chart — gate-entry lines received per day since the given date."""
        rows = (
            db.session.query(
                func.date(self.model.gate_entry_time).label("day"), func.count(self.model.id).label("count")
            )
            .filter(func.date(self.model.gate_entry_time) >= since_date)
            .group_by(func.date(self.model.gate_entry_time))
            .order_by(func.date(self.model.gate_entry_time))
            .all()
        )
        return [{"day": str(r.day), "count": r.count} for r in rows]

    def supplier_receiving_trend(self, since_date):
        """Supplier Receiving Trend chart — SRV line count per supplier since the given date."""
        rows = (
            db.session.query(
                self.model.supplier_name, func.count(self.model.id).label("count")
            )
            .filter(func.date(self.model.gate_entry_time) >= since_date)
            .group_by(self.model.supplier_name)
            .order_by(func.count(self.model.id).desc())
            .all()
        )
        return [{"supplier_name": r.supplier_name, "count": r.count} for r in rows]
