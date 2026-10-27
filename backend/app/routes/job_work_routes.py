"""Job work returns and ERP's RGPs (/api/v1/job-work) — JobWorkService.

The return itself is made where every return is (POST /spare-stock/issues/<id>/return,
return_type JOB_WORK_RETURN). Here: the Pending RGP list, ERP's RGP lines (read
only), and the link a store person saves between the two. Rights are Scan
Part's, as for returns: view to read, update to link / unlink.

GET  /returns                  store_code, state (PENDING_RGP | RGP_AVAILABLE | RGP_LINKED | SYNC_FAILED), q
GET  /returns/<id>/candidates  q — the suggested RGP lines, and any found by q
POST /returns/<id>/link        rgp_line_id
POST /returns/<id>/unlink
GET  /rgp                      q — ERP's RGP lines as last read
GET  /rgp/status               the last read: when, how many, any failure
(ERP's RGPs are read with the automatic ERP read, every 2 minutes — no button.)
"""
from flask import Blueprint, request

from app.extensions import db
from app.models.spare_flow import SpareReturn
from app.routes._spare_common import username
from app.services.job_work_service import JobWorkService
from app.utils.authz import permission_required, require_store_access
from app.utils.exceptions import BadRequestError, NotFoundError
from app.utils.response import success_response

bp = Blueprint("job_work", __name__, url_prefix="/api/v1/job-work")
service = JobWorkService()
RIGHT = "scan_part"


def _store():
    code = (request.args.get("store_code") or "").strip()
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    return code


def _return(return_id):
    r = db.session.get(SpareReturn, return_id)
    if r is None:
        raise NotFoundError(f"Return {return_id} not found")
    require_store_access(r.store_code)
    return r


@bp.route("/returns", methods=["GET"])
@permission_required(RIGHT, "view")
def returns():
    return success_response(service.returns(_store(), state=request.args.get("state") or None,
                                            q=request.args.get("q")))


@bp.route("/returns/<int:return_id>/candidates", methods=["GET"])
@permission_required(RIGHT, "view")
def candidates(return_id):
    _return(return_id)
    return success_response(service.candidates(return_id, q=request.args.get("q")))


@bp.route("/returns/<int:return_id>/link", methods=["POST"])
@permission_required(RIGHT, "update")
def link(return_id):
    _return(return_id)
    data = request.get_json(silent=True) or {}
    line_id = data.get("rgp_line_id")
    if not isinstance(line_id, int):
        raise BadRequestError("Pick the RGP line")
    out = service.link(return_id, line_id, user=username())
    rgp = out["link"]["rgp"]
    return success_response(out, f"{out['return_no']} linked to RGP {rgp['challan_no']}")


@bp.route("/returns/<int:return_id>/unlink", methods=["POST"])
@permission_required(RIGHT, "update")
def unlink(return_id):
    _return(return_id)
    out = service.unlink(return_id, user=username())
    return success_response(out, f"{out['return_no']} is no longer linked to an RGP")


@bp.route("/rgp", methods=["GET"])
@permission_required(RIGHT, "view")
def rgp_lines():
    return success_response(service.lines(q=request.args.get("q")))


@bp.route("/rgp/status", methods=["GET"])
@permission_required(RIGHT, "view")
def rgp_status():
    return success_response(service.status())
