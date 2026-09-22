"""Admin API (/api/v1/admin) — user management + per-module rights.

ADMIN-only for people (admin_required); there is no machine caller here. The
returned user records include the readable password on purpose (admin visibility
was an explicit choice) — this endpoint is the only place it leaves the server.
"""
from flask import Blueprint, request

from app.services.admin_service import AdminService
from app.utils.authz import admin_required, current_user
from app.utils.response import success_response

bp = Blueprint("admin", __name__, url_prefix="/api/v1/admin")
service = AdminService()


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
