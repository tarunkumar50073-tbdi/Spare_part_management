"""Consumption Analytics REST API (/api/v1/consumption-analytics).

Read-only and store-scoped: what the Spare store issued over a window, against
the window before it (ConsumptionAnalyticsService — the report's charts), and
the Issuance & Consumption Report's table in the view the store picks — on
screen and as Excel / PDF (ConsumptionTableService; the store, 14 Oct 2026:
"wahi se excel / pdf download ho jaaye"), plus its Full pack workbook. One
report again since 18 Oct 2026 ("issuance and consumption report same dikh rhi
h ... ye kaam merge me bhi ho sakta h"): what left the store, what came back
and what each department really used, side by side. Downloads only: nothing
here mails ("mail nhi karenge bas excel/pdf download ka option" — the store,
17 Oct 2026).

GET ""               the charts, breakdowns and spikes
GET /options         the filter bar's sections, part types, consuming
                     departments and the presets' ranges on the plant clock
                     (yesterday, last_month, this_fy, last_fy)
GET /table           one view: view=list|day|week|month|year|fy|part|
                     department|person|machine|category, from / to, part_id,
                     section_id, department (the consuming one), type; the
                     Issue list may take group=day|month|year|fy (else it
                     follows the range's length). report=consumption, or
                     report=issuance / none from an older link: the same report.
GET /table/export    the same view as a file: format=excel|pdf
GET /table/pack      the Full pack: one workbook of the range and filters"""
from flask import Blueprint, request, send_file

from app.services.consumption_analytics_service import ConsumptionAnalyticsService
from app.services.consumption_table_service import ConsumptionTableService, presets
from app.utils.authz import permission_required, require_store_access
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response

bp = Blueprint("consumption_analytics", __name__, url_prefix="/api/v1/consumption-analytics")
service = ConsumptionAnalyticsService()
tables = ConsumptionTableService()


def _store_code():
    code = request.args.get("store_code")
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    return code


def _int_arg(name):
    # A malformed id is refused rather than silently dropped — dropping it would
    # answer for the whole store while the screen says it is filtered.
    raw = (request.args.get(name) or "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        raise BadRequestError(f"'{name}' must be a whole number") from None


def _table_args():
    """The report, its range and filters, as the charts take them."""
    args = request.args
    return {
        "report": args.get("report"),
        "date_from": args.get("from"),
        "date_to": args.get("to"),
        "part_id": _int_arg("part_id"),
        "section_id": _int_arg("section_id"),
        "department": args.get("department"),
        "part_type": args.get("type"),
    }


@bp.route("", methods=["GET"])
@permission_required("consumption", "view")
def analytics():
    code = _store_code()
    args = request.args
    return success_response(service.analytics(
        code,
        date_from=args.get("from"),
        date_to=args.get("to"),
        granularity=args.get("granularity"),
        section_id=_int_arg("section_id"),
        department=args.get("department"),
        part_type=args.get("type"),
        part_id=_int_arg("part_id"),
    ))


@bp.route("/options", methods=["GET"])
@permission_required("consumption", "view")
def options():
    # The presets ride along: the screen's Yesterday / Last month / financial
    # years are cut on the plant clock here, not on whatever clock a browser keeps.
    code = _store_code()
    return success_response({**service.options(code), "presets": presets()})


@bp.route("/table", methods=["GET"])
@permission_required("consumption", "view")
def table():
    code = _store_code()
    return success_response(tables.table(code, request.args.get("view"), group=request.args.get("group"),
                                         **_table_args()))


@bp.route("/table/export", methods=["GET"])
@permission_required("consumption", "view")
def table_export():
    code = _store_code()
    buf, name, mimetype = tables.export(code, request.args.get("format"), request.args.get("view"),
                                        group=request.args.get("group"), **_table_args())
    return send_file(buf, as_attachment=True, download_name=name, mimetype=mimetype)


@bp.route("/table/pack", methods=["GET"])
@permission_required("consumption", "view")
def table_pack():
    code = _store_code()
    buf, name, mimetype = tables.pack(code, **_table_args())
    return send_file(buf, as_attachment=True, download_name=name, mimetype=mimetype)
