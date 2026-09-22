"""Admin API (/api/v1/admin) — user management + per-module rights.

ADMIN-only for people (admin_required); there is no machine caller here. The
returned user records include the readable password on purpose (admin visibility
was an explicit choice) — this endpoint is the only place it leaves the server.
"""
from flask import Blueprint, request

from app.schemas.settings_schema import LabelConfigSchema
from app.services.admin_service import AdminService
from app.services.settings_service import SettingsService
from app.services.store_service import StoreService
from app.utils.authz import admin_required, current_user
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response
from app.utils.validators import validate_payload

bp = Blueprint("admin", __name__, url_prefix="/api/v1/admin")
service = AdminService()
settings = SettingsService()
stores = StoreService()


def _username():
    u = current_user()
    return u.username if u else None


def _is_active(payload):
    val = (payload or {}).get("is_active")
    if not isinstance(val, bool):
        raise BadRequestError("is_active (true/false) is required")
    return val


@bp.route("/modules", methods=["GET"])
@admin_required
def modules():
    return success_response(service.modules())


@bp.route("/users", methods=["GET"])
@admin_required
def list_users():
    return success_response(service.list_users())


@bp.route("/users", methods=["POST"])
@admin_required
def create_user():
    return success_response(service.create_user(request.get_json(force=True) or {}), "User created")


@bp.route("/users/<int:user_id>", methods=["PUT"])
@admin_required
def update_user(user_id):
    return success_response(service.update_user(user_id, request.get_json(force=True) or {}), "User updated")


@bp.route("/users/<int:user_id>/reset-password", methods=["POST"])
@admin_required
def reset_password(user_id):
    data = request.get_json(force=True) or {}
    return success_response(service.reset_password(user_id, data.get("password")), "Password reset")


@bp.route("/users/<int:user_id>", methods=["DELETE"])
@admin_required
def delete_user(user_id):
    acting = current_user()
    return success_response(service.delete_user(user_id, acting.id if acting else None), "User deleted")


# ---- Settings: system status (read-only), barcode label, store/section visibility ----

@bp.route("/system-status", methods=["GET"])
@admin_required
def system_status():
    return success_response(settings.system_status())


@bp.route("/label-config", methods=["GET"])
@admin_required
def get_label_config():
    return success_response(settings.label_config())


@bp.route("/label-config", methods=["PUT"])
@admin_required
def set_label_config():
    data = validate_payload(LabelConfigSchema(), request.get_json(force=True) or {})
    return success_response(settings.set_label_config(data, _username()), "Label settings saved")


@bp.route("/store-visibility", methods=["GET"])
@admin_required
def store_visibility():
    return success_response(settings.store_visibility())


@bp.route("/stores/<code>/active", methods=["PUT"])
@admin_required
def set_store_active(code):
    active = _is_active(request.get_json(force=True) or {})
    result = stores.update_store(code, {"is_active": active})
    return success_response(result, "Store shown" if active else "Store hidden")


@bp.route("/sections/<int:section_id>/active", methods=["PUT"])
@admin_required
def set_section_active(section_id):
    active = _is_active(request.get_json(force=True) or {})
    result = stores.update_section(section_id, {"is_active": active})
    return success_response(result, "Section shown" if active else "Section hidden")
