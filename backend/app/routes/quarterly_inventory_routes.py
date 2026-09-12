"""Quarterly Inventory REST API (/api/v1/quarterly-inventory)."""
from flask import Blueprint, request, send_file
from app.services.quarterly_inventory_service import QuarterlyInventoryService
from app.utils.response import success_response
from app.utils.exceptions import BadRequestError
from app.utils.authz import admin_required

bp = Blueprint("quarterly_inventory", __name__, url_prefix="/api/v1/quarterly-inventory")
service = QuarterlyInventoryService()


@bp.route("", methods=["GET"])
def list_detail():
    fiscal_year = request.args.get("fiscal_year")
    quarter = request.args.get("quarter")
    if not fiscal_year or not quarter:
        raise BadRequestError("fiscal_year and quarter are required")
    rows = service.list_detail(
        fiscal_year, quarter,
        keyword=request.args.get("keyword"), category=request.args.get("category"),
        status=request.args.get("status"),
    )
    return success_response(rows)


@bp.route("/summary", methods=["GET"])
def summary():
    fiscal_year = request.args.get("fiscal_year")
    quarter = request.args.get("quarter")
    if not fiscal_year or not quarter:
        raise BadRequestError("fiscal_year and quarter are required")
    return success_response(service.get_summary(fiscal_year, quarter))


@bp.route("/fy-comparison", methods=["GET"])
def fy_comparison():
    return success_response(service.get_fy_comparison())


@bp.route("/quarter-comparison", methods=["GET"])
def quarter_comparison():
    fiscal_year = request.args.get("fiscal_year")
    if not fiscal_year:
        raise BadRequestError("fiscal_year is required")
    return success_response(service.get_quarter_comparison(fiscal_year))


@bp.route("/fiscal-years", methods=["GET"])
def fiscal_years():
    return success_response(service.repo.list_fiscal_years())


@bp.route("/template", methods=["GET"])
def download_template():
    buf = service.build_template()
    return send_file(buf, as_attachment=True, download_name="quarterly_inventory_template.xlsx",
                      mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@bp.route("/import", methods=["POST"])
@admin_required
def import_inventory():
    fiscal_year = request.form.get("fiscal_year") or request.args.get("fiscal_year")
    quarter = request.form.get("quarter") or request.args.get("quarter")
    if not fiscal_year or not quarter:
        raise BadRequestError("fiscal_year and quarter are required")
    file = request.files.get("file")
    if not file or file.filename == "":
        raise BadRequestError("No file uploaded")
    sheet = request.form.get("sheet") or request.args.get("sheet")
    report = service.bulk_import_excel(file.stream, fiscal_year, quarter, sheet)
    return success_response(report, f"{report['created']} of {report['total_rows']} rows imported", 201)
