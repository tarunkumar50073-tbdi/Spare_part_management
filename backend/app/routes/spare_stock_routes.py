"""Spare on-hand stock REST API (/api/v1/spare-stock).

Every route is store-scoped on purpose: this is the Spare Parts Store's own
stock, and nothing here should be able to read or write a child part's.
"""
from flask import Blueprint, request, send_file, session

from app.repositories.part_repository import PartRepository
from app.services.auth_service import AuthService
from app.services.spare_flow_service import SpareFlowService
from app.services.spare_receipt_service import ReceivingInErpError
from app.services.spare_stock_service import SpareStockService
from app.schemas.spare_stock_schema import (
    SpareStockSetSchema, SpareIssueSchema,
    SpareConfirmSchema, SpareLocationSchema, SpareReturnSchema,
)
from app.utils.authz import permission_required, require_store_access
from app.utils.event_bus import publish
from app.utils.exceptions import BadRequestError, NotFoundError
from app.utils.response import success_response
from app.utils.validators import validate_payload

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

bp = Blueprint("spare_stock", __name__, url_prefix="/api/v1/spare-stock")
service = SpareStockService()
flow = SpareFlowService()
auth = AuthService()
part_repo = PartRepository()


def _store_code():
    code = request.args.get("store_code") or request.form.get("store_code")
    if not code:
        raise BadRequestError("store_code is required")
    # A store user may only touch stores they're assigned to; machine and admin
    # callers pass (audit finding AUTHZ-1).
    require_store_access(code)
    return code


def _section():
    """Optional section filter (a section of the Spare store) — an int id, or
    None for the whole store. Used by the Live Dashboard's section switcher."""
    return request.args.get("section_id", type=int)


def _date_range():
    """(from, to) as ISO 'YYYY-MM-DD' strings from the query, or (None, None) —
    the Consumption screen's calendar picker. A malformed value is dropped
    rather than 400'd, so a stray date just means no filter on that side."""
    from datetime import date

    def clean(v):
        try:
            return date.fromisoformat(v).isoformat() if v else None
        except (ValueError, TypeError):
            return None
    return clean(request.args.get("from")), clean(request.args.get("to"))


def _require_part_store(part_id):
    """Resolve the part's own store and enforce access on it, so a raw part_id
    can't be used to read or overwrite another store's stock (audit finding
    AUTHZ-1 — the spare-stock IDOR)."""
    part = part_repo.get_by_id(part_id)
    if not part:
        raise NotFoundError(f"Part {part_id} not found")
    require_store_access(part.store_code)
    return part


def _username():
    """Stamped on the ledger row so a correction can be traced to a person.
    None for a machine caller authenticated by API key."""
    user = auth.get_user(session.get("user_id"))
    return user.username if user else None


@bp.route("", methods=["GET"])
def list_stock():
    return success_response(service.list_stock(
        _store_code(), section_id=request.args.get("section_id", type=int),
    ))


@bp.route("/summary", methods=["GET"])
def summary():
    return success_response(service.get_summary(
        _store_code(), section_id=request.args.get("section_id", type=int),
    ))


@bp.route("/analytics", methods=["GET"])
def analytics():
    store = _store_code()
    data = service.analytics(store, section_id=_section())
    # The ERP feed is measured separately: it says how much of the list ERP
    # has reported on, not how the store itself is doing.
    data["erp"] = service.erp_completeness(store)
    return success_response(data)


@bp.route("/erp-gap", methods=["GET"])
def erp_gap():
    return success_response(service.erp_gap(
        _store_code(),
        keyword=request.args.get("keyword"),
        category=request.args.get("category"),
        status=request.args.get("status"),
    ))


@bp.route("/erp-gap/summary", methods=["GET"])
def erp_gap_summary():
    return success_response(service.erp_gap_summary(_store_code()))


@bp.route("/consumption", methods=["GET"])
def consumption():
    store = _store_code()
    section_id = _section()
    # Optional window: a calendar range (from/to) wins, else a rolling last-N-days
    # (the Day/Week/Month/Year presets), else all-time — the breakdowns' default.
    days = request.args.get("days", type=int)
    date_from, date_to = _date_range()
    group_by = request.args.get("group_by", "department")
    if group_by == "department":
        return success_response(service.consumption_by_department(store, section_id, days, date_from, date_to))
    if group_by == "machine":
        return success_response(service.consumption_by_machine(store, section_id, days, date_from, date_to))
    if group_by == "type":
        return success_response(service.consumption_by_type(store, section_id, days, date_from, date_to))
    raise BadRequestError(f"Unsupported group_by: {group_by}")


@bp.route("/consumption/report", methods=["GET"])
def consumption_report():
    return success_response(service.consumption_by_period(
        _store_code(), period=request.args.get("period", "month"), section_id=_section()))


@bp.route("/consumption/export", methods=["GET"])
def consumption_export():
    date_from, date_to = _date_range()
    buf = service.consumption_report_excel(
        _store_code(), days=request.args.get("days", type=int), section_id=_section(),
        date_from=date_from, date_to=date_to)
    return send_file(buf, as_attachment=True,
                     download_name="spare_consumption_report.xlsx", mimetype=XLSX_MIME)


@bp.route("/machines", methods=["GET"])
def machines():
    return success_response(service.machines_used(_store_code()))


@bp.route("/consumption-trend", methods=["GET"])
def consumption_trend():
    date_from, date_to = _date_range()
    return success_response(service.consumption_trend(
        _store_code(), days=request.args.get("days", default=7, type=int),
        section_id=_section(), date_from=date_from, date_to=date_to,
    ))


@bp.route("/consumption-comparison", methods=["GET"])
def consumption_comparison():
    return success_response(service.consumption_comparison(_store_code(), section_id=_section()))


@bp.route("/part-facts", methods=["GET"])
def part_facts():
    return success_response(service.part_facts(_store_code()))


@bp.route("/value-by-supplier", methods=["GET"])
def value_by_supplier():
    return success_response(service.stock_value_by_last_supplier(
        _store_code(), section_id=_section(), top=request.args.get("top", default=10, type=int)))


@bp.route("/top-consumed", methods=["GET"])
def top_consumed():
    date_from, date_to = _date_range()
    return success_response(service.top_consumed(
        _store_code(),
        limit=request.args.get("limit", default=5, type=int),
        days=request.args.get("days", default=30, type=int),
        date_from=date_from, date_to=date_to,
    ))


@bp.route("/returnables", methods=["GET"])
def returnables():
    return success_response(service.outstanding_returnables(_store_code()))


@bp.route("/reorder", methods=["GET"])
def reorder():
    return success_response(service.reorder_list(_store_code()))


@bp.route("/erp-sync/pending", methods=["GET"])
def erp_sync_pending():
    return success_response({
        "pending": service.pending_erp_count(_store_code()),
        **service.erp_write_status(),
    })


@bp.route("/erp-sync/pending/list", methods=["GET"])
def erp_sync_pending_list():
    """The individual movements behind the Pending-ERP count — the drill list."""
    store = _store_code()
    return success_response({
        "pending": service.pending_erp_count(store),
        "rows": service.pending_erp_movements(store, limit=request.args.get("limit", type=int)),
        **service.erp_write_status(),
    })


@bp.route("/erp-sync", methods=["POST"])
@permission_required("store_stock", "edit")
def erp_sync():
    return success_response(service.sync_pending_to_erp(_store_code()))


@bp.route("/issues/<int:ledger_id>/return", methods=["POST"])
@permission_required("scan_part", "edit")
def return_issue(ledger_id):
    """Take an issued part back against its original issue (spec 13). It is
    held for the store inspection — on-hand does not change until the
    inspection passes it as good. Body is optional — the legacy one-click
    return of a returnable tool sends none (whole quantity, no reason); the
    return form sends qty + reason + who returned it. The response carries
    `return`, the return document now waiting for inspection."""
    row = service.ledger_repo.get_by_id(ledger_id)
    if not row or not row.part:
        raise NotFoundError(f"Issue {ledger_id} not found")
    require_store_access(row.part.store_code)
    data = validate_payload(SpareReturnSchema(), request.get_json(force=True, silent=True) or {})
    result = service.return_item(
        ledger_id,
        qty=(float(data["qty"]) if data.get("qty") is not None else None),
        reason=data.get("reason"), note=data.get("note"),
        returned_by=data.get("returned_by"), user=_username(),
        scanned_code=data.get("scanned_code"), scan_source=data.get("scan_source"),
    )
    publish("stock", {"part_id": row.part_id, "ledger_id": ledger_id, "action": "return"})
    return success_response(
        result, f"Returned to store · {result.get('return_no')} — waiting for inspection")


@bp.route("/parts/<int:part_id>/returnable-issues", methods=["GET"])
def returnable_issues(part_id):
    """Issues of this part still out on the floor — the pick-list for a return."""
    _require_part_store(part_id)
    return success_response(service.returnable_issues_for_part(part_id))


@bp.route("/by-status", methods=["GET"])
def by_status():
    status = request.args.get("status")
    if not status:
        raise BadRequestError("status is required")
    return success_response(service.list_by_status(
        _store_code(), status, limit=request.args.get("limit", type=int),
        section_id=request.args.get("section_id", type=int),
    ))


@bp.route("/excess", methods=["GET"])
def excess():
    return success_response(service.list_excess(
        _store_code(), limit=request.args.get("limit", type=int),
        section_id=request.args.get("section_id", type=int),
    ))


@bp.route("/today", methods=["GET"])
def today():
    return success_response(service.today_movements(_store_code(), section_id=_section()))


@bp.route("/today/issues", methods=["GET"])
def today_issues():
    """The ISSUE rows since shift start — the drill behind Today's Issue."""
    return success_response(service.today_issues(_store_code(), section_id=_section()))


@bp.route("/activity", methods=["GET"])
def activity():
    return success_response(service.recent_activity(
        _store_code(), limit=request.args.get("limit", default=20, type=int),
    ))


@bp.route("/flow", methods=["GET"])
def material_flow():
    return success_response(flow.material_flow(_store_code()))


@bp.route("/pending", methods=["GET"])
def pending():
    return success_response(flow.pending_summary(_store_code()))


@bp.route("/pending/list", methods=["GET"])
def pending_list():
    return success_response(flow.list_pending(
        _store_code(), kind=request.args.get("kind", "all"),
        limit=request.args.get("limit", type=int),
    ))


@bp.route("/traceability/<int:part_id>", methods=["GET"])
def traceability(part_id):
    _require_part_store(part_id)
    return success_response(flow.traceability(part_id))


@bp.route("/below-minimum", methods=["GET"])
def below_minimum():
    return success_response(service.list_below_minimum(
        _store_code(), limit=request.args.get("limit", type=int),
        section_id=request.args.get("section_id", type=int),
    ))


@bp.route("/parts/<int:part_id>", methods=["GET"])
def part_stock(part_id):
    _require_part_store(part_id)
    return success_response(service.get_for_part(part_id))


@bp.route("/scan", methods=["GET"])
def scan_lookup():
    return success_response(service.resolve_scan(_store_code(), request.args.get("code")))


@bp.route("/parts/<int:part_id>", methods=["PUT"])
@permission_required("store_stock", "edit")
def set_quantity(part_id):
    _require_part_store(part_id)
    data = validate_payload(SpareStockSetSchema(), request.get_json(force=True) or {})
    row = service.set_quantity(
        part_id, float(data["qty_on_hand"]),
        txn_type=data.get("txn_type", "ADJUSTMENT"),
        reference=data.get("reference"), remarks=data.get("remarks"),
        user=_username(),
    )
    publish("stock", {"part_id": part_id, "action": "count"})
    return success_response(row, "Stock updated")


@bp.route("/parts/<int:part_id>/issue", methods=["POST"])
@permission_required("scan_part", "edit")
def issue_part(part_id):
    """Stage 1 — store issues to a department + person (no machine/line). The
    response is the part's stock row plus `issue`, the ISSUE row just written
    (the id the installation update and a return point at)."""
    _require_part_store(part_id)
    data = validate_payload(SpareIssueSchema(), request.get_json(force=True) or {})
    row = service.issue(
        part_id, float(data["qty"]), data["department"],
        machine=data.get("machine"), returnable=data.get("returnable", False),
        reference=data.get("reference"), remarks=data.get("remarks"), user=_username(),
        issued_to=data.get("issued_to"),
        scanned_code=data.get("scanned_code"), scan_source=data.get("scan_source"),
    )
    who = data.get("issued_to")
    where = data["department"] + (f" · {who}" if who else "")
    publish("stock", {"part_id": part_id, "action": "issue"})
    return success_response(row, f"Issued to {where}")


@bp.route("/issues/<int:ledger_id>/confirm", methods=["POST"])
@permission_required("scan_part", "edit")
def confirm_issue(ledger_id):
    """Stage 2 — the user at the line records line + machine + die + usage.
    Repeatable ("Update Line / Machine") while something of the issue is
    still out; every update is kept in the part history.

    Only the place keys the request actually carries are passed on: a key
    left out keeps the issue's current value, while one sent as null / blank
    clears it (the Update form sends an emptied Die as null)."""
    row = service.ledger_repo.get_by_id(ledger_id)
    if not row or not row.part:
        raise NotFoundError(f"Issue {ledger_id} not found")
    require_store_access(row.part.store_code)
    data = validate_payload(SpareConfirmSchema(), request.get_json(force=True) or {})
    first = row.confirmed_at is None
    place = {k: data[k] for k in ("line_name", "line_no", "machine", "die_no") if k in data}
    result = service.confirm_installation(
        ledger_id, **place,
        actual_qty=(float(data["actual_qty"]) if data.get("actual_qty") is not None else None),
        user=_username(), remarks=data.get("remarks"),
    )
    publish("stock", {"part_id": row.part_id, "ledger_id": ledger_id, "action": "confirm"})
    return success_response(result, "Installation confirmed" if first else "Line / machine updated")


@bp.route("/pending-confirmations", methods=["GET"])
def pending_confirmations():
    return success_response(service.pending_confirmations(
        _store_code(), limit=request.args.get("limit", type=int)))


@bp.route("/parts/<int:part_id>/pending-confirmations", methods=["GET"])
def part_pending_confirmations(part_id):
    _require_part_store(part_id)
    return success_response(service.pending_confirmations_for_part(part_id))


@bp.route("/parts/<int:part_id>/receive", methods=["POST"])
def receive_part(part_id):
    """Receiving, the GRN and the quality clearance are done in ERP and read
    from it (ErpGrnPostingService) — a manual receive answers 410 Gone."""
    raise ReceivingInErpError()


@bp.route("/parts/<int:part_id>/update-location", methods=["POST"])
@permission_required("scan_part", "edit")
def update_location(part_id):
    _require_part_store(part_id)
    data = validate_payload(SpareLocationSchema(), request.get_json(force=True) or {})
    result = service.update_location(
        part_id, data["new_location"], reason=data.get("reason"),
        qty=(float(data["qty"]) if data.get("qty") is not None else None),
        user=_username(),
    )
    publish("stock", {"part_id": part_id, "action": "location"})
    return success_response(result, "Location updated")


@bp.route("/parts/<int:part_id>/overview", methods=["GET"])
def part_overview(part_id):
    """Everything about one spare in one call — the part drawer."""
    from app.services.spare_part_overview_service import SparePartOverviewService
    _require_part_store(part_id)
    return success_response(SparePartOverviewService().overview(part_id))


@bp.route("/parts/<int:part_id>/location-history", methods=["GET"])
def part_location_history(part_id):
    _require_part_store(part_id)
    return success_response(service.location_history_for_part(part_id))


@bp.route("/parts/<int:part_id>/history", methods=["GET"])
def part_history(part_id):
    _require_part_store(part_id)
    return success_response(service.history_for_part(
        part_id, limit=request.args.get("limit", default=25, type=int),
        txn_type=request.args.get("txn_type"),
        department=request.args.get("department"),
        machine=request.args.get("machine"),
    ))


@bp.route("/template", methods=["GET"])
def download_template():
    # When a store is named, enforce access on it — the template is pre-filled
    # with that store's part numbers + quantities (audit finding AUTHZ).
    code = request.args.get("store_code")
    if code:
        require_store_access(code)
    buf = service.build_template(code)
    return send_file(buf, as_attachment=True,
                     download_name="spare_opening_stock_template.xlsx", mimetype=XLSX_MIME)


@bp.route("/export", methods=["GET"])
def export_stock():
    buf = service.export_excel(_store_code(), section_id=request.args.get("section_id", type=int))
    return send_file(buf, as_attachment=True,
                     download_name="spare_stock.xlsx", mimetype=XLSX_MIME)


@bp.route("/import", methods=["POST"])
@permission_required("store_stock", "edit")
def import_stock():
    # store_code is REQUIRED and access-enforced (audit finding AUTHZ): without
    # it the per-row store guard in bulk_import is skipped, letting an upload
    # overwrite another store's on-hand. _store_code() reads the form field too.
    store_code = _store_code()
    file = request.files.get("file")
    if not file or file.filename == "":
        raise BadRequestError("No file uploaded")
    report = service.bulk_import(
        file.stream, store_code=store_code,
        user=_username(), sheet_name=request.form.get("sheet_name") or None,
    )
    if report.get("updated"):
        publish("stock", {"store_code": store_code, "action": "import"})
    return success_response(report, f"{report.get('updated', 0)} part(s) updated", 201)
