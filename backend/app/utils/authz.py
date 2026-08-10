"""Route-level authorization helpers.

Authentication (are you signed in / do you hold the shared key) is enforced
globally in the app factory's before_request guard, which also resolves the
caller onto ``g``:

    g.current_user  -> the signed-in User, or None
    g.is_machine    -> True when the caller authenticated with the ERP X-API-Key

These helpers turn that identity into per-route authorization. Two callers
matter: a person in the browser (a User with a role and a set of stores) and
the ERP push (a trusted machine with the shared key and no user). The machine
is trusted end-to-end, so every check below lets it through; the rules bite
only signed-in people (audit finding AUTHZ-1).
"""
from functools import wraps

from flask import g

from app.utils.exceptions import ForbiddenError


def current_user():
    return getattr(g, "current_user", None)


def is_machine():
    return getattr(g, "is_machine", False)


def admin_required(fn):
    """Master-data mutations (stores, parts, suppliers, BOM, racks, milkrun,
    supplier vehicles/windows) are ADMIN-only for people; the ERP machine
    caller still passes."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if is_machine():
            return fn(*args, **kwargs)
        user = current_user()
        if user is None or not user.is_admin:
            raise ForbiddenError("Administrator access is required for this action")
        return fn(*args, **kwargs)
    return wrapper


def machine_required(fn):
    """ERP-inbound endpoints (the receiving pipeline, ERP stock sync, the
    production punch). Only the trusted machine caller may drive these — a
    signed-in person is rejected, because these transitions are ERP's to make,
    not a button in this app."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if is_machine():
            return fn(*args, **kwargs)
        raise ForbiddenError("This endpoint is driven by ERP, not the app UI")
    return wrapper


def require_store_access(store_code):
    """Raise 403 unless the caller may act on this store. The machine caller and
    admins pass; a store user must have the store in their access list. Call
    this from a handler once the target store_code is known (from the query,
    body, or the resolved row)."""
    if is_machine():
        return
    user = current_user()
    if user is None or not user.can_access_store(store_code):
        raise ForbiddenError(f"You do not have access to store '{store_code}'")
