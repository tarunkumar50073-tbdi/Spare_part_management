"""Route-level authorization helpers.

Authentication (are you signed in / do you hold the shared key) is enforced
globally in the app factory's before_request guard, which also resolves the
caller onto ``g``:

    g.current_user  -> the signed-in User, or None
    g.is_machine    -> True when the caller authenticated with the ERP X-API-Key

These helpers turn that identity into per-route authorization. Two callers
matter: a person in the browser (a User with a role and a set of stores) and
the ERP push (a trusted machine with the shared key and no user). The machine
is trusted for the data it pushes, so the role, rights and store checks below
let it through and bite only signed-in people (audit finding AUTHZ-1). The
exception is the two signed_in_* guards: they mark the routes the shared key
must not drive at all — the mail settings, who the mails go to, and sending one.
"""
from functools import wraps

from flask import g

from app.utils.exceptions import BadRequestError, ForbiddenError

# Every Spare Store screen that shows stock, rates or movements. A read of the
# spare stock needs a right on at least one of them, besides access to the
# store: before 24 Oct 2026 store access alone was enough, so a login with
# only the line user's Confirm Installation (or none at all) could download the
# whole stock list with its rupee values (security audit, 24 Oct 2026).
SPARE_STOCK_VIEW = (
    "spare_store", "live_dashboard", "action_tracker", "notifications", "store_stock",
    "inventory_control", "put_away_check", "scan_part", "work_queue", "consumption",
    "receiving", "short_rejection", "part_ledger", "erp_gap", "erp_control", "part_master",
    "data_quality", "supplier_barcodes", "reports", "challan_register",
)
# The line user's Confirm Installation screen reads its own lists only.
SPARE_INSTALL_VIEW = SPARE_STOCK_VIEW + ("install_confirm",)


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


def permission_required(module, action="view"):
    """Per-module gate for the app's own screens. A signed-in person must hold
    the given right (``view`` to read, ``edit`` to mutate) on ``module``; an
    admin holds everything, and the trusted ERP machine caller passes so its
    sync jobs are never blocked by a person's rights. This is the real boundary
    behind the SPA's nav/route hiding — the address bar and a raw API call must
    be refused too, not just the menu.

    Usage: ``@permission_required("part_master", "edit")`` on a mutation route,
    ``@permission_required("part_ledger")`` on a read route. A tuple of modules
    means "any one of them" — for a read two screens share (the dashboard
    overview feeds both the store dashboard and the wallboard).
    """
    modules = tuple(module) if isinstance(module, (tuple, list)) else (module,)

    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            if is_machine():
                return fn(*args, **kwargs)
            user = current_user()
            if user is None or not any(user.can(m, action) for m in modules):
                raise ForbiddenError("You do not have permission for this action")
            return fn(*args, **kwargs)
        return wrapper
    return decorator


def signed_in_required(fn):
    """For routes the shared key must not drive (the mail server settings, a
    test mail, the recipient and department masters, the reorder mail's "send
    now"): the caller must be a signed-in person, never the machine key alone.
    It does not decide what that person may do — stack it under the
    @admin_required / @permission_required that does."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if current_user() is None:
            raise ForbiddenError("Sign in to do this — the machine key (X-API-Key) is not accepted for this action")
        return fn(*args, **kwargs)
    return wrapper


def signed_in_admin_required(fn):
    """For routes that change the mail module: a person signed in as an
    administrator, never the machine key alone. Stack it under @admin_required."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = current_user()
        if user is None or not user.is_admin:
            raise ForbiddenError("Sign in as an administrator to change the mail engine")
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


def sees_spare_stock(user):
    """Whether a signed-in person may see the spare stock's figures (the
    machine caller, passed as None, always may)."""
    if user is None:
        return is_machine()
    return user.is_admin or any(user.can(m, "view") for m in SPARE_STOCK_VIEW)


def scoped_store(store_code):
    """The store a read is about, checked against the caller's access. Left out,
    only an administrator (or the machine) reads every store at once; anyone
    else must name one of theirs — a read that fell back to "all stores" when
    the store was left out handed any login every store's data (security
    audit, 24 Oct 2026)."""
    code = (store_code or "").strip() or None
    if code:
        require_store_access(code)
        return code
    user = current_user()
    if is_machine() or (user is not None and user.is_admin):
        return None
    raise BadRequestError("store_code is required")


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
