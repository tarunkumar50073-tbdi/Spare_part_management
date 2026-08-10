"""Store / Section master API (/api/v1/stores)."""
from flask import Blueprint, request, session

from app.schemas.store_schema import (
    SectionCreateSchema, SectionUpdateSchema, StoreCreateSchema, StoreUpdateSchema,
)
from app.services.auth_service import AuthService
from app.services.store_service import StoreService
from app.utils.response import success_response
from app.utils.validators import validate_payload

bp = Blueprint("stores", __name__, url_prefix="/api/v1/stores")
service = StoreService()
auth = AuthService()


def _current_user():
    """None for a machine caller authenticated by API key — it is not a
    person and has no per-store rights, so it sees every store."""
    return auth.get_user(session.get("user_id"))


@bp.route("", methods=["GET"])
def list_stores():
    with_summary = request.args.get("summary") in ("1", "true")
    return success_response(service.list_stores(user=_current_user(), with_summary=with_summary))


@bp.route("", methods=["POST"])
def create_store():
    data = validate_payload(StoreCreateSchema(), request.get_json(force=True) or {})
    return success_response(service.create_store(data), "Store created", 201)


@bp.route("/<code>", methods=["PUT"])
def update_store(code):
    data = validate_payload(StoreUpdateSchema(), request.get_json(force=True) or {})
    return success_response(service.update_store(code, data), "Store updated")


@bp.route("/<code>/sections", methods=["GET"])
def list_sections(code):
    return success_response(service.list_sections(code))


@bp.route("/<code>/sections", methods=["POST"])
def create_section(code):
    data = validate_payload(SectionCreateSchema(), request.get_json(force=True) or {})
    return success_response(service.create_section(code, data), "Section created", 201)


@bp.route("/sections/<int:section_id>", methods=["PUT"])
def update_section(section_id):
    data = validate_payload(SectionUpdateSchema(), request.get_json(force=True) or {})
    return success_response(service.update_section(section_id, data), "Section updated")
