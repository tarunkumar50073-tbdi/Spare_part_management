"""Standard Supplier Window Schedule business logic. window_start/window_end
are plain times of day (no date attached) — several real slots legitimately
cross midnight (e.g. 23:30-01:00), so unlike SupplierVehicleWindow this
never rejects "end before start"; that's expected here, not an error.

get_today_status() is the fully API-driven answer to "which vehicle is
on-time/late today" — the standing schedule (already real, entered once)
plus ERP-pushed arrivals (SRV.gate_entry_time) is enough on its own; it
needs zero manual per-day/per-vehicle entry (unlike SupplierVehicleWindow,
which is for one-off/ad-hoc windows outside the standard schedule)."""
from datetime import date, datetime, time, timedelta
from app.repositories.supplier_window_schedule_repository import SupplierWindowScheduleRepository, SHIFT_START
from app.repositories.supplier_repository import SupplierRepository
from app.repositories.srv_repository import SRVRepository
from app.services.milkrun_group_service import MilkrunGroupService
from app.utils.exceptions import NotFoundError, BadRequestError


def _match_arrivals(slots, arrivals):
    """Pair a supplier's delivery windows with the vehicles it actually sent.

    Returns {slot index -> SRV row}. Each window takes at most one vehicle and
    each vehicle is used at most once — before this, every window of a supplier
    was matched against that supplier's earliest arrival of the day, so one
    truck made all seven of SAR Coating's windows look answered.

    Two passes, in the order a storeperson would reconcile the gate register:
      1. a vehicle that came inside a window plainly belongs to it;
      2. whatever is left belongs to the most recent window that had already
         closed when it arrived (it is late for that one), or — if it beat
         every remaining window — to the next one due.

    `slots` are (start, end) datetimes sorted by start; `arrivals` are SRV rows
    sorted by gate_entry_time.
    """
    matched = {}
    used = set()

    for i, (start, end) in enumerate(slots):
        for j, arrival in enumerate(arrivals):
            if j in used:
                continue
            at = _naive(arrival.gate_entry_time)
            if start <= at <= end:
                matched[i] = arrival
                used.add(j)
                break

    for j, arrival in enumerate(arrivals):
        if j in used:
            continue
        at = _naive(arrival.gate_entry_time)
        closed_before = [i for i, (_, end) in enumerate(slots) if i not in matched and end < at]
        if closed_before:
            i = max(closed_before, key=lambda i: slots[i][1])
        else:
            still_to_come = [i for i, (start, _) in enumerate(slots) if i not in matched and start > at]
            if not still_to_come:
                continue  # more vehicles than windows — the extras are ad-hoc
            i = min(still_to_come, key=lambda i: slots[i][0])
        matched[i] = arrival
        used.add(j)

    return matched


def _naive(dt):
    """Everything here is compared on the plant's wall clock: the schedule
    holds bare local times and SQLite hands gate stamps back without a tzinfo
    even for columns declared timezone=True. An ERP push that does carry an
    offset would otherwise be the one aware value in the set and raise
    TypeError on comparison, so its clock reading is taken and the offset
    dropped — which is what the stored value already is for every other row."""
    if dt is not None and dt.tzinfo is not None:
        return dt.replace(tzinfo=None)
    return dt


class SupplierWindowScheduleService:
    def __init__(self):
        self.repo = SupplierWindowScheduleRepository()
        self.supplier_repo = SupplierRepository()
        self.srv_repo = SRVRepository()
        self.milkrun_service = MilkrunGroupService()

    def _enrich(self, row):
        supplier = self.supplier_repo.get_by_vendor_code(row.vendor_code)
        d = row.to_dict()
        d["supplier_name"] = supplier.supplier_name if supplier else None
        return d

    def list_all(self, vendor_code=None, status=None):
        return [self._enrich(r) for r in self.repo.search(vendor_code=vendor_code, status=status).all()]

    def get(self, schedule_id):
        row = self.repo.get_by_id(schedule_id)
        if not row:
            raise NotFoundError(f"Window schedule {schedule_id} not found")
        return row

    def create(self, data):
        if not self.supplier_repo.get_by_vendor_code(data["vendor_code"]):
            raise BadRequestError(f"Unknown vendor code: {data['vendor_code']}")
        row = self.repo.create(**data)
        return self._enrich(row)

    def update(self, schedule_id, data):
        row = self.get(schedule_id)
        row = self.repo.update(row, **data)
        return self._enrich(row)

    def delete(self, schedule_id):
        row = self.get(schedule_id)
        self.repo.delete(row)

    @staticmethod
    def _applies_today(row, today):
        """Daily always applies. Alternate Day/Weekly are inferred from
        effective_from (no separate "last run" tracking exists) — Alternate
        Day toggles every other day counting from effective_from, Weekly
        repeats on effective_from's weekday. Documented assumption, not an
        explicit rule from any source data."""
        if row.effective_from > today:
            return False
        if row.frequency == "Daily":
            return True
        if row.frequency == "Alternate Day":
            return (today - row.effective_from).days % 2 == 0
        if row.frequency == "Weekly":
            return today.weekday() == row.effective_from.weekday()
        return False

    def get_today_status(self):
        """Every schedule slot due today, each matched against ERP's real
        gate-entry arrivals for that supplier (or its whole milkrun group,
        so grouped suppliers share one vehicle's arrival — see
        SupplierVehicleService). Milkrun-grouped slots that share the exact
        same window collapse into one row (one vehicle, not N duplicate
        rows for its N suppliers)."""
        today = date.today()
        # Plant wall clock, not UTC. The windows are bare local times ("08:30")
        # and arrivals come back from SQLite as bare local times too, so judging
        # them against a UTC now put every status 5.5 hours behind here: a
        # window closing at 10:00 would not have turned Late until 15:30.
        now = datetime.now()
        due_rows = [r for r in self.repo.search(status="Active").all() if self._applies_today(r, today)]
        group_map = self.milkrun_service.get_group_map()  # one query, reused for every row below

        # Pass one — build every slot due, with the real datetimes it spans.
        # Matching cannot be decided row by row: a supplier's several windows
        # have to be paired with its several vehicles as a set.
        seen_group_slots = set()
        slots = []
        for row in due_rows:
            group_info = group_map.get(row.vendor_code)
            if group_info:
                dedup_key = (group_info["group_code"], row.window_start, row.window_end)
                if dedup_key in seen_group_slots:
                    continue
                seen_group_slots.add(dedup_key)

            # Which calendar day this slot actually falls on. The operational
            # day starts at SHIFT_START (08:30) and runs past midnight to about
            # 03:20, so a 00:10 slot is the tail of the shift now running — due
            # tomorrow morning, not this morning. Pinning every slot to today
            # marked those three as Late from the moment the page loaded, while
            # the list ordered them last as if they were still to come.
            window_date = today if row.window_start >= SHIFT_START else today + timedelta(days=1)

            window_start_dt = datetime.combine(window_date, row.window_start)
            window_end_dt = datetime.combine(window_date, row.window_end)
            if row.window_end < row.window_start:
                window_end_dt += timedelta(days=1)  # slot crosses midnight

            slots.append({
                "row": row,
                "group_info": group_info,
                # Milkrun members share one vehicle, so they share one pool of
                # arrivals; the day keeps a supplier's night slots apart from
                # its day ones.
                "pool": (tuple(sorted(self.milkrun_service.get_arrival_vendor_codes(row.vendor_code))), window_date),
                "start": window_start_dt,
                "end": window_end_dt,
            })

        # Pass two — pair each pool's windows with the vehicles it really sent.
        arrival_for = {}
        pools = {}
        for idx, slot in enumerate(slots):
            pools.setdefault(slot["pool"], []).append(idx)
        for (vendor_codes, window_date), idxs in pools.items():
            idxs.sort(key=lambda i: slots[i]["start"])
            arrivals = self.srv_repo.list_arrivals_on_date(list(vendor_codes), window_date)
            matched = _match_arrivals([(slots[i]["start"], slots[i]["end"]) for i in idxs], arrivals)
            for position, arrival in matched.items():
                arrival_for[idxs[position]] = arrival

        results = []
        for idx, slot in enumerate(slots):
            row, group_info = slot["row"], slot["group_info"]
            window_end_dt = slot["end"]

            arrival_srv = arrival_for.get(idx)
            actual_arrival = _naive(arrival_srv.gate_entry_time) if arrival_srv else None
            actual_vehicle_no = arrival_srv.vehicle_no if arrival_srv else None
            # Stamped on every line of the vehicle by SRVService.gate_out, so
            # reading it off the arrival row gives the whole truck's out time.
            actual_out = _naive(arrival_srv.gate_out_time) if arrival_srv else None

            # Four outcomes, along one axis of severity:
            #   On-Time        arrived inside the window (or before it opened —
            #                  early causes the store no problem, the material
            #                  is in, so it is not a separate status)
            #   Pending Arrival  window still open, nothing yet — not a problem
            #   Late           window closed, but the vehicle did turn up
            #   Not Arrived    window closed and nothing came at all
            # Late and Not Arrived used to share one label, which hid the
            # difference between a truck that was two hours behind and one that
            # never left the supplier.
            if actual_arrival is None:
                status = "Pending Arrival" if now <= window_end_dt else "Not Arrived"
            elif actual_arrival > window_end_dt:
                status = "Late"
            else:
                status = "On-Time"

            supplier = self.supplier_repo.get_by_vendor_code(row.vendor_code)
            results.append({
                "vendor_code": row.vendor_code,
                "supplier_name": group_info["group_name"] if group_info else (supplier.supplier_name if supplier else row.vendor_code),
                "milkrun_group": group_info["group_name"] if group_info else None,
                "window_start": row.window_start.isoformat(),
                "window_end": row.window_end.isoformat(),
                "actual_arrival": actual_arrival.isoformat() if actual_arrival else None,
                "actual_out": actual_out.isoformat() if actual_out else None,
                "actual_vehicle_no": actual_vehicle_no,
                "status": status,
            })

        # Same shift-day ordering as the repository's search() — a plain
        # string sort on window_start would put post-midnight slots (e.g.
        # 00:10) before 08:30, undoing the real first-vehicle-to-last-vehicle
        # sequence.
        def shift_day_key(r):
            t = time.fromisoformat(r["window_start"])
            return (0 if t >= SHIFT_START else 1, t)

        results.sort(key=shift_day_key)
        return results
