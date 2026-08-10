"""User data access layer."""
from sqlalchemy import func

from app.models.user import User
from app.repositories.base_repository import BaseRepository


class UserRepository(BaseRepository):
    model = User

    def get_by_username(self, username):
        # Matched case-insensitively so "Admin" and "admin" are one account
        # rather than two people think they share.
        if not username:
            return None
        return self.model.query.filter(func.lower(self.model.username) == username.lower()).first()

    def list_active(self):
        return self.model.query.filter_by(is_active=True).order_by(self.model.username.asc()).all()
