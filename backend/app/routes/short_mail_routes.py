"""Short Mail REST API (/api/v1/short-mail).

The mail the store sends Purchase when material came short against an invoice —
a draft the store sends from Outlook; the app sends nothing itself and keeps
only the To / CC (ShortMailService). Right: "short_mail", separate from the
Rejection Mail's (view to read, create to make a mail, update for the To / CC).

GET    /settings              the mail's To / CC
PUT    /settings              set them
GET    /parts                 store_code, q: the store's parts (a mail typed in)
POST   /draft                 the mail as an unsent .eml (Outlook opens it)
"""
import io

from flask import Blueprint, request, send_file

from app.services.rejection_request_service import RejectionRequestService
from app.services.short_mail_service import ShortMailService
from app.utils.authz import current_user, permission_required, require_store_access
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response

bp = Blueprint("short_mail", __name__, url_prefix="/api/v1/short-mail")
service = ShortMailService()
RIGHT = "short_mail"


def _body():
    data = request.get_json(silent=True)
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise BadRequestError("The request body must be a JSON object")
    return data


@bp.route("/settings", methods=["GET"])
@permission_required(RIGHT, "view")
def get_settings():
    return success_response(service.settings())


@bp.route("/settings", methods=["PUT"])
@permission_required(RIGHT, "update")
def put_settings():
    return success_response(service.set_settings(_body(), user=current_user()), message="Short mail settings saved")


@bp.route("/parts", methods=["GET"])
@permission_required(RIGHT, "view")
def parts():
    code = (request.args.get("store_code") or "").strip()
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    return success_response(RejectionRequestService().search_parts(code, request.args.get("q")))


@bp.route("/draft", methods=["POST"])
@permission_required(RIGHT, "create")
def draft():
    data, name = service.draft(_body(), user=current_user())
    return send_file(io.BytesIO(data), as_attachment=True, download_name=name, mimetype="message/rfc822")
