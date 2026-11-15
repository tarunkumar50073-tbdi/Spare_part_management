"""Quarterly Inventory API (/api/v1/inventory), 15 Nov 2026. Rights:
inventory_count (Counter), inventory_review (Supervisor), inventory_approve
(Manager); any of the three reads."""
from datetime import date

from flask import Blueprint, request, send_file

from app.services.inventory_count_service import InventoryCountService, fiscal_year_of, quarter_of
from app.utils.authz import current_user, permission_required, require_store_access
from app.utils.exceptions import BadRequestError, NotFoundError
from app.utils.response import success_response

bp = Blueprint("inventory_count", __name__, url_prefix="/api/v1/inventory")
service = InventoryCountService()
READ = ("inventory_count", "inventory_review", "inventory_approve", "live_dashboard")


def _who():
    return getattr(current_user(), "username", None)


def _store(value=None):
    code = (value if value is not None else request.args.get("store_code") or "").strip()
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    return code


def _body():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def _bstore():
    return _store(_body().get("store_code") or request.args.get("store_code"))


@bp.route("/period", methods=["GET"])
@permission_required(READ)
def period():
    today = date.today()
    return success_response({"fiscal_year": fiscal_year_of(today), "quarter": quarter_of(today)})


@bp.route("/sessions", methods=["GET"])
@permission_required(READ)
def sessions():
    return success_response(service.sessions(_store(), request.args.get("fiscal_year") or None,
                                             request.args.get("quarter") or None))


@bp.route("/sessions", methods=["POST"])
@permission_required("inventory_review", "create")
def plan():
    d = _body()
    return success_response(service.plan(
        _bstore(), d.get("fiscal_year"), d.get("quarter"), d.get("section_id"), d.get("start_date"),
        d.get("close_date"), _who(), remarks=d.get("remarks"), duplicate_reason=d.get("duplicate_reason")),
        "Inventory planned", 201)


@bp.route("/sessions/<int:sid>", methods=["GET"])
@permission_required(READ)
def detail(sid):
    return success_response(service.detail(sid, _store(), view=request.args.get("view") or "parts",
                                           status=request.args.get("status") or None, q=request.args.get("q")))


@bp.route("/sessions/<int:sid>", methods=["PATCH"])
@permission_required("inventory_review", "update")
def update(sid):
    d = _body()
    return success_response(service.update_plan(sid, _bstore(), _who(), d.get("start_date"), d.get("close_date"),
                                                d.get("remarks")))


@bp.route("/sessions/<int:sid>", methods=["DELETE"])
@permission_required("inventory_review", "delete")
def remove(sid):
    return success_response(service.delete_planned(sid, _store(), _who()), "Planned inventory removed")


@bp.route("/sessions/<int:sid>/start", methods=["POST"])
@permission_required("inventory_review", "update")
def start(sid):
    store = _store(request.form.get("store_code") or request.args.get("store_code") or _body().get("store_code"))
    f = request.files.get("file")
    if f is not None:
        return success_response(service.start_from_excel(sid, store, f.stream, f.filename, _who()),
                                "Started with ERP's stock Excel")
    return success_response(service.start(sid, store, _who()), "Started — ERP stock snapshot taken")


@bp.route("/sessions/<int:sid>/line", methods=["GET"])
@permission_required(READ)
def line(sid):
    return success_response(service.line(sid, _store(), code=request.args.get("code"),
                                         part_id=request.args.get("part_id"), user=_who()))


@bp.route("/sessions/<int:sid>/counts", methods=["POST"])
@permission_required("inventory_count", "create")
def count(sid):
    d = _body()
    return success_response(service.count(sid, _bstore(), d.get("part_id"), d.get("qty"), _who(),
                                          location=d.get("location"), remarks=d.get("remarks"),
                                          source=d.get("source") or "MANUAL"), "Counted", 201)


@bp.route("/counts/<int:cid>", methods=["PATCH"])
@permission_required("inventory_count", "update")
def edit_count(cid):
    d = _body()
    return success_response(service.edit_count(cid, _bstore(), d.get("qty"), _who(), d.get("reason")),
                            "Count corrected")


@bp.route("/sessions/<int:sid>/count-sheet", methods=["POST"])
@permission_required("inventory_count", "create")
def count_sheet(sid):
    f = request.files.get("file")
    if f is None:
        raise BadRequestError("Attach the count sheet (.xlsx)")
    return success_response(service.import_counts(sid, _store(request.form.get("store_code")), f.stream, _who()))


@bp.route("/sessions/<int:sid>/recount", methods=["POST"])
@permission_required("inventory_review", "update")
def recount(sid):
    d = _body()
    return success_response(service.allow_recount(sid, _bstore(), d.get("part_id"), _who(), d.get("reason")),
                            "Recount allowed")


@bp.route("/sessions/<int:sid>/submit", methods=["POST"])
@permission_required("inventory_review", "update")
def submit(sid):
    return success_response(service.submit(sid, _bstore(), _who(), _body().get("remarks")),
                            "Sent for final approval")


@bp.route("/sessions/<int:sid>/approve", methods=["POST"])
@permission_required("inventory_approve", "update")
def approve(sid):
    return success_response(service.approve(sid, _bstore(), _who(), _body().get("remarks")),
                            "Approved and locked")


@bp.route("/sessions/<int:sid>/reject", methods=["POST"])
@permission_required("inventory_approve", "update")
def reject(sid):
    return success_response(service.reject(sid, _bstore(), _who(), _body().get("reason")),
                            "Sent back for counting")


@bp.route("/sessions/<int:sid>/revise", methods=["POST"])
@permission_required("inventory_approve", "update")
def revise(sid):
    d = _body()
    return success_response(service.revise(sid, _bstore(), d.get("part_id"), d.get("qty"), _who(), d.get("reason")),
                            "Revision saved")


@bp.route("/quarter", methods=["GET"])
@permission_required(READ)
def quarter():
    fy, q = request.args.get("fiscal_year"), request.args.get("quarter")
    if not fy or not q:
        raise BadRequestError("fiscal_year and quarter are required")
    return success_response(service.quarter(_store(), fy, q,
                                            verified_only=request.args.get("verified") in ("1", "true")))


@bp.route("/history", methods=["GET"])
@permission_required(READ)
def history():
    return success_response(service.history(_store()))


@bp.route("/board", methods=["GET"])
@permission_required(READ)
def board():
    return success_response(service.board_card(_store()))


@bp.route("/sessions/<int:sid>/export/<fmt>", methods=["GET"])
@permission_required(READ)
def export(sid, fmt):
    from app.utils import pdf_io
    from app.utils.excel_io import build_export
    out = service.detail(sid, _store(), view=request.args.get("view") or "parts",
                         status=request.args.get("status") or None, q=request.args.get("q"))
    s = out["session"]
    name = f"Inventory {s['section']} {s['quarter']} {s['fiscal_year']}"
    if out["session"] and request.args.get("view") == "audit":
        cols = [("When", "at"), ("By", "by"), ("Action", "action"), ("Part No", "part_no"),
                ("Old Qty", "old_qty"), ("New Qty", "new_qty"), ("Remarks", "remarks")]
        name += " Audit"
    elif request.args.get("view") == "category":
        cols = [("Category", "name"), ("Parts", "total_parts"), ("Counted", "counted_parts"),
                ("Matched", "matched_parts"), ("Shortage Parts", "shortage_parts"), ("Excess Parts", "excess_parts"),
                ("ERP Qty", "erp_qty"), ("Physical Qty", "physical_qty"), ("Shortage Qty", "shortage_qty"),
                ("Excess Qty", "excess_qty"), ("Accuracy %", "accuracy_pct")]
        name += " by Category"
    else:
        cols = [("Part No", "part_no"), ("Item Description", "item_description"), ("Section", "section"),
                ("Category", "category"),
                ("Location", "location"), ("UOM", "uom"), ("ERP Qty", "erp_qty"), ("Physical Qty", "physical_qty"),
                ("Difference", "variance_qty"), ("Rate", "rate"), ("Difference Value", "variance_value"),
                ("Status", "status"), ("Counted By", "counted_by"), ("Remarks", "remarks")]
    rows = out["rows"]
    if fmt == "excel":
        return send_file(build_export(cols, rows), as_attachment=True, download_name=f"{name}.xlsx",
                         mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    if fmt == "pdf":
        sm = out["summary"]
        title = (f"{name} — {s['status_label']} · counted {sm['counted_parts']}/{sm['total_parts']} · "
                 f"accuracy {sm['accuracy_pct'] if sm['accuracy_pct'] is not None else '—'}%")
        return send_file(pdf_io.build_pdf_table(title, cols, rows), as_attachment=True,
                         download_name=f"{name}.pdf", mimetype="application/pdf")
    raise NotFoundError(f"Unknown format '{fmt}' — excel or pdf")
