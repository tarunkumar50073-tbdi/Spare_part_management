"""Admin user management: create with an admin-visible password, per-module
View/Edit rights, and the guards (unique username, min password, self-delete)."""
import pytest

from app.models.user import User
from app.services.admin_service import AdminService
from app.utils.exceptions import BadRequestError


def test_create_user_stores_visible_password_and_permissions():
    svc = AdminService()
    out = svc.create_user({
        "username": "operator1", "password": "pass123", "full_name": "Op One",
        "role": "STORE_USER",
        "permissions": {"store_stock": {"view": True, "edit": True},
                        "reports": {"view": True, "edit": False}},
        "stores": ["MAINTENANCE"],
    })
    assert out["username"] == "operator1"
    assert out["password"] == "pass123"                       # admin can see it
    assert out["permissions"]["store_stock"] == {"view": True, "edit": True}
    assert out["stores"] == ["MAINTENANCE"]

    user = User.query.filter_by(username="operator1").first()
    assert user.check_password("pass123")                     # hash still authenticates
    assert user.can("store_stock", "edit")
    assert user.can("reports", "view")
    assert not user.can("reports", "edit")                    # view-only
    assert not user.can("part_master", "view")                # not granted at all


def test_reset_password_updates_the_visible_copy():
    svc = AdminService()
    u = svc.create_user({"username": "op2", "password": "old12", "role": "STORE_USER"})
    svc.reset_password(u["id"], "new12345")
    user = User.query.get(u["id"])
    assert user.check_password("new12345")
    assert user.password_plain == "new12345"                  # admin sees the new one


def test_duplicate_username_and_short_password_rejected():
    svc = AdminService()
    svc.create_user({"username": "dupe", "password": "abcd", "role": "STORE_USER"})
    with pytest.raises(BadRequestError):
        svc.create_user({"username": "DUPE", "password": "abcd"})   # case-insensitive clash
    with pytest.raises(BadRequestError):
        svc.create_user({"username": "shortpw", "password": "ab"})  # < 4 chars


def test_admin_role_has_every_permission():
    svc = AdminService()
    a = svc.create_user({"username": "adminx", "password": "abcd", "role": "ADMIN"})
    user = User.query.get(a["id"])
    assert user.can("part_master", "edit")
    assert user.can("admin", "edit")
    assert user.get_permissions()["reports"] == {"view": True, "edit": True}


def test_cannot_delete_own_account():
    svc = AdminService()
    a = svc.create_user({"username": "selfadmin", "password": "abcd", "role": "ADMIN"})
    with pytest.raises(BadRequestError):
        svc.delete_user(a["id"], acting_user_id=a["id"])


def test_demote_only_stores_and_perms_are_cleared_for_admin():
    svc = AdminService()
    u = svc.create_user({"username": "mixed", "password": "abcd", "role": "STORE_USER",
                         "permissions": {"reports": {"view": True, "edit": True}},
                         "stores": ["MAINTENANCE"]})
    promoted = svc.update_user(u["id"], {"role": "ADMIN"})
    assert promoted["stores"] == []              # admin access is implicit
    assert promoted["permissions"] == {}
