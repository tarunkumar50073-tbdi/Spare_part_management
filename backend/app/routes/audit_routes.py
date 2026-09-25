"""Audit Trail REST API (/api/v1/audit-logs) — read-only."""
from flask import Blueprint, request
from app.services.audit_log_service import AuditLogService
from app.utils.pagination import get_pagination_params, paginate_query
from app.utils.response import paginated_response
from app.utils.authz import permission_required

bp = Blueprint("audit_logs", __name__, url_prefix="/api/v1/audit-logs")
service = AuditLogService()


@bp.route("", methods=["GET"])
@permission_required("audit_trail", "view")
def list_audit_logs():
    query = service.list_all(
        entity_type=request.args.get("entity_type"),
        action=request.args.get("action"),
        entity_id=request.args.get("entity_id", type=int),
        q=request.args.get("q"),
        date_from=request.args.get("date_from"),
        date_to=request.args.get("date_to"),
    )
    page, per_page = get_pagination_params()
    items, pagination = paginate_query(query, page, per_page)
    return paginated_response([r.to_dict() for r in items], pagination)
