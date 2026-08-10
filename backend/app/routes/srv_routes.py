"""Store process-flow REST API (/api/v1/store). The whole receiving
pipeline — gate entry, unload, verification, SRV creation — is ERP-inbound:
every route below up to create-srv is called BY ERP, not by a button in
this app's UI (see Part Store pages: Gate Entry and SRV Workflow are
monitoring-only for these stages). RQC forward/routing/inspection, rack
allocation, store transfer, and production consumption remain this app's
own workflow / other departments' own inbound calls, unchanged."""
from flask import Blueprint, request
from app.services.srv_service import SRVService
from app.schemas.srv_schema import (
    GateEntrySchema, GateOutSchema, VerifySchema, RouteSchema, InspectSchema,
    CreateSrvSchema, PutAwayConfirmSchema,
)
from app.utils.validators import validate_payload
from app.utils.pagination import get_pagination_params, paginate_query
from app.utils.response import success_response, paginated_response
from app.utils.authz import machine_required

bp = Blueprint("store_srvs", __name__, url_prefix="/api/v1/store")
service = SRVService()


@bp.route("/gate-entry", methods=["POST"])
@machine_required
def gate_entry():
    """Inbound gate-entry API (Steps 1-2: Supplier Vehicle Arrives / ERP
    Gate Entry). Called directly by ERP/the gate system — no manual
    creation screen anywhere in this app."""
    data = validate_payload(GateEntrySchema(), request.get_json(force=True) or {})
    srvs = service.ingest_gate_entry(data)
    return success_response([s.to_dict() for s in srvs], "Gate entry received", 201)


@bp.route("/gate-out", methods=["POST"])
@machine_required
def gate_out():
    """Inbound gate-out API — the vehicle has left. Counterpart to
    /gate-entry and called the same way, by ERP/the gate system: it stamps
    every SRV line that came in on that vehicle, giving the store an honest
    in-time/out-time pair per truck."""
    from datetime import date
    data = validate_payload(GateOutSchema(), request.get_json(force=True) or {})
    srvs = service.gate_out(
        data.get("gate_out_time").date() if data.get("gate_out_time") else date.today(),
        vendor_code=data.get("vendor_code"),
        gate_entry_no=data.get("gate_entry_no"),
        vehicle_no=data.get("vehicle_no"),
        gate_out_time=data.get("gate_out_time"),
    )
    return success_response([s.to_dict() for s in srvs], "Gate out recorded")


@bp.route("/srvs", methods=["GET"])
def list_srvs():
    is_short = request.args.get("is_short")
    is_short = {"true": True, "false": False}.get((is_short or "").lower())
    filters = {
        "status": request.args.get("status"),
        "vendor_code": request.args.get("vendor_code"),
        "part_id": request.args.get("part_id", type=int),
        "is_short": is_short,
        "keyword": request.args.get("keyword"),
    }
    query = service.list_srvs(**filters)
    page, per_page = get_pagination_params()
    items, pagination = paginate_query(query, page, per_page)
    return paginated_response([s.to_dict() for s in items], pagination)


@bp.route("/srvs/<int:srv_id>", methods=["GET"])
def get_srv(srv_id):
    srv = service.get(srv_id)
    return success_response(srv.to_dict())


@bp.route("/srvs/<int:srv_id>/unload", methods=["POST"])
@machine_required
def unload(srv_id):
    """Inbound API — ERP reports the truck has been unloaded."""
    srv = service.unload(srv_id)
    return success_response(srv.to_dict(), "Material unloaded")


@bp.route("/srvs/<int:srv_id>/verify", methods=["POST"])
@machine_required
def verify(srv_id):
    """Inbound API — ERP owns barcode/invoice verification and pushes the
    final verified quantity; no scanning happens in this app."""
    data = validate_payload(VerifySchema(), request.get_json(force=True) or {})
    srv = service.verify(srv_id, data["qty_received"], remarks=data.get("remarks"))
    return success_response(srv.to_dict(), "Material verified")


@bp.route("/srvs/<int:srv_id>/create-srv", methods=["POST"])
@machine_required
def create_srv(srv_id):
    """Inbound API — ERP has finished its own SRV decision (including the
    short-material branch) and pushes the finished record, srv_no included."""
    data = validate_payload(CreateSrvSchema(), request.get_json(force=True) or {})
    srv = service.create_srv(srv_id, data["srv_no"], short_note_no=data.get("short_note_no"))
    message = f"SRV {srv.srv_no} created — short note {srv.short_note_no} raised in ERP" if srv.is_short else f"SRV {srv.srv_no} created"
    return success_response(srv.to_dict(), message)


@bp.route("/srvs/<int:srv_id>/forward-rqc", methods=["POST"])
@machine_required
def forward_rqc(srv_id):
    srv = service.forward_to_rqc(srv_id)
    return success_response(srv.to_dict(), "Forwarded to RQC")


@bp.route("/srvs/<int:srv_id>/route", methods=["POST"])
@machine_required
def route(srv_id):
    data = validate_payload(RouteSchema(), request.get_json(force=True) or {})
    srv = service.route(srv_id, routing=data.get("routing"))
    return success_response(srv.to_dict(), f"Routed to {srv.routing}")


@bp.route("/srvs/<int:srv_id>/inspect", methods=["POST"])
@machine_required
def inspect(srv_id):
    """Inbound API — RQC's own ERP calls this to record clearance/rejection
    once they've inspected the part. Not a manual action in this app."""
    data = validate_payload(InspectSchema(), request.get_json(force=True) or {})
    srv = service.inspect(srv_id, data["result"], rejection_reason=data.get("rejection_reason"))
    return success_response(srv.to_dict(), f"Inspection result recorded: {srv.inspection_result}")


@bp.route("/srvs/<int:srv_id>/tool-room-clearance", methods=["POST"])
@machine_required
def tool_room_clearance(srv_id):
    """Inbound API — Maintenance/Tool Room's own ERP calls this once they
    clear the part; stock then arrives into main store."""
    srv = service.clear_tool_room(srv_id)
    return success_response(srv.to_dict(), "Tool room clearance received — stock added to main store")


@bp.route("/srvs/<int:srv_id>/transfer", methods=["POST"])
@machine_required
def transfer(srv_id):
    srv = service.transfer(srv_id)
    return success_response(srv.to_dict(), "Transferred to Part Store")


@bp.route("/srvs/<int:srv_id>/consume", methods=["POST"])
@machine_required
def consume(srv_id):
    """Inbound API — Production's own ERP Production Punch calls this once
    the part is actually consumed. There is no manual Production Issue step
    in this app; this single call is the point Part Store stock is deducted."""
    srv = service.confirm_consumption(srv_id)
    return success_response(srv.to_dict(), "ERP consumption confirmed")


@bp.route("/put-away/pending", methods=["GET"])
def put_away_pending():
    return success_response([s.to_dict() for s in service.list_pending_put_away()])


@bp.route("/srvs/<int:srv_id>/put-away/confirm", methods=["POST"])
def put_away_confirm(srv_id):
    """Put Away — scan rack, scan part, confirm. The server (not just the
    UI) validates the scanned part matches this SRV's own part before
    updating the rack location."""
    data = validate_payload(PutAwayConfirmSchema(), request.get_json(force=True) or {})
    srv = service.put_away_confirm(srv_id, data["rack_bin_id"], data["scanned_part_code"])
    return success_response(srv.to_dict(), "Put away confirmed — rack location updated")
