"""Kiosk part-request lifecycle.

The ACTUAL stock deduction + transaction is delegated to
SpareStockService.issue (never re-implemented here), so there is NO double
deduction — this service only tracks the request and links it to the issue
ledger row. One issue CLOSES the request (PENDING -> ISSUED); if stock was short
the available qty is issued and issued_qty < requested_qty records the shortfall.
There is no partial / keep-open (PROCESSING / PARTIALLY_ISSUED are unused).
The location scan is RIGHT at either of the part's bins — its fresh location or,
when it has one, its rework location (utils/bin_location).
"""
from sqlalchemy.orm import joinedload

from app.extensions import db
from app.models.base import utcnow
from app.models.employee import Employee
from app.models.part_request import PartRequest
from app.repositories.part_repository import PartRepository
from app.services.spare_stock_service import SpareStockService
# loc_base stays importable here as _loc_base (the requests report uses it).
from app.utils.bin_location import bins_text, loc_base as _loc_base, match_bin, part_bins  # noqa: F401
from app.utils.db_tx import atomic
from app.utils.exceptions import BadRequestError, NotFoundError

OPEN_STATUSES = ("PENDING", "PROCESSING", "PARTIALLY_ISSUED")


class PartRequestService:
    def __init__(self):
        self.parts = PartRepository()
        self.stock = SpareStockService()

    def _dict(self, r):
        requested = float(r.requested_qty or 0)
        issued = float(r.issued_qty or 0)
        return {
            "id": r.id, "reference_no": r.reference_no, "store_code": r.store_code,
            "part_id": r.part_id, "part_no": r.part_no, "part_name": r.part_name,
            "assigned_location": r.assigned_location,
            # The part's rework bin (live — the request snapshots only the fresh
            # location); None for a part with one location.
            "rework_location": r.part.rework_location if r.part else None,
            "requested_qty": requested, "issued_qty": issued,
            "remaining_qty": round(max(requested - issued, 0), 2),
            "employee_id": r.employee_id, "requester_name": r.requester_name,
            "requester_code": r.requester_code, "requester_mobile": r.requester_mobile,
            "department": r.department, "status": r.status,
            "scanned_location": r.scanned_location, "issue_ledger_id": r.issue_ledger_id,
            "supervisor": r.supervisor,
            "issued_at": r.issued_at.isoformat() if r.issued_at else None,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "remarks": r.remarks,
        }

    def _available(self, part_id):
        """Live on-hand for a part — None means the part was never counted, i.e.
        stock data is unavailable (do not assume it is in stock)."""
        row = self.stock.get_for_part(part_id)
        return row.get("qty_on_hand") if row else None

    def create(self, store_code, data, user=None):
        part = self.parts.get_by_id(data["part_id"])
        if not part:
            raise NotFoundError("Part not found")
        if getattr(part, "is_active", True) is False:
            raise BadRequestError("Part is inactive")
        if part.store_code != store_code:
            raise BadRequestError("Part is not in this store")
        qty = float(data["requested_qty"])
        if qty <= 0:
            raise BadRequestError("Requested quantity must be greater than 0")
        # Requester from the Employee master (by id), free-text as fallback.
        emp = Employee.query.get(data["employee_id"]) if data.get("employee_id") else None
        name = (emp.name if emp else data.get("requester_name")) or None
        with atomic():
            r = PartRequest(
                store_code=store_code, part_id=part.id, part_no=part.part_no,
                part_name=part.part_name, assigned_location=part.location,
                requested_qty=round(qty, 2), issued_qty=0,
                employee_id=(emp.id if emp else None), requester_name=name,
                requester_code=(emp.employee_code if emp else None),
                requester_mobile=(emp.mobile if emp else data.get("requester_mobile")),
                department=(data.get("department") or (emp.department if emp else None)),
                status="PENDING", remarks=data.get("remarks"),
            )
            db.session.add(r)
            db.session.flush()   # assign id so the reference can embed it
            r.reference_no = f"REQ-{utcnow().strftime('%Y%m%d')}-{r.id:05d}"
        out = self._dict(r)
        out["available_qty"] = self._available(part.id)
        return out

    def list(self, store_code=None, status=None, limit=200):
        q = PartRequest.query.options(joinedload(PartRequest.part))
        if store_code:
            q = q.filter(PartRequest.store_code == store_code)
        if status:
            statuses = list(status) if isinstance(status, (list, tuple)) else [status]
            q = q.filter(PartRequest.status.in_(statuses))
        q = q.order_by(PartRequest.created_at.desc(), PartRequest.id.desc())
        if limit:
            q = q.limit(limit)
        return [self._dict(r) for r in q.all()]

    def get(self, request_id):
        r = PartRequest.query.get(request_id)
        if not r:
            raise NotFoundError("Request not found")
        out = self._dict(r)
        out["available_qty"] = self._available(r.part_id)
        return out

    def issue(self, request_id, scanned_location, issued_qty, user=None, token=None, remarks=None):
        r = PartRequest.query.get(request_id)
        if not r:
            raise NotFoundError("Request not found")
        # Idempotency FIRST: the same token as the last successful issue is a
        # double click — return the current state (no second issue, no error),
        # even though that issue already closed the request.
        if token and r.last_issue_token and token == r.last_issue_token:
            return self.get(request_id)
        if r.status in ("ISSUED", "CANCELLED"):
            raise BadRequestError(f"Request is already {r.status.replace('_', ' ').title()}")
        part = r.part or self.parts.get_by_id(r.part_id)
        if not part:
            raise NotFoundError("Part not found")
        # Right/Wrong location guard: the part's fresh location or, when it has
        # one, its rework location — a bare bin QR at bin level, a slot "(n)"
        # only that exact slot (the screen's rule).
        bins = part_bins(part.location, part.rework_location)
        if not bins:
            raise BadRequestError("Part has no assigned location")
        if not match_bin(scanned_location, bins):
            raise BadRequestError(f"Wrong location — {part.part_no} is at {bins_text(bins)}")
        qty = float(issued_qty)
        if qty <= 0:
            raise BadRequestError("Issued quantity must be greater than 0")
        remaining = round(float(r.requested_qty) - float(r.issued_qty), 2)
        if qty > remaining:
            raise BadRequestError(f"Only {remaining} remaining on this request")
        # Stock data must be reliable; None = never counted = unavailable.
        if self._available(part.id) is None:
            raise BadRequestError("Stock data unavailable for this part — cannot issue")
        # The actual deduction + ledger + journal is done by issue(); our request
        # update rides in the SAME transaction (nested atomic joins the outermost).
        with atomic():
            result = self.stock.issue(
                part.id, qty, r.department,
                employee_id=r.employee_id, issued_to_mobile=r.requester_mobile,
                issued_to=r.requester_name, reference=r.reference_no,
                scanned_code=scanned_location, scan_source="kiosk_request", user=user,
            )
            ledger_id = (result.get("issue") or {}).get("id")
            new_issued = round(float(r.issued_qty) + qty, 2)
            r.issued_qty = new_issued
            r.scanned_location = scanned_location
            r.supervisor = user
            r.issued_at = utcnow()
            r.issue_ledger_id = ledger_id
            r.last_issue_token = token
            if remarks:
                r.remarks = remarks
            # One issue CLOSES the request. The supervisor gives whatever stock is
            # available (up to requested); there is no partial / keep-open. If less
            # than requested was given (stock short), it is still closed as ISSUED
            # with issued_qty < requested_qty recording the shortfall.
            r.status = "ISSUED"
            db.session.add(r)
        out = self.get(request_id)
        out["issue"] = result.get("issue")
        return out

    def cancel(self, request_id, user=None):
        r = PartRequest.query.get(request_id)
        if not r:
            raise NotFoundError("Request not found")
        if r.status in ("ISSUED", "CANCELLED"):
            raise BadRequestError(f"Request is already {r.status.replace('_', ' ').title()}")
        with atomic():
            r.status = "CANCELLED"
            r.supervisor = user
            db.session.add(r)
        return self.get(request_id)
