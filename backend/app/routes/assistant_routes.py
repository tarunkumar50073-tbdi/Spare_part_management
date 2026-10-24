"""In-app assistant API (/api/v1/assistant).

Signed-in users only (the global auth guard covers it). Answers come from this
app's own data + screen catalogue — no external service is called.
"""
from flask import Blueprint, request

from app.services.assistant_service import AssistantService
from app.utils.authz import current_user
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response

bp = Blueprint("assistant", __name__, url_prefix="/api/v1/assistant")
service = AssistantService()

# The ask box takes 300 characters (AssistantWidget MAX_LEN); the server keeps
# the same limit. One very long question (100 KB of digits) took the reader's
# patterns and spelling fixes quadratic time and held the whole backend, for
# every user, with one request (security audit, 24 Oct 2026).
QUERY_MAX = 300


@bp.route("/services", methods=["GET"])
def services():
    return success_response(service.services(user=current_user()))


@bp.route("/ask", methods=["POST"])
def ask():
    # force=True parses any body as JSON, so a non-object body (e.g. [1] or "hi")
    # could slip through — coerce to a dict before reading the query.
    data = request.get_json(force=True, silent=True)
    query = data.get("query") if isinstance(data, dict) else None
    if isinstance(query, str) and len(query) > QUERY_MAX:
        raise BadRequestError(f"Ask in fewer words — at most {QUERY_MAX} characters")
    return success_response(service.ask(query, user=current_user()))
