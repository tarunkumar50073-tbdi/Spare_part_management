"""Application user + the store rights that decide which cards they see.

Rights are stored per user per store rather than baked into the role, so
giving someone "Spare Parts only" later is a row in user_store_access,
not a code change. ADMIN short-circuits the check entirely — an admin sees
every store, including ones added after their account was created.
"""
import json

from werkzeug.security import check_password_hash, generate_password_hash

from app.extensions import db
from app.models.base import BaseModel

ROLES = ["ADMIN", "STORE_USER"]

# The functional areas a Store User's rights are set against, in the admin
# panel. `view` = may open and read the module; `edit` = may create / update /
# delete within it (the SRUD split). ADMIN bypasses all of this and sees
# everything. Keys are stable ids stored in the permission map; labels are what
# the admin screen shows.
PERMISSION_MODULES = [
    {"key": "spare_store", "label": "Spare Parts Store (dashboard)"},
    {"key": "store_stock", "label": "Store Stock (count / edit)"},
    {"key": "scan_part", "label": "Scan Part — issue / receive / return"},
    {"key": "part_ledger", "label": "Part Ledger"},
    {"key": "erp_gap", "label": "ERP vs Physical Gap"},
    {"key": "part_master", "label": "Part Master"},
    {"key": "supplier_barcodes", "label": "Supplier Barcodes"},
    {"key": "scan_audit", "label": "Scan Audit"},
    {"key": "departments", "label": "Department Emails"},
    {"key": "reports", "label": "Reports"},
    {"key": "live_dashboard", "label": "Live Dashboard"},
    {"key": "gate_entry", "label": "Gate Entry"},
    {"key": "vehicle_in_out", "label": "Vehicle In / Out"},
    {"key": "admin", "label": "Admin — user management"},
]


class User(BaseModel):
    __tablename__ = "users"

    username = db.Column(db.String(50), unique=True, nullable=False, index=True)
    full_name = db.Column(db.String(120), nullable=True)
    password_hash = db.Column(db.String(255), nullable=False)
    # A readable copy of the password, kept ONLY so the admin user-management
    # screen can show it (an explicit product decision — the admin wants to see
    # and hand out user passwords, including ones a user later changes).
    # SECURITY NOTE: this is plaintext at rest — anyone with DB / backup access
    # can read every password. It is never in to_public_dict and is returned
    # only by the admin-only user API.
    password_plain = db.Column(db.String(255), nullable=True)
    role = db.Column(db.String(20), nullable=False, default="STORE_USER")
    is_active = db.Column(db.Boolean, nullable=False, default=True)
    last_login_at = db.Column(db.DateTime(timezone=True), nullable=True)
    # Per-module {module_key: {"view": bool, "edit": bool}} for a STORE_USER,
    # as JSON text. Empty / null for an ADMIN, who is allowed everything.
    permissions = db.Column(db.Text, nullable=True)

    store_access = db.relationship(
        "UserStoreAccess", back_populates="user", cascade="all, delete-orphan"
    )

    __table_args__ = (
        db.CheckConstraint(f"role IN ({','.join(repr(r) for r in ROLES)})", name="ck_user_role"),
    )

    # Hashing lives on the model so no caller ever has to remember to do it. The
    # readable copy is written alongside the hash (see password_plain above).
    def set_password(self, raw_password):
        self.password_hash = generate_password_hash(raw_password)
        self.password_plain = raw_password

    def check_password(self, raw_password):
        return check_password_hash(self.password_hash, raw_password or "")

    @property
    def is_admin(self):
        return self.role == "ADMIN"

    def can_access_store(self, store_code):
        if self.is_admin:
            return True
        return any(a.store_code == store_code for a in self.store_access)

    def get_permissions(self):
        """The per-module rights map. An admin implicitly has view+edit on every
        module; a store user's map is whatever the admin saved (missing module
        or key = not allowed)."""
        if self.is_admin:
            return {m["key"]: {"view": True, "edit": True} for m in PERMISSION_MODULES}
        try:
            return json.loads(self.permissions) if self.permissions else {}
        except (ValueError, TypeError):
            return {}

    def set_permissions(self, perms):
        # Keep only known modules and coerce to booleans, so a stray key or a
        # non-bool from the client can't smuggle rights in.
        clean = {}
        keys = {m["key"] for m in PERMISSION_MODULES}
        for key, val in (perms or {}).items():
            if key in keys and isinstance(val, dict):
                clean[key] = {"view": bool(val.get("view")), "edit": bool(val.get("edit"))}
        self.permissions = json.dumps(clean)

    def can(self, module, action="view"):
        if self.is_admin:
            return True
        entry = self.get_permissions().get(module) or {}
        # Editing implies viewing — you can't edit what you can't see.
        return bool(entry.get("edit")) if action == "edit" else bool(entry.get("view") or entry.get("edit"))

    def to_public_dict(self):
        """What the browser is allowed to know about the logged-in user —
        deliberately never includes password_hash or password_plain. Carries the
        per-module rights so the SPA can gate its own nav and buttons."""
        return {
            "id": self.id,
            "username": self.username,
            "full_name": self.full_name,
            "role": self.role,
            "is_admin": self.is_admin,
            "stores": None if self.is_admin else [a.store_code for a in self.store_access],
            "permissions": self.get_permissions(),
        }

    def to_admin_dict(self):
        """The full record for the admin user-management screen — includes the
        readable password and the per-module rights. Admin API only."""
        return {
            "id": self.id,
            "username": self.username,
            "full_name": self.full_name,
            "role": self.role,
            "is_admin": self.is_admin,
            "is_active": self.is_active,
            "password": self.password_plain,
            "stores": [a.store_code for a in self.store_access],
            "permissions": {} if self.is_admin else self.get_permissions(),
            "last_login_at": self.last_login_at.isoformat() if self.last_login_at else None,
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
