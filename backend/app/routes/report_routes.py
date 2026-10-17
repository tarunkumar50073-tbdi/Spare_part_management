"""Reports REST API (/api/v1/reports) — the Reports page of each store.

GET /catalog?store_code=   the reports that store offers, in page order
GET /<key>/<excel|csv|pdf>  one report as a file; store_code picks the store
                            (none = the Child Parts Store, as before), and the
                            dated reports take date_from / date_to (YYYY-MM-DD)."""
from flask import Blueprint, request, send_file
from app.services.report_service import ReportService
from app.utils.authz import permission_required, require_store_access
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response

bp = Blueprint("reports", __name__, url_prefix="/api/v1/reports")
service = ReportService()


@bp.route("/catalog", methods=["GET"])
@permission_required("reports", "view")
def catalog():
    store_code = request.args.get("store_code")
    if not store_code:
        raise BadRequestError("store_code is required")
    require_store_access(store_code)
    return success_response(service.catalog(store_code))


@bp.route("/<report_type>/<fmt>", methods=["GET"])
@permission_required("reports", "view")
def export(report_type, fmt):
    store_code = request.args.get("store_code") or None
    if store_code:
        require_store_access(store_code)
    buf, name, mimetype = service.export(
        report_type, fmt, store_code,
        date_from=request.args.get("date_from"), date_to=request.args.get("date_to"),
    )
    return send_file(buf, as_attachment=True, download_name=name, mimetype=mimetype)
