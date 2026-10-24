"""Rejection Mail REST API (/api/v1/rejection-requests).

The one mail the store sends RQC to punch an SRV / line rejection in ERP — a
draft the store sends from Outlook; the app sends nothing itself
(RejectionRequestService). Right: "rejection_request" (view to read, edit to
make a mail); every call is held to the caller's store access.

GET    ""                     the mails made, newest first: store_code, page, page_size, q
GET    /grn-lines             store_code, q: ERP GRN register lines of the store's parts
GET    /parts                 store_code, q: the store's parts (a mail typed in)
GET    /settings              the mail's To / CC / names
PUT    /settings              set them
POST   ""                     keep a mail's details (store_code in the body)
GET    /<id>                  one mail's details
GET    /<id>/mail             the mail to RQC as an unsent .eml (Outlook opens it)
"""
import io

from flask import Blueprint, request, send_file

from app.extensions import db
from app.models.rejection_request import RejectionRequest
from app.services.rejection_request_service import RejectionRequestService
from app.utils.authz import current_user, permission_required, require_store_access
from app.utils.exceptions import BadRequestError, NotFoundError
from app.utils.response import success_response

bp = Blueprint("rejection_request", __name__, url_prefix="/api/v1/rejection-requests")
service = RejectionRequestService()
RIGHT = "rejection_request"


def _store_code(value=None):
    code = (value if value is not None else request.args.get("store_code") or "").strip()
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    return code


def _body():
    data = request.get_json(silent=True)
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise BadRequestError("The request body must be a JSON object")
    return data


def _row(pk):
    row = db.session.get(RejectionRequest, pk)
    if row is None:
        raise NotFoundError(f"Rejection mail {pk} not found")
    require_store_access(row.store_code)
    return row


@bp.route("", methods=["GET"])
@permission_required(RIGHT, "view")
def list_mails():
    return success_response(service.list(_store_code(), {"q": request.args.get("q")},
                                         page=request.args.get("page", 1, type=int),
                                         page_size=request.args.get("page_size", 25, type=int)))


@bp.route("/grn-lines", methods=["GET"])
@permission_required(RIGHT, "view")
def grn_lines():
    return success_response(service.grn_lines(_store_code(), request.args.get("q")))


@bp.route("/parts", methods=["GET"])
@permission_required(RIGHT, "view")
def parts():
    return success_response(service.search_parts(_store_code(), request.args.get("q")))


@bp.route("/settings", methods=["GET"])
@permission_required(RIGHT, "view")
def get_settings():
    return success_response(service.settings())


@bp.route("/settings", methods=["PUT"])
@permission_required(RIGHT, "edit")
def put_settings():
    return success_response(service.set_settings(_body(), user=current_user()), message="Mail settings saved")


@bp.route("", methods=["POST"])
@permission_required(RIGHT, "edit")
def create():
    data = _body()
    out = service.create(_store_code(data.get("store_code") or ""), data, user=current_user())
    return success_response(out, message="Already made" if out.get("replayed") else "Rejection mail ready",
                            status_code=200 if out.get("replayed") else 201)


@bp.route("/<int:pk>", methods=["GET"])
@permission_required(RIGHT, "view")
def detail(pk):
    return success_response(service.detail(_row(pk).id))


@bp.route("/<int:pk>/mail", methods=["GET"])
@permission_required(RIGHT, "edit")
def mail(pk):
    data, name = service.mail_draft(_row(pk).id, user=current_user())
    return send_file(io.BytesIO(data), as_attachment=True, download_name=name, mimetype="message/rfc822")
