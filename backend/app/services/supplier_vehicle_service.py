"""Supplier Vehicle Management — the delivery window is decided and
entered manually here; actual arrival is matched at read time against
ERP-pushed gate entries (SRV.gate_entry_time via SRVService.
ingest_gate_entry), same "Excel/manual-now, ERP-later" split used
everywhere else in this app, except here the ERP side is already live.

Milkrun-grouped suppliers (see MilkrunGroup/SupplierMilkrunMapping) share
one physical vehicle, but their invoices can get entered into ERP at
different times (e.g. Nifco's line entered first, Wahi Sons'/Atma
Autotech's entered a few minutes later even though the truck arrived
once). The user's explicit rule: whichever grouped supplier's line lands
first IS the vehicle's arrival time for the whole group — the other
members must not show their own later entry as a separate/different
arrival."""
from datetime import date, datetime

from app.repositories.supplier_vehicle_window_repository import SupplierVehicleWindowRepository
from app.repositories.supplier_repository import SupplierRepository
from app.repositories.srv_repository import SRVRepository
from app.services.milkrun_group_service import MilkrunGroupService
from app.utils.exceptions import NotFoundError, BadRequestError


def _naive(dt):
    """Drop a tzinfo so gate stamps compare against the bare local window
    bounds SQLite returns. Mirrors the same helper in
    SupplierWindowScheduleService — both judge on the plant's wall clock."""
    if dt is not None and dt.tzinfo is not None:
        return dt.replace(tzinfo=None)
    return dt


class SupplierVehicleService:
    def __init__(self):
        self.repo = SupplierVehicleWindowRepository()
        self.supplier_repo = SupplierRepository()
        self.srv_repo = SRVRepository()
        self.milkrun_service = MilkrunGroupService()

    # vehicle_no values that mean "not known yet" for an ad-hoc entry — the
    # placeholder stored when the supplier has no fixed vehicle.
    _UNKNOWN_VEHICLE = (None, "", "—")

    def _enrich(self, window):
        supplier = self.supplier_repo.get_by_vendor_code(window.vendor_code)
        arrival_vendor_codes = self.milkrun_service.get_arrival_vendor_codes(window.vendor_code)

        vehicle_no = window.vehicle_no
        if window.vehicle_no in self._UNKNOWN_VEHICLE:
            # Ad-hoc vehicle logged without a number — pick up the vehicle no
            # and arrival straight from the ERP gate entry for this supplier
            # on its expected date (which vehicle actually shows up is only
            # known once ERP pushes the gate entry).
            arrival_srv = self.srv_repo.find_earliest_arrival_on_date(arrival_vendor_codes, window.expected_date)
            if arrival_srv and arrival_srv.vehicle_no:
                vehicle_no = arrival_srv.vehicle_no
        else:
            arrival_srv = self.srv_repo.find_earliest_arrival_among(arrival_vendor_codes, window.vehicle_no)
        # Everything here is compared on the plant's wall clock — the window
        # bounds come back from SQLite without a tzinfo, so an ERP push that
        # did carry an offset would be the one aware value and raise on
        # comparison.
        actual_arrival = _naive(arrival_srv.gate_entry_time) if arrival_srv else None
        actual_out = _naive(arrival_srv.gate_out_time) if arrival_srv else None

        has_window = window.window_start is not None and window.window_end is not None
        if not has_window:
            # Ad-hoc vehicle, no decided window — no benchmark to judge
            # punctuality against, so only whether it has arrived yet is known.
            status = "Unscheduled" if actual_arrival is not None else "Pending Arrival"
        elif actual_arrival is None:
            # Same four-outcome rule as the schedule view: a window still open
            # is only awaited, but one that has closed with nothing against it
            # is a vehicle that never came, which is not the same thing as one
            # that came late.
            status = "Pending Arrival" if datetime.now() <= window.window_end else "Not Arrived"
        elif actual_arrival > window.window_end:
            status = "Late"
        else:
            # Arriving before the window opens counts as On-Time here for the
            # same reason as in the schedule view: the material is in.
            status = "On-Time"

        return {
            "id": window.id, "vendor_code": window.vendor_code,
            "supplier_name": supplier.supplier_name if supplier else None,
            "vehicle_no": vehicle_no, "expected_date": window.expected_date.isoformat(),
            "window_start": window.window_start.isoformat() if window.window_start else None,
            "window_end": window.window_end.isoformat() if window.window_end else None,
            "has_window": has_window,
            "actual_arrival": actual_arrival.isoformat() if actual_arrival else None,
            "actual_out": actual_out.isoformat() if actual_out else None,
            "notes": window.notes, "status": status,
        }

    def list_all(self, vendor_code=None, expected_date=None):
        return [self._enrich(w) for w in self.repo.search(vendor_code=vendor_code, expected_date=expected_date).all()]

    def get(self, window_id):
        window = self.repo.get_by_id(window_id)
        if not window:
            raise NotFoundError(f"Supplier vehicle window {window_id} not found")
        return window

    def create(self, data):
        if not self.supplier_repo.get_by_vendor_code(data["vendor_code"]):
            raise BadRequestError(f"Unknown vendor code: {data['vendor_code']}")
        # Ad-hoc vehicle: number/date may be unknown (supplier has no fixed
        # vehicle, arrival date not decided). Keep the NOT NULL columns happy
        # with sensible placeholders so it can still be logged & counted — a
        # dash for an unknown vehicle, today for an unlogged date.
        if not data.get("vehicle_no"):
            data["vehicle_no"] = "—"
        if not data.get("expected_date"):
            data["expected_date"] = date.today()
        # Both blank is valid (ad-hoc vehicle, no decided window). Only
        # reject a half-filled window or an inverted one.
        if bool(data.get("window_start")) != bool(data.get("window_end")):
            raise BadRequestError("Window Start and Window End must both be set, or both left blank")
        if data.get("window_start") and data["window_end"] <= data["window_start"]:
            raise BadRequestError("Window End must be after Window Start")
        window = self.repo.create(**data)
        return self._enrich(window)

    def update(self, window_id, data):
        window = self.get(window_id)
        start = data.get("window_start", window.window_start)
        end = data.get("window_end", window.window_end)
        if bool(start) != bool(end):
            raise BadRequestError("Window Start and Window End must both be set, or both left blank")
        if start and end <= start:
            raise BadRequestError("Window End must be after Window Start")
        window = self.repo.update(window, **data)
        return self._enrich(window)

    def delete(self, window_id):
        window = self.get(window_id)
        self.repo.delete(window)
