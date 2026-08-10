"""Login/logout against the users table, backed by Flask's signed session
cookie.

A session cookie rather than a token: now that Flask serves the built
frontend itself, the browser is same-origin, so the cookie rides along on
every request with nothing for the SPA to store or refresh — and nothing
sitting in localStorage for a stray script to read.
"""
from app.models.base import utcnow
from app.repositories.user_repository import UserRepository
from app.utils.exceptions import AppException


class UnauthorizedError(AppException):
    status_code = 401
    message = "Invalid username or password"


class AuthService:
    def __init__(self):
        self.repo = UserRepository()

    def authenticate(self, username, password):
        user = self.repo.get_by_username((username or "").strip())
        # Same error whether the username is unknown or the password is
        # wrong, so the response can't be used to discover valid usernames.
        if not user or not user.check_password(password):
            raise UnauthorizedError()
        if not user.is_active:
            raise UnauthorizedError("This account is disabled")
        self.repo.update(user, last_login_at=utcnow())
        return user

    def get_user(self, user_id):
        if not user_id:
            return None
        user = self.repo.get_by_id(user_id)
        # A user disabled mid-session stops being authenticated on their very
        # next request, not whenever the cookie happens to expire.
        return user if user and user.is_active else None
