"""Part Search kiosk REST API (/api/v1/part-kiosk) — read only.

The kiosk outside the spare store: search a part, see its photo, stock, place
and section (PartKioskService). Right: "part_kiosk" (view only — the screen has
nothing to change); the photos themselves come from GET /parts/<id>/image.

GET    /parts                 store_code, q, page, per_page
"""
from flask import Blueprint, request

from app.services.part_kiosk_service import PartKioskService
from app.utils.authz import permission_required, require_store_access
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response

bp = Blueprint("part_kiosk", __name__, url_prefix="/api/v1/part-kiosk")
service = PartKioskService()


@bp.route("/parts", methods=["GET"])
@permission_required("part_kiosk", "view")
def parts():
    code = (request.args.get("store_code") or "").strip()
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    return success_response(service.search(code, request.args.get("q"),
                                           page=request.args.get("page", 1, type=int),
                                           per_page=request.args.get("per_page", 24, type=int)))
