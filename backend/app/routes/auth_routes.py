"""Authentication API (/api/v1/auth) — login, logout, and who-am-I."""
from flask import Blueprint, current_app, request, session

from app.schemas.auth_schema import LoginSchema
from app.services.auth_service import AuthService
from app.utils.rate_limit import over_limit
from app.utils.response import error_response, success_response
from app.utils.validators import validate_payload

bp = Blueprint("auth", __name__, url_prefix="/api/v1/auth")
service = AuthService()

SESSION_USER_KEY = "user_id"


@bp.route("/login", methods=["POST"])
def login():
    # Turn away a device that is hammering the login endpoint before we even
    # look at the credentials, so a password can't be brute-forced.
    if current_app.config.get("RATE_LIMIT_ENABLED", True):
        ip = request.remote_addr or "unknown"
        if over_limit(f"login:{ip}", current_app.config["LOGIN_RATE_MAX"], current_app.config["LOGIN_RATE_WINDOW"]):
            return error_response(
                "Too many login attempts from this device. Please wait a minute and try again.", 429)
    data = validate_payload(LoginSchema(), request.get_json(force=True) or {})
    user = service.authenticate(data["username"], data["password"])
    # Rotate the session on login so a session id captured before sign-in
    # can't be reused afterwards.
    session.clear()
    session[SESSION_USER_KEY] = user.id
    session.permanent = True
    return success_response(user.to_public_dict(), "Signed in")


@bp.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return success_response(None, "Signed out")


@bp.route("/me", methods=["GET"])
def me():
    """Who the cookie belongs to. Returns null rather than 401 so the SPA can
    ask this on boot to decide between the login screen and the dashboard,
    without a failed request in the console every time."""
    user = service.get_user(session.get(SESSION_USER_KEY))
    return success_response(user.to_public_dict() if user else None)
