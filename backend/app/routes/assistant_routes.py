"""In-app assistant API (/api/v1/assistant).

Signed-in users only (the global auth guard covers it). Answers come from this
app's own data + screen catalogue — no external service is called.
"""
from flask import Blueprint, request

from app.services.assistant_service import AssistantService
from app.utils.authz import current_user
from app.utils.response import success_response

bp = Blueprint("assistant", __name__, url_prefix="/api/v1/assistant")
service = AssistantService()


@bp.route("/services", methods=["GET"])
def services():
    return success_response(service.services(user=current_user()))


@bp.route("/ask", methods=["POST"])
def ask():
    # force=True parses any body as JSON, so a non-object body (e.g. [1] or "hi")
    # could slip through — coerce to a dict before reading the query.
    data = request.get_json(force=True, silent=True)
    query = data.get("query") if isinstance(data, dict) else None
    return success_response(service.ask(query, user=current_user()))
