"""Application user + the store rights that decide which cards they see.

Rights are stored per user per store rather than baked into the role, so
giving someone "Spare Parts only" later is a row in user_store_access,
not a code change. ADMIN short-circuits the check entirely — an admin sees
every store, including ones added after their account was created.
"""
from werkzeug.security import check_password_hash, generate_password_hash

from app.extensions import db
from app.models.base import BaseModel

ROLES = ["ADMIN", "STORE_USER"]


class User(BaseModel):
    __tablename__ = "users"

    username = db.Column(db.String(50), unique=True, nullable=False, index=True)
    full_name = db.Column(db.String(120), nullable=True)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(20), nullable=False, default="STORE_USER")
    is_active = db.Column(db.Boolean, nullable=False, default=True)
    last_login_at = db.Column(db.DateTime(timezone=True), nullable=True)

    store_access = db.relationship(
        "UserStoreAccess", back_populates="user", cascade="all, delete-orphan"
    )

    __table_args__ = (
        db.CheckConstraint(f"role IN ({','.join(repr(r) for r in ROLES)})", name="ck_user_role"),
    )

    # Hashing lives on the model so no caller ever has to remember to do it,
    # and a plain password is never assignable to the stored column.
    def set_password(self, raw_password):
        self.password_hash = generate_password_hash(raw_password)

    def check_password(self, raw_password):
        return check_password_hash(self.password_hash, raw_password or "")

    @property
    def is_admin(self):
        return self.role == "ADMIN"

    def can_access_store(self, store_code):
        if self.is_admin:
            return True
        return any(a.store_code == store_code for a in self.store_access)

    def to_public_dict(self):
        """What the browser is allowed to know about the logged-in user —
        deliberately never includes password_hash."""
        return {
            "id": self.id,
            "username": self.username,
            "full_name": self.full_name,
            "role": self.role,
            "is_admin": self.is_admin,
            "stores": None if self.is_admin else [a.store_code for a in self.store_access],
        }

    def __repr__(self):
        return f"<User {self.username} ({self.role})>"


class UserStoreAccess(BaseModel):
    """Which stores a non-admin user may open. store_code stays a plain
    string rather than a foreign key because the Store master itself is
    still to come — this table is what a future "Store User" screen writes
    to, and it already works without it."""
    __tablename__ = "user_store_access"

    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    store_code = db.Column(db.String(30), nullable=False)

    user = db.relationship("User", back_populates="store_access")

    __table_args__ = (
        db.UniqueConstraint("user_id", "store_code", name="uq_user_store"),
    )
