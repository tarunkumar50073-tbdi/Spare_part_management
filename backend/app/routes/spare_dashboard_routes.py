"""Spare Parts Store dashboard aggregate (/api/v1/dashboard/spare).

One call for the whole above-the-fold dashboard — see SpareDashboardService —
and one for the management block beside it (action tracker, excess aging,
monthly in vs out, scan discipline) — see SpareManagementService.
"""
from flask import Blueprint, request

from app.routes._spare_common import username
from app.services.spare_dashboard_service import SpareDashboardService
from app.services.spare_management_service import SpareManagementService
from app.utils.authz import admin_required, current_user, permission_required, require_store_access
from app.utils.event_bus import publish
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response

bp = Blueprint("spare_dashboard", __name__, url_prefix="/api/v1/dashboard/spare")
service = SpareDashboardService()
management_service = SpareManagementService()


def _id(text):
    """A section id out of the query string, or None for anything that is not
    one. Plain ASCII digits only — "²" is a digit to str.isdigit but not to
    int — and no longer than fits the database's INTEGER."""
    text = (text or "").strip()
    return int(text) if text.isascii() and text.isdigit() and len(text) <= 9 else None


def _section_id():
    """`section_id` as an int, or None: a stray value is dropped, the way
    `section_ids` drops one."""
    return _id(request.args.get("section_id"))


def _section_ids():
    """`section_ids` as a comma list of ints (a section GROUP, e.g. Tool Room =
    Press Tool Room + General Tool Room), or None. Blank / unparseable ids are
    dropped rather than 400'd, so a stray value never breaks the dashboard."""
    ids = [i for i in map(_id, (request.args.get("section_ids") or "").split(",")) if i is not None]
    return ids or None


@bp.route("/overview", methods=["GET"])
# The wallboard reads the same overview, so its own right is enough too.
@permission_required(("spare_store", "live_dashboard"), "view")
def overview():
    code = request.args.get("store_code")
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    return success_response(service.overview(
        code, section_id=_section_id(), section_ids=_section_ids()))


@bp.route("/management", methods=["GET"])
# Read by the store dashboard and the wallboard alike, so gated like the overview.
@permission_required(("spare_store", "live_dashboard", "action_tracker"), "view")
def management():
    code = request.args.get("store_code")
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    return success_response(management_service.management(
        code, section_id=_section_id(), section_ids=_section_ids(),
        user=current_user()))


@bp.route("/management/list", methods=["GET"])
# The Live Board's drill behind a figure — read by the wallboard login too.
@permission_required(("spare_store", "live_dashboard", "action_tracker"), "view")
def management_list():
    """The rows behind one figure of the Live Board (In / Out bar of a month,
    a department's issues this month, the scan-discipline tiles), read by the
    figure's own rule — see SpareManagementService.board_list. Read-only."""
    code = request.args.get("store_code")
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    return success_response(management_service.board_list(
        code, request.args.get("kind"), request.args.get("key"),
        section_id=_section_id(), section_ids=_section_ids()))


@bp.route("/action-tracker/<key>", methods=["PUT"])
@admin_required
def put_action_tracker(key):
    """An administrator's note on one Action Tracker line: owner, target date,
    remarks. The line's count stays live — only the note is saved."""
    data = request.get_json(force=True) or {}
    code = data.get("store_code") if isinstance(data, dict) else None
    if not code or not isinstance(code, str):
        raise BadRequestError("store_code is required")
    require_store_access(code)
    saved = management_service.set_tracker_item(code, key, data, user=username())
    # Open dashboards and the wallboard refetch on a "stock" push.
    publish("stock", {"store_code": code, "action": "action_tracker"})
    return success_response(saved, "Action tracker saved")
