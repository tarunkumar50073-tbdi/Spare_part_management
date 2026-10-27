"""ERP Control Center REST API (/api/v1/erp-control).

One read-only call — see ERPControlService. Store-scoped like every other
spare read; gated on the ERP-gap module right, whose screen this sits beside.
"""
from flask import Blueprint, request

from app.services.erp_control_service import ERPControlService
from app.utils.authz import permission_required, require_store_access
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response

bp = Blueprint("erp_control", __name__, url_prefix="/api/v1/erp-control")
service = ERPControlService()


@bp.route("/status", methods=["GET"])
@permission_required("erp_control", "view")
def status():
    code = request.args.get("store_code")
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    return success_response(service.status(code))


@bp.route("/sync-now", methods=["POST"])
@permission_required("erp_control", "update")
def sync_now():
    """Read every ERP table now (the store, 27 Oct 2026: "turant upload hona
    chahiye"). Read only on ERP. A read already running elsewhere is not
    started twice."""
    from app.services.erp_db_client import ERPDBNotConfigured
    from app.services.erp_sync_service import ERPSyncService
    from app.utils.response import success_response as ok
    try:
        result = ERPSyncService().sync_all()
    except ERPDBNotConfigured:
        return ok({"configured": False}, "ERP is not set up on this machine (ERP_DB_*)")
    if "skipped" in result:
        return ok({"configured": True, "result": result}, result["skipped"] + " — try again in a minute")
    failed = [k for k, v in result.items() if v is None]
    return ok({"configured": True, "result": result},
              "ERP read now" + (f" — failed: {', '.join(failed)}" if failed else " — every table up to date"))

