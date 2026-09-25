"""Daily Stock Count REST API (/api/v1/stock-count) — the in-app
replacement for the Excel count sheet."""
from datetime import datetime, date
from flask import Blueprint, request, send_file
from app.services.stock_count_service import StockCountService
from app.schemas.stock_count_schema import StockCountSubmitSchema
from app.utils.validators import validate_payload
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response
from app.utils.authz import permission_required

bp = Blueprint("stock_count", __name__, url_prefix="/api/v1/stock-count")
service = StockCountService()


def _parse_date_param():
    date_str = request.args.get("date")
    if not date_str:
        return None
    try:
        return datetime.strptime(date_str, "%Y-%m-%d").date()
    except ValueError:
        raise BadRequestError("date must be in YYYY-MM-DD format")


@bp.route("/sheet", methods=["GET"])
def get_sheet():
    return success_response(service.get_today_sheet(_parse_date_param()))


@bp.route("/submit", methods=["POST"])
@permission_required("child_store", "edit")
def submit():
    data = validate_payload(StockCountSubmitSchema(), request.get_json(force=True) or {})
    count = service.submit(data["count_date"], data["entries"])
    return success_response({"entries_saved": count}, "Stock count saved")


@bp.route("/template", methods=["GET"])
def download_template():
    buf = service.build_template()
    return send_file(buf, as_attachment=True, download_name="daily_stock_count_template.xlsx",
                      mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@bp.route("/export", methods=["GET"])
def export_sheet():
    buf = service.export_sheet(_parse_date_param())
    return send_file(buf, as_attachment=True, download_name="daily_stock_count_export.xlsx",
                      mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@bp.route("/import", methods=["POST"])
@permission_required("child_store", "edit")
def import_counts():
    count_date = _parse_date_param() or date.today()
    file = request.files.get("file")
    if not file or file.filename == "":
        raise BadRequestError("No file uploaded")
    report = service.bulk_import_excel(file.stream, count_date, request.args.get("sheet"))
    message = (
        f"{report['created']} of {report['total_rows']} rows imported "
        f"into {report['parts_updated']} part(s)"
    )
    return success_response(report, message, 201)
