"""Reports REST API (/api/v1/reports) — SRV, Verification, Pending RQC, Put
Away, Rack Stock, Live Stock and Supplier reports, each as Excel or PDF."""
from flask import Blueprint, send_file
from app.services.report_service import ReportService
from app.utils.authz import permission_required

bp = Blueprint("reports", __name__, url_prefix="/api/v1/reports")
service = ReportService()


@bp.route("/<report_type>/excel", methods=["GET"])
@permission_required("reports", "view")
def export_excel(report_type):
    buf = service.export_excel(report_type)
    return send_file(buf, as_attachment=True, download_name=f"{report_type}_report.xlsx",
                      mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@bp.route("/<report_type>/pdf", methods=["GET"])
@permission_required("reports", "view")
def export_pdf(report_type):
    title, buf = service.export_pdf(report_type)
    return send_file(buf, as_attachment=True, download_name=f"{report_type}_report.pdf", mimetype="application/pdf")


@bp.route("/<report_type>/csv", methods=["GET"])
@permission_required("reports", "view")
def export_csv(report_type):
    buf = service.export_csv(report_type)
    return send_file(buf, as_attachment=True, download_name=f"{report_type}_report.csv", mimetype="text/csv")
