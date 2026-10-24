"""Login/logout against the users table, backed by Flask's signed session
cookie.

A session cookie rather than a token: now that Flask serves the built
frontend itself, the browser is same-origin, so the cookie rides along on
every request with nothing for the SPA to store or refresh — and nothing
sitting in localStorage for a stray script to read.
"""
from datetime import timedelta, timezone

from sqlalchemy.exc import IntegrityError

from app.extensions import db
from app.models.base import utcnow
from app.models.login_attempt import LoginAttempt
from app.repositories.user_repository import UserRepository
from app.utils.exceptions import AppException


class UnauthorizedError(AppException):
    status_code = 401
    message = "Invalid username or password"


class AccountBlockedError(AppException):
    status_code = 423
    message = "This account is blocked for now"


def _aware(dt):
    """SQLite hands a stored time back without its zone; it was stored in UTC."""
    return dt.replace(tzinfo=timezone.utc) if dt is not None and dt.tzinfo is None else dt


class AuthService:
    def __init__(self):
        self.repo = UserRepository()

    def authenticate(self, username, password, lock=None):
        """The user for these credentials, or an error saying why not.

        `lock` = (attempts, minutes) blocks a username for `minutes` after
        `attempts` wrong username / password tries in a row (the QMP portal's
        way, 23 Oct 2026); each wrong try says how many are left. A wrong try
        older than `minutes` no longer counts towards the next block. None
        skips the block."""
        name = (username or "").strip()
        guard = self._guard(name) if lock else None
        if guard is not None:
            self._refuse_if_blocked(guard, lock)
        user = self.repo.get_by_username(name)
        # Same error whether the username is unknown or the password is
        # wrong, so the response can't be used to discover valid usernames —
        # and an unknown name is counted and blocked exactly like a real one.
        if not user or not user.check_password(password):
            if lock:
                self._count_wrong(guard, name, lock)
            raise UnauthorizedError()
        if not user.is_active:
            raise UnauthorizedError("This account is disabled")
        if guard is not None:
            db.session.delete(guard)          # a good sign-in wipes the count
        self.repo.update(user, last_login_at=utcnow())
        return user

    @staticmethod
    def _guard(name):
        return LoginAttempt.query.filter_by(username=name.lower()[:50]).first()

    @staticmethod
    def _refuse_if_blocked(guard, lock):
        attempts, minutes = lock
        until = _aware(guard.locked_until)
        now = utcnow()
        if until is None:
            return
        if until > now:
            left = max(1, -(-int((until - now).total_seconds()) // 60))   # whole minutes, rounded up
            raise AccountBlockedError(
                f"This account is blocked for {minutes} minutes after {attempts} wrong attempts. "
                f"Try again in {left} minute(s).")
        # The block is over: start counting afresh.
        guard.failed_count, guard.locked_until = 0, None
        db.session.commit()

    @staticmethod
    def _count_wrong(guard, name, lock):
        attempts, minutes = lock
        now = utcnow()
        key = name.lower()[:50]
        if guard is None:
            guard = LoginAttempt(username=key, failed_count=0)
            db.session.add(guard)
            try:
                db.session.flush()
            except IntegrityError:
                # A wrong try for the same name, checked alongside, made it first.
                db.session.rollback()
                guard = LoginAttempt.query.filter_by(username=key).first()
        last = _aware(guard.last_failed_at)
        fresh = last is None or now - last > timedelta(minutes=minutes)
        # Counted by the database in one UPDATE: read-then-write let a burst of
        # guesses checked side by side all write the same count and never reach
        # the block (security audit, 24 Oct 2026). Each try now adds its own 1.
        LoginAttempt.query.filter_by(id=guard.id).update(
            {LoginAttempt.failed_count: 1 if fresh else LoginAttempt.failed_count + 1,
             LoginAttempt.last_failed_at: now}, synchronize_session=False)
        db.session.refresh(guard)
        n = guard.failed_count
        if n >= attempts:
            guard.locked_until = now + timedelta(minutes=minutes)
            db.session.commit()
            raise AccountBlockedError(
                f"Wrong username or password. You have entered wrong {n} times — "
                f"the account is blocked for {minutes} minutes.")
        db.session.commit()
        raise UnauthorizedError(
            f"Wrong username or password. You have entered wrong {n} time(s) — "
            f"{attempts - n} attempt(s) left before the account is blocked for {minutes} minutes.")

    def get_user(self, user_id):
        if not user_id:
            return None
        user = self.repo.get_by_id(user_id)
        # A user disabled mid-session stops being authenticated on their very
        # next request, not whenever the cookie happens to expire.
        return user if user and user.is_active else None
