"""Scan result, part timeline and work queues REST API - spec 10 / 21 / 22 / 27.

Prefix /api/v1/spare-flow. Reads only, so — like every other spare read — they
need a signed-in caller and access to the store: a part id is resolved to its
own store before anything is read (audit finding AUTHZ-1), and a queue is only
listed for a store the caller may see.
"""
from flask import Blueprint, request

from app.routes._spare_common import require_part_store, store_code_arg
from app.services.scan_result_service import ScanResultService
from app.utils.response import success_response
from app.utils.authz import SPARE_INSTALL_VIEW, SPARE_STOCK_VIEW, permission_required

bp = Blueprint("spare_scan", __name__, url_prefix="/api/v1/spare-flow")
service = ScanResultService()

# A part's whole history is a few hundred rows; the ceiling only stops a stray
# ?limit= from asking for an unbounded page.
TIMELINE_LIMIT_MAX = 2000


@bp.route("/parts/<int:part_id>/scan-result", methods=["GET"])
# The line user\'s Confirm Installation shows the part it confirms.
@permission_required(SPARE_INSTALL_VIEW, "view")
def scan_result(part_id):
    """Everything the Scan Part workstation renders for one part (spec 22)."""
    require_part_store(part_id)
    return success_response(service.build(part_id))


@bp.route("/parts/<int:part_id>/timeline", methods=["GET"])
@permission_required(SPARE_STOCK_VIEW, "view")
def part_timeline(part_id):
    """The part's full history, newest first (spec 21 — Scan QR -> View History)."""
    require_part_store(part_id)
    limit = request.args.get("limit", default=200, type=int) or 200
    limit = max(1, min(limit, TIMELINE_LIMIT_MAX))
    return success_response(service.timeline(part_id, limit=limit))


@bp.route("/queues", methods=["GET"])
@permission_required(SPARE_STOCK_VIEW, "view")
def queues():
    """The store's open work: receipts, returns, RGPs and unconfirmed issues."""
    return success_response(service.queues(store_code_arg()))
