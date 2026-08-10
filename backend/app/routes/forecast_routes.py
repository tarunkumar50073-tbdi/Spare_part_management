"""SCM Forecast REST API (/api/v1/forecast) — Excel upload today, same
`ingest_rows` service entry point the future SCM API push will call."""
from flask import Blueprint, request
from app.services.forecast_service import ForecastService
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response

bp = Blueprint("forecast", __name__, url_prefix="/api/v1/forecast")
service = ForecastService()


@bp.route("/upload", methods=["POST"])
def upload_forecast():
    file = request.files.get("file")
    if not file or file.filename == "":
        raise BadRequestError("No file uploaded")
    count = service.ingest_excel(file.stream)
    return success_response({"rows_ingested": count}, "Forecast ingested", 201)


@bp.route("/summary", methods=["GET"])
def forecast_summary():
    return success_response(service.get_forecast_summary())


@bp.route("/peak", methods=["GET"])
def peak_requirement_all():
    return success_response(service.get_peak_requirement_for_all_bom_parts())


@bp.route("/peak/<int:part_id>", methods=["GET"])
def peak_requirement(part_id):
    peak = service.get_peak_requirement(part_id)
    return success_response(peak)
