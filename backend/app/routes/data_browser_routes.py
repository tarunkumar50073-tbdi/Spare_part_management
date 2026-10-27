"""Data Browser REST API (/api/v1/data-browser) — every table of the app's
database, read only, administrators only (DataBrowserService).

GET /tables                       every table: group, what it holds, rows, columns
GET /tables/<name>                q, sort, desc, page, page_size — rows a page at a time
GET /tables/<name>/export         q, sort, desc — the rows as Excel (secrets hidden)
"""
from flask import Blueprint, request, send_file

from app.services.data_browser_service import DataBrowserService
from app.utils.authz import admin_required
from app.utils.response import success_response

bp = Blueprint("data_browser", __name__, url_prefix="/api/v1/data-browser")
service = DataBrowserService()
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _args():
    return dict(q=request.args.get("q"), sort=request.args.get("sort") or None,
                desc=request.args.get("desc") in ("1", "true"))


@bp.route("/tables", methods=["GET"])
@admin_required
def tables():
    return success_response(service.tables())


@bp.route("/tables/<name>", methods=["GET"])
@admin_required
def rows(name):
    return success_response(service.rows(name, page=request.args.get("page", 1, type=int),
                                         page_size=request.args.get("page_size", 50, type=int), **_args()))


@bp.route("/tables/<name>/export", methods=["GET"])
@admin_required
def export(name):
    buf, filename = service.export(name, **_args())
    return send_file(buf, mimetype=XLSX, as_attachment=True, download_name=filename)
