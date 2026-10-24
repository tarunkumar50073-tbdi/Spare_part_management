"""Data Quality REST API (/api/v1/data-quality) — how complete and consistent
the spare part master is. See DataQualityService."""
from flask import Blueprint, request

from app.services.data_quality_service import DataQualityService
from app.utils.authz import permission_required, require_store_access
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response

bp = Blueprint("data_quality", __name__, url_prefix="/api/v1/data-quality")
service = DataQualityService()


def _store_code():
    code = request.args.get("store_code")
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    return code


@bp.route("", methods=["GET"])
@permission_required("data_quality", "view")
def summary():
    """Completeness % plus every check with its count."""
    code = _store_code()
    return success_response(service.summary(code, section_id=request.args.get("section_id", type=int)))


@bp.route("/parts", methods=["GET"])
@permission_required("data_quality", "view")
def parts():
    """The parts one check flags (?check=<key>); 400 on an unknown check."""
    code = _store_code()
    check = (request.args.get("check") or "").strip()
    return success_response(service.parts(code, check, section_id=request.args.get("section_id", type=int)))
