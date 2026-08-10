"""ERP vs Physical Gap REST API (/api/v1/erp-gap) — reconciles ERP-pushed
stock against the latest physical count, with Excel upload / remove of the
physical figure."""
from flask import Blueprint, request, send_file
from app.services.erp_gap_service import ERPGapService
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response

bp = Blueprint("erp_gap", __name__, url_prefix="/api/v1/erp-gap")
service = ERPGapService()

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@bp.route("", methods=["GET"])
def list_gap():
    rows = service.get_gap(
        keyword=request.args.get("keyword"),
        category=request.args.get("category"),
        status=request.args.get("status"),
    )
    return success_response(rows)


@bp.route("/summary", methods=["GET"])
def summary():
    return success_response(service.get_summary())


@bp.route("/import", methods=["POST"])
def import_physical():
    file = request.files.get("file")
    if not file or file.filename == "":
        raise BadRequestError("No file uploaded")
    report = service.import_physical_excel(file.stream)
    return success_response(report, f"{report['created']} of {report['total_rows']} physical counts imported", 201)


@bp.route("/physical", methods=["DELETE"])
def clear_physical():
    removed = service.clear_physical()
    return success_response({"removed": removed}, f"Cleared {removed} physical count(s)")


@bp.route("/template", methods=["GET"])
def download_template():
    buf = service.build_template()
    return send_file(buf, as_attachment=True, download_name="physical_stock_template.xlsx", mimetype=XLSX_MIME)


@bp.route("/export", methods=["GET"])
def export_gap():
    buf = service.export_excel(
        keyword=request.args.get("keyword"),
        category=request.args.get("category"),
        status=request.args.get("status"),
    )
    return send_file(buf, as_attachment=True, download_name="erp_vs_physical_gap.xlsx", mimetype=XLSX_MIME)
