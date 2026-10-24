"""Wrong sign-in tries per username, for the account block (the QMP portal's
way, 23 Oct 2026): after LOGIN_LOCK_ATTEMPTS wrong username / password tries
in a row the name is blocked for LOGIN_LOCK_MINUTES.

Keyed by the username as typed (trimmed, lower case), not by a user row, so a
name that does not exist is counted and blocked exactly like one that does —
the answer never tells which usernames are real.
"""
from app.extensions import db
from app.models.base import BaseModel


class LoginAttempt(BaseModel):
    __tablename__ = "login_attempts"

    username = db.Column(db.String(50), unique=True, nullable=False, index=True)
    failed_count = db.Column(db.Integer, nullable=False, default=0)
    last_failed_at = db.Column(db.DateTime(timezone=True), nullable=True)
    locked_until = db.Column(db.DateTime(timezone=True), nullable=True)
