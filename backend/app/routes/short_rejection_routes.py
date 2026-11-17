"""Short Receiving REST API (/api/v1/short-rejection).

Read-only and store-scoped: what suppliers sent short on the ERP GRN lines of a
store's parts, supplier-wise and line by line, with the days each has been
pending (ShortRejectionService). The right is "short_rejection" (its key kept
from when the screen also showed rejections; the store removed every rejection
view on 17 Nov 2026: "only rejection ka hta de na dekhni na bhejni . short wala
rhne de").

GET ""          {kind, label, available, summary, lines, totals, data_as_of,
                closures_known, basis, window, filters, title}
                store_code, kind (only "short"; may be left out), period (30d |
                90d | month | last_month | this_fy | last_fy | custom, cut on
                the plant clock; default 90d), from / to (custom: the GRN date,
                YYYY-MM-DD), supplier (code, or text in the code / name), part
                (text in the Part No / description) or part_id
GET /export     the same as ONE file: format=excel (sheets "Supplier-wise" and
                "Lines") | pdf
"""
from flask import Blueprint, request, send_file

from app.services.short_rejection_service import ShortRejectionService
from app.utils.authz import permission_required, require_store_access
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response

bp = Blueprint("short_rejection", __name__, url_prefix="/api/v1/short-rejection")
service = ShortRejectionService()


def _store_code():
    code = request.args.get("store_code")
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    return code


def _filters():
    return {
        "kind": request.args.get("kind"),
        "period": request.args.get("period"),
        "date_from": request.args.get("from"),
        "date_to": request.args.get("to"),
        "supplier": request.args.get("supplier"),
        "part": request.args.get("part"),
        "part_id": (request.args.get("part_id") or "").strip() or None,
    }


@bp.route("", methods=["GET"])
@permission_required("short_rejection", "view")
def report():
    return success_response(service.report(_store_code(), **_filters()))


@bp.route("/export", methods=["GET"])
@permission_required("short_rejection", "view")
def export():
    code = _store_code()
    buf, name, mimetype = service.export(code, request.args.get("format"), **_filters())
    return send_file(buf, as_attachment=True, download_name=name, mimetype=mimetype)

