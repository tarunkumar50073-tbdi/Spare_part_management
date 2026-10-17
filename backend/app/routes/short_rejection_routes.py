"""Short & Rejection REST API (/api/v1/short-rejection).

Read-only and store-scoped: what suppliers sent short and what quality rejected
on the ERP GRN lines of a store's parts, supplier-wise and line by line, with
the days each has been pending (ShortRejectionService; the store, 17 Oct 2026:
"taaki pta chale kis supplier ki rejection padi h kitne dino se and kis lot k
against me reject hui"). The right is the Receiving & GRN screen's own
(spare_store view): this is the same ERP GRN register, cut another way.

GET ""          {summary, lines, totals, data_as_of, basis, window, filters, title}
                store_code, from / to (the GRN date, YYYY-MM-DD; default the
                last 90 days), supplier (code, or text in the code / name),
                part_id
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
        "date_from": request.args.get("from"),
        "date_to": request.args.get("to"),
        "supplier": request.args.get("supplier"),
        "part_id": (request.args.get("part_id") or "").strip() or None,
    }


@bp.route("", methods=["GET"])
@permission_required("spare_store", "view")
def report():
    return success_response(service.report(_store_code(), **_filters()))


@bp.route("/export", methods=["GET"])
@permission_required("spare_store", "view")
def export():
    code = _store_code()
    buf, name, mimetype = service.export(code, request.args.get("format"), **_filters())
    return send_file(buf, as_attachment=True, download_name=name, mimetype=mimetype)
