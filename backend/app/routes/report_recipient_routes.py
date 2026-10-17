"""Report Recipient master API (/api/v1/report-recipients) — who each
auto-mailed report goes to. Reads open to any signed-in caller; writes
ADMIN-only, like every other master — and by a signed-in administrator, not the
machine key, which must not decide who the reports are mailed to."""
from flask import Blueprint, request

from app.schemas.report_recipient_schema import ReportRecipientCreateSchema, ReportRecipientUpdateSchema
from app.services.report_recipient_service import ReportRecipientService
from app.utils.authz import admin_required, signed_in_required
from app.utils.response import success_response
from app.utils.validators import validate_payload

bp = Blueprint("report_recipients", __name__, url_prefix="/api/v1/report-recipients")
service = ReportRecipientService()


@bp.route("", methods=["GET"])
def list_recipients():
    active_only = request.args.get("active") in ("1", "true")
    return success_response(service.list_recipients(
        report_key=request.args.get("report_key"), active_only=active_only))


@bp.route("", methods=["POST"])
@admin_required
@signed_in_required
def create_recipient():
    data = validate_payload(ReportRecipientCreateSchema(), request.get_json(force=True) or {})
    return success_response(service.create_recipient(data), "Recipient added", 201)


@bp.route("/<int:rid>", methods=["PUT"])
@admin_required
@signed_in_required
def update_recipient(rid):
    data = validate_payload(ReportRecipientUpdateSchema(), request.get_json(force=True) or {})
    return success_response(service.update_recipient(rid, data), "Recipient updated")
