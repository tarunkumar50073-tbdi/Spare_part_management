"""Authentication API (/api/v1/auth) — login, logout, and who-am-I."""
from flask import Blueprint, current_app, request, session

from app.schemas.auth_schema import LoginSchema
from app.services.auth_service import AuthService
from app.utils import captcha
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
    cfg = current_app.config
    # The Security Check comes first, so a wrong code costs no try of the
    # account; the code is used up either way (the screen draws a new one).
    if cfg.get("LOGIN_CAPTCHA_ENABLED", True) and not captcha.check(
            session, cfg["SECRET_KEY"], data.get("captcha"), cfg["LOGIN_CAPTCHA_TTL"]):
        return error_response("Security code is wrong — type the 2 letters + 2 numbers shown.", 400)
    lock = ((cfg["LOGIN_LOCK_ATTEMPTS"], cfg["LOGIN_LOCK_MINUTES"])
            if cfg.get("LOGIN_LOCK_ENABLED", True) else None)
    user = service.authenticate(data["username"], data["password"], lock=lock)
    # Rotate the session on login so a session id captured before sign-in
    # can't be reused afterwards.
    session.clear()
    session[SESSION_USER_KEY] = user.id
    session.permanent = True
    return success_response(user.to_public_dict(), "Signed in")


@bp.route("/captcha", methods=["GET"])
def new_captcha():
    """A new Security Check code for this browser, as a picture (SVG). Only an
    HMAC of it is kept, in the session; see utils/captcha. With the check
    switched off (LOGIN_CAPTCHA_ENABLED, off since 24 Oct 2026) it answers
    {"enabled": false} and the sign-in screen shows no code."""
    if not current_app.config.get("LOGIN_CAPTCHA_ENABLED", True):
        resp, status = success_response({"enabled": False})
        resp.headers["Cache-Control"] = "no-store"
        return resp, status
    svg = captcha.issue(session, current_app.config["SECRET_KEY"])
    resp, status = success_response({"enabled": True, "svg": svg, "ttl": current_app.config["LOGIN_CAPTCHA_TTL"]})
    resp.headers["Cache-Control"] = "no-store"
    return resp, status


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
