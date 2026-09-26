"""Consumption Analytics REST API (/api/v1/consumption-analytics).

Read-only and store-scoped: what the Spare store issued over a window, against
the window before it. The figures are built in ConsumptionAnalyticsService."""
from flask import Blueprint, request

from app.services.consumption_analytics_service import ConsumptionAnalyticsService
from app.utils.authz import permission_required, require_store_access
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response

bp = Blueprint("consumption_analytics", __name__, url_prefix="/api/v1/consumption-analytics")
service = ConsumptionAnalyticsService()


def _store_code():
    code = request.args.get("store_code")
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    return code


def _int_arg(name):
    # A malformed id is refused rather than silently dropped — dropping it would
    # answer for the whole store while the screen says it is filtered.
    raw = (request.args.get(name) or "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        raise BadRequestError(f"'{name}' must be a whole number") from None


@bp.route("", methods=["GET"])
@permission_required("spare_store", "view")
def analytics():
    code = _store_code()
    args = request.args
    return success_response(service.analytics(
        code,
        date_from=args.get("from"),
        date_to=args.get("to"),
        granularity=args.get("granularity"),
        section_id=_int_arg("section_id"),
        department=args.get("department"),
        part_type=args.get("type"),
        part_id=_int_arg("part_id"),
    ))


@bp.route("/options", methods=["GET"])
@permission_required("spare_store", "view")
def options():
    return success_response(service.options(_store_code()))
