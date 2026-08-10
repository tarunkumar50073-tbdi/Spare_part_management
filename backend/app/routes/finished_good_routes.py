"""Finished Good master REST API (/api/v1/finished-goods) — read-only list
for dropdowns; rows are created implicitly via the BOM master or forecast
upload."""
from flask import Blueprint
from app.services.finished_good_service import FinishedGoodService
from app.utils.response import success_response

bp = Blueprint("finished_goods", __name__, url_prefix="/api/v1/finished-goods")
service = FinishedGoodService()


@bp.route("", methods=["GET"])
def list_finished_goods():
    rows = service.list_all()
    return success_response([r.to_dict() for r in rows])
