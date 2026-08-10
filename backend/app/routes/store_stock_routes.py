"""Store Stock REST API (/api/v1/store/stock) — Available Store Stock vs
Pending RQC Stock. Only Available Store Stock can be used/issued."""
from flask import Blueprint
from app.services.store_stock_service import StoreStockService
from app.utils.response import success_response

bp = Blueprint("store_stock", __name__, url_prefix="/api/v1/store/stock")
service = StoreStockService()


@bp.route("", methods=["GET"])
def summary():
    return success_response(service.get_summary())
