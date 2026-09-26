"""Helpers shared by the spare-flow blueprints (receipts, returns, RGP, scan).

Same rules as spare_stock_routes: every id is resolved to its part's own store
and store access is enforced on it (audit finding AUTHZ-1), and the acting
username is stamped on every write.
"""
from flask import request, session

from app.repositories.part_repository import PartRepository
from app.services.auth_service import AuthService
from app.utils.authz import require_store_access
from app.utils.exceptions import BadRequestError, NotFoundError

_auth = AuthService()
_parts = PartRepository()


def username():
    """None for a machine caller authenticated by API key."""
    user = _auth.get_user(session.get("user_id"))
    return user.username if user else None


def require_part_store(part_id):
    part = _parts.get_by_id(part_id)
    if not part:
        raise NotFoundError(f"Part {part_id} not found")
    require_store_access(part.store_code)
    return part


def require_doc_store(doc, label="Record"):
    """A receipt / return / RGP row: 404 if missing, then store access on it."""
    if doc is None:
        raise NotFoundError(f"{label} not found")
    require_store_access(doc.store_code)
    return doc


def store_code_arg():
    code = request.args.get("store_code")
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    return code
