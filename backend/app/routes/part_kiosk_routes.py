"""Part Search kiosk REST API (/api/v1/part-kiosk) — read only.

The kiosk outside the spare store: search a part, see its photo, stock, place
and section (PartKioskService). Right: "part_kiosk" (view only — the screen has
nothing to change); the photos themselves come from GET /parts/<id>/image.

GET    /parts                 store_code, q, page, per_page

The kiosk LINK (17 Nov 2026: "nhi bina id parsword bna"): the same search with
no login, behind a long random key in the address — /k/<key> on the screen,
/api/v1/kiosk-link/<key>/... here. The admin turns it on, copies it, or makes a
new one (the old address stops at once). Read only, no rates, Spare store.

GET    /api/v1/kiosk-link/<key>/parts          q, page, per_page   (no login)
GET    /api/v1/kiosk-link/<key>/image/<id>     n, size, v          (no login)
GET    /api/v1/part-kiosk/link                 admin: {enabled, key}
POST   /api/v1/part-kiosk/link                 admin: {enabled} and/or {new: true}
"""
import hmac
import secrets

from flask import Blueprint, request, send_file

from app.services.part_kiosk_service import PartKioskService
from app.models.app_setting import AppSetting
from app.utils.authz import admin_required, current_user, permission_required, require_store_access
from app.utils.exceptions import BadRequestError, NotFoundError
from app.utils.response import success_response

bp = Blueprint("part_kiosk", __name__, url_prefix="/api/v1/part-kiosk")
link_bp = Blueprint("kiosk_link", __name__, url_prefix="/api/v1/kiosk-link")
service = PartKioskService()
LINK_SETTING = "kiosk_link"
LINK_STORE = "MAINTENANCE"


def _link():
    v = AppSetting.get_value(LINK_SETTING, None)
    return v if isinstance(v, dict) else {}


def _check_key(key):
    """The link's key, constant-time; a wrong / old key or a link turned off
    answers 404, as if the address did not exist."""
    cfg = _link()
    if not cfg.get("enabled") or not cfg.get("key") or not hmac.compare_digest(str(key), str(cfg["key"])):
        raise NotFoundError("This kiosk link is not valid")


@link_bp.route("/<key>/parts", methods=["GET"])
def link_parts(key):
    _check_key(key)
    return success_response(service.search(LINK_STORE, request.args.get("q"),
                                           page=request.args.get("page", 1, type=int),
                                           per_page=min(request.args.get("per_page", 24, type=int), 48)))


@link_bp.route("/<key>/image/<int:part_id>", methods=["GET"])
def link_image(key, part_id):
    _check_key(key)
    from app.models.part import Part
    from app.extensions import db
    from app.services.part_image_service import PartImageService
    part = db.session.get(Part, part_id)
    if part is None or part.store_code != LINK_STORE:
        raise NotFoundError("No photo")
    path = PartImageService().path(part_id, thumb=request.args.get("size") == "thumb",
                                   n=request.args.get("n", default=0, type=int))
    return send_file(path, mimetype="image/jpeg", max_age=30 * 24 * 3600)


@bp.route("/link", methods=["GET"])
@admin_required
def link_get():
    cfg = _link()
    return success_response({"enabled": bool(cfg.get("enabled")), "key": cfg.get("key")})


@bp.route("/link", methods=["POST"])
@admin_required
def link_set():
    data = request.get_json(silent=True) or {}
    cfg = _link()
    if data.get("new") or not cfg.get("key"):
        cfg["key"] = secrets.token_urlsafe(24)
    if "enabled" in data:
        cfg["enabled"] = bool(data["enabled"])
    AppSetting.set_value(LINK_SETTING, cfg, user=getattr(current_user(), "username", None))
    return success_response({"enabled": bool(cfg.get("enabled")), "key": cfg["key"]}, "Kiosk link saved")


@bp.route("/parts", methods=["GET"])
@permission_required("part_kiosk", "view")
def parts():
    code = (request.args.get("store_code") or "").strip()
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    return success_response(service.search(code, request.args.get("q"),
                                           page=request.args.get("page", 1, type=int),
                                           per_page=request.args.get("per_page", 24, type=int)))
