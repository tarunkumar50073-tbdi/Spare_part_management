"""Kiosk part-request REST API (/api/v1/part-requests).

The kiosk (outside the locked store) CREATES requests (gated by the 'kiosk'
right); the supervisor LISTS / opens / issues / cancels them (gated by
'scan_part'). The actual stock deduction is delegated to the spare-stock issue
service — this layer only manages the request lifecycle.
"""
from flask import Blueprint, request, session

from app.models.part_request import PartRequest
from app.services.auth_service import AuthService
from app.services.part_request_service import PartRequestService
from app.schemas.part_request_schema import PartRequestCreateSchema, PartRequestIssueSchema
from app.utils.authz import permission_required, require_store_access
from app.utils.event_bus import publish
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response
from app.utils.validators import validate_payload

bp = Blueprint("part_requests", __name__, url_prefix="/api/v1/part-requests")
service = PartRequestService()
auth = AuthService()

OPEN = ("PENDING", "PROCESSING", "PARTIALLY_ISSUED")


def _store_code():
    code = (request.args.get("store_code")
            or (request.get_json(silent=True) or {}).get("store_code")
            or request.form.get("store_code"))
    if not code:
        raise BadRequestError("store_code is required")
    # A store user may only touch stores they're assigned to; machine/admin pass.
    require_store_access(code)
    return code


def _username():
    user = auth.get_user(session.get("user_id"))
    return user.username if user else None


def _require_request_store(request_id):
    """Scope a by-id action to the caller's store (IDOR guard): a supervisor may
    only open / issue / cancel requests belonging to a store they're assigned to.
    The request's OWN store_code is the source of truth; a missing row falls
    through so the service raises the 404."""
    r = PartRequest.query.get(request_id)
    if r is not None:
        require_store_access(r.store_code)


@bp.route("", methods=["POST"])
@permission_required("kiosk", "edit")
def create_request():
    """Kiosk: submit a part request. Returns the reference number + status."""
    store_code = _store_code()
    data = validate_payload(PartRequestCreateSchema(), request.get_json(force=True) or {})
    row = service.create(store_code, data, user=_username())
    publish("part_request", {"action": "create", "id": row["id"]})
    return success_response(row, f"Request {row['reference_no']} submitted", 201)


@bp.route("", methods=["GET"])
@permission_required("scan_part", "view")
def list_requests():
    """Supervisor queue / history. ?status=open (default, the live queue),
    ?status=all (everything), or a comma list of statuses."""
    store_code = _store_code()
    st = request.args.get("status")
    if st in (None, "", "open"):
        status = OPEN
    elif st == "all":
        status = None
    else:
        status = [s.strip().upper() for s in st.split(",") if s.strip()]
    rows = service.list(store_code=store_code, status=status,
                        limit=request.args.get("limit", default=200, type=int))
    return success_response(rows)


@bp.route("/<int:request_id>", methods=["GET"])
@permission_required("scan_part", "view")
def get_request(request_id):
    _require_request_store(request_id)
    return success_response(service.get(request_id))


@bp.route("/<int:request_id>/issue", methods=["POST"])
@permission_required("scan_part", "edit")
def issue_request(request_id):
    """Supervisor confirm-issue: validates the scanned location Right/Wrong (the
    part's fresh bin or its rework bin), issues the actual quantity (existing
    issue flow deducts stock), and updates the request to Issued / Partially
    Issued."""
    _require_request_store(request_id)
    data = validate_payload(PartRequestIssueSchema(), request.get_json(force=True) or {})
    row = service.issue(request_id, data["scanned_location"], float(data["issued_qty"]),
                        user=_username(), token=data.get("token"), remarks=data.get("remarks"))
    publish("stock", {"part_id": row.get("part_id"), "action": "issue"})
    publish("part_request", {"action": "issue", "id": request_id})
    return success_response(row, "Issued")


@bp.route("/<int:request_id>/cancel", methods=["POST"])
@permission_required("scan_part", "edit")
def cancel_request(request_id):
    _require_request_store(request_id)
    row = service.cancel(request_id, user=_username())
    publish("part_request", {"action": "cancel", "id": request_id})
    return success_response(row, "Request cancelled")
