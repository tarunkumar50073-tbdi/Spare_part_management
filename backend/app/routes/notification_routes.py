"""Notification REST API (/api/v1/notifications)."""
from flask import Blueprint, request
from app.services.notification_service import NotificationService
from app.utils.response import success_response
from app.utils.authz import permission_required

bp = Blueprint("notifications", __name__, url_prefix="/api/v1/notifications")
service = NotificationService()


@bp.route("", methods=["GET"])
def list_notifications():
    return success_response([n.to_dict() for n in service.list_active(request.args.get("type"))])


@bp.route("/<int:notification_id>/resolve", methods=["POST"])
@permission_required("child_store", "update")
def resolve(notification_id):
    n = service.resolve(notification_id)
    return success_response(n.to_dict(), "Notification resolved")
