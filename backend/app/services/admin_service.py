"""Admin module: user management, per-module rights, and password visibility.

Every operation here is ADMIN-only (enforced at the route with admin_required).
The readable password lives on the User model as password_plain — see the note
there; it is returned only through the admin user API.
"""
from flask import g, has_request_context

from app.extensions import db
from app.models.user import PERMISSION_MODULES, ROLES, User, UserStoreAccess
from app.repositories.user_repository import UserRepository
from app.services.audit_log_service import AuditLogService
from app.utils.exceptions import BadRequestError, NotFoundError

# A password set from User Management (new user or reset) is at least this
# long — 4 until 24 Oct 2026, when the app went on the internet ("password
# length 8 kar de"). Passwords already set keep working until they are reset.
MIN_PASSWORD_LEN = 8


def _actor():
    """The signed-in admin performing the action, recorded in the audit remark
    (the AuditLog.user column itself is constrained to SYSTEM/STORE)."""
    if has_request_context() and getattr(g, "current_user", None):
        return g.current_user.username
    return "system"


class AdminService:
    def __init__(self):
        self.repo = UserRepository()
        self.audit = AuditLogService()

    def modules(self):
        return PERMISSION_MODULES

    def list_users(self):
        return [u.to_admin_dict() for u in User.query.order_by(User.username.asc()).all()]

    def _get(self, user_id):
        user = self.repo.get_by_id(user_id)
        if not user:
            raise NotFoundError("User not found")
        return user

    def _active_admin_count(self, exclude_id=None):
        q = User.query.filter_by(role="ADMIN", is_active=True)
        if exclude_id:
            q = q.filter(User.id != exclude_id)
        return q.count()

    @staticmethod
    def _apply_stores(user, stores):
        if stores is None:
            return
        wanted = {s for s in stores if s}
        # Diff the collection rather than replacing it wholesale: re-adding a
        # store the user already has would INSERT a duplicate (user_id,
        # store_code) before the orphaned old row is deleted in the same flush,
        # tripping the uq_user_store unique constraint ("Database integrity
        # constraint violated" on save). Keep unchanged rows, drop the rest, add
        # only the genuinely new ones.
        for access in list(user.store_access):
            if access.store_code not in wanted:
                user.store_access.remove(access)
        have = {a.store_code for a in user.store_access}
        for code in sorted(wanted - have):
            user.store_access.append(UserStoreAccess(store_code=code))

    @staticmethod
    def _check_password(pw):
        if not pw or len(pw) < MIN_PASSWORD_LEN:
            raise BadRequestError(f"Password must be at least {MIN_PASSWORD_LEN} characters")

    def create_user(self, data):
        username = (data.get("username") or "").strip()
        if not username:
            raise BadRequestError("Username is required")
        if self.repo.get_by_username(username):
            raise BadRequestError(f"Username '{username}' already exists")
        self._check_password(data.get("password"))
        role = (data.get("role") or "STORE_USER").upper()
        if role not in ROLES:
            raise BadRequestError(f"Unknown role: {role}")
        user = User(
            username=username,
            full_name=(data.get("full_name") or "").strip() or None,
            role=role,
            is_active=bool(data.get("is_active", True)),
        )
        user.set_password(data["password"])
        if role != "ADMIN":
            user.set_permissions(data.get("permissions") or {})
            self._apply_stores(user, data.get("stores"))
        db.session.add(user)
        db.session.commit()
        self.audit.log(action="USER_CREATED", entity_type="user", entity_id=user.id,
                       user="STORE", remarks=f"Created user '{username}' (role {role}) by {_actor()}"[:255])
        return user.to_admin_dict()

    def update_user(self, user_id, data):
        user = self._get(user_id)
        # Guard the last admin before touching anything: don't let a demote or a
        # deactivate lock everyone out of the admin panel.
        demoting = user.is_admin and (
            ("role" in data and (data.get("role") or "").upper() != "ADMIN")
            or ("is_active" in data and not bool(data.get("is_active")))
        )
        if demoting and self._active_admin_count(exclude_id=user.id) == 0:
            raise BadRequestError("Can't remove the last active admin")

        changes = []
        if "full_name" in data:
            user.full_name = (data.get("full_name") or "").strip() or None
        if "role" in data:
            role = (data.get("role") or user.role).upper()
            if role not in ROLES:
                raise BadRequestError(f"Unknown role: {role}")
            if role != user.role:
                changes.append(f"role {user.role}→{role}")
            user.role = role
        if "is_active" in data:
            new_active = bool(data.get("is_active"))
            if new_active != user.is_active:
                changes.append("activated" if new_active else "deactivated")
            user.is_active = new_active
        if data.get("password"):
            self._check_password(data["password"])
            user.set_password(data["password"])
            changes.append("password changed")

        if user.role == "ADMIN":
            # An admin's rights/stores are implicit — clear any stored map so it
            # can't linger and mislead if they are demoted later.
            user.permissions = None
            user.store_access = []
        else:
            if "permissions" in data:
                user.set_permissions(data.get("permissions") or {})
                changes.append("permissions changed")
            if "stores" in data:
                self._apply_stores(user, data.get("stores"))
                changes.append("store access changed")
        db.session.commit()
        self.audit.log(action="USER_UPDATED", entity_type="user", entity_id=user.id, user="STORE",
                       remarks=f"Updated '{user.username}': {', '.join(changes) or 'no change'} by {_actor()}"[:255])
        return user.to_admin_dict()

    def reset_password(self, user_id, new_password):
        self._check_password(new_password)
        user = self._get(user_id)
        user.set_password(new_password)
        db.session.commit()
        self.audit.log(action="PASSWORD_RESET", entity_type="user", entity_id=user.id,
                       user="STORE", remarks=f"Password reset for '{user.username}' by {_actor()}"[:255])
        return user.to_admin_dict()

    def delete_user(self, user_id, acting_user_id=None):
        user = self._get(user_id)
        if acting_user_id and user.id == acting_user_id:
            raise BadRequestError("You can't delete your own account")
        if user.is_admin and self._active_admin_count(exclude_id=user.id) == 0:
            raise BadRequestError("Can't remove the last active admin")
        username = user.username
        db.session.delete(user)
        db.session.commit()
        self.audit.log(action="USER_DELETED", entity_type="user", entity_id=user_id,
                       user="STORE", remarks=f"Deleted user '{username}' by {_actor()}"[:255])
        return {"id": user_id}
