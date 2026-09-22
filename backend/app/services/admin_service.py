"""Admin module: user management, per-module rights, and password visibility.

Every operation here is ADMIN-only (enforced at the route with admin_required).
The readable password lives on the User model as password_plain — see the note
there; it is returned only through the admin user API.
"""
from app.extensions import db
from app.models.user import PERMISSION_MODULES, ROLES, User, UserStoreAccess
from app.repositories.user_repository import UserRepository
from app.utils.exceptions import BadRequestError, NotFoundError

MIN_PASSWORD_LEN = 4


class AdminService:
    def __init__(self):
        self.repo = UserRepository()

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
        wanted = sorted({s for s in stores if s})
        user.store_access = [UserStoreAccess(store_code=s) for s in wanted]

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

        if "full_name" in data:
            user.full_name = (data.get("full_name") or "").strip() or None
        if "role" in data:
            role = (data.get("role") or user.role).upper()
            if role not in ROLES:
                raise BadRequestError(f"Unknown role: {role}")
            user.role = role
        if "is_active" in data:
            user.is_active = bool(data.get("is_active"))
        if data.get("password"):
            self._check_password(data["password"])
            user.set_password(data["password"])

        if user.role == "ADMIN":
            # An admin's rights/stores are implicit — clear any stored map so it
            # can't linger and mislead if they are demoted later.
            user.permissions = None
            user.store_access = []
        else:
            if "permissions" in data:
                user.set_permissions(data.get("permissions") or {})
            if "stores" in data:
                self._apply_stores(user, data.get("stores"))
        db.session.commit()
        return user.to_admin_dict()

    def reset_password(self, user_id, new_password):
        self._check_password(new_password)
        user = self._get(user_id)
        user.set_password(new_password)
        db.session.commit()
        return user.to_admin_dict()

    def delete_user(self, user_id, acting_user_id=None):
        user = self._get(user_id)
        if acting_user_id and user.id == acting_user_id:
            raise BadRequestError("You can't delete your own account")
        if user.is_admin and self._active_admin_count(exclude_id=user.id) == 0:
            raise BadRequestError("Can't remove the last active admin")
        db.session.delete(user)
        db.session.commit()
        return {"id": user_id}
