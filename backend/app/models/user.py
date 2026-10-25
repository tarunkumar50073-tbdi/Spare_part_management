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
    {"key": "action_tracker", "label": "Action Tracker"},
    {"key": "notifications", "label": "Notification Center"},
    {"key": "store_stock", "label": "Store Stock (count / edit)"},
    {"key": "inventory_control", "label": "Critical · Reorder · Excess"},
    {"key": "put_away_check", "label": "Put-away Check"},
    {"key": "scan_part", "label": "Scan Part — issue / receive / return"},
    {"key": "work_queue", "label": "Work Queue"},
    {"key": "consumption", "label": "Issuance & Consumption"},
    {"key": "receiving", "label": "Receiving & GRN"},
    {"key": "short_rejection", "label": "Short & Rejection"},
    # No "kiosk" right any more: the kiosk part request and its Part Requisition
    # queue were taken out on 17 Oct 2026 ("management k according manual detail
    # fill karke issuance karna time waste h" — the store). A "kiosk" key an old
    # login still has stored is simply never asked for, and drops off the next
    # time that login's rights are saved (set_permissions keeps known keys only).
    # Stage-2 only: a line user may confirm where an issued part was fitted
    # (line / machine / die + how much was used) WITHOUT the full issue /
    # receive / return rights that scan_part carries. There is no per-part QR to
    # re-scan (we print bin sheets, not part labels), so the confirm
    # screen is a list of parts already issued, not a scanner. The confirm
    # endpoint accepts this right OR scan_part edit; it still needs store access.
    {"key": "install_confirm", "label": "Confirm Installation — line / machine (user)"},
    {"key": "part_ledger", "label": "Part Ledger"},
    {"key": "erp_gap", "label": "ERP vs Physical Gap"},
    {"key": "erp_control", "label": "ERP Control Center"},
    {"key": "part_master", "label": "Part Master"},
    {"key": "data_quality", "label": "Data Quality"},
    {"key": "supplier_barcodes", "label": "Supplier Barcodes"},
    {"key": "scan_audit", "label": "Scan Audit"},
    {"key": "departments", "label": "Department Emails"},
    # People parts are issued to (mobile no. -> name / code / department). The
    # issue screen can add a missing person with scan_part edit too.
    {"key": "employees", "label": "Employee Master"},
    # No "part_photos" right either: Photo Mode opens from the Part Master's own
    # button and a photo is saved with the Part Master edit right (23 Oct 2026).
    # No "equipment" right any more: the Line / Machine / Die master is kept by
    # whoever keeps the Part Master (the store, 23 Oct 2026). Its pick-lists on
    # the issue / install screens never needed it, and the install form can still
    # add a missing value with scan_part edit. An old login's stored "equipment"
    # key is simply never asked for.
    {"key": "reports", "label": "Reports"},
    {"key": "audit_trail", "label": "Audit Trail"},
    {"key": "live_dashboard", "label": "Live Dashboard"},
    {"key": "gate_entry", "label": "Gate Entry"},
    # Urgent material on a supplier's delivery challan before its PO / invoice
    # (21 Oct 2026). A register only — the ERP GRN stays the one way stock goes up.
    {"key": "challan_register", "label": "Urgent Challan Register"},
    {"key": "rejection_request", "label": "Rejection Mail (RQC)"},
    # The mail to Purchase for material received short (25 Oct 2026) — its own
    # right, apart from the Rejection Mail's ("alag alag ho").
    {"key": "short_mail", "label": "Short Mail (Purchase)"},
    {"key": "vehicle_in_out", "label": "Vehicle In / Out"},
    {"key": "admin", "label": "Admin — user management"},
    # Child Parts Store write screens (put-away, holding transfer, daily count,
    # rack alerts). The store is switched off in Spare-only mode; the right exists
    # so those endpoints are not open to every signed-in user in the meantime.
    {"key": "child_store", "label": "Child Parts Store — operations"},
]

# Rights are CRUD since 24 Oct 2026 (the store: "proper crud bna — E matlab
# kewal edit/modify, create matlab new create aur insert data, read matlab
# kewal view no any action, delete matlab kewal delete"):
#   view    R  open the screen and read it — no action at all
#   create  C  add new records / start new entries (a new part, an issue, a challan)
#   update  E  change what already exists (edit a part, a count, a location)
#   delete  D  remove or cancel (delete a part, cancel a challan or an RGP)
# Any of C / E / D needs R as well. Each screen lists the actions it HAS; the
# rest are not offered on the Rights Matrix and never granted.
ACTIONS = ("view", "create", "update", "delete")
WRITE_ACTIONS = ("create", "update", "delete")
_R, _RC, _RU, _RCU, _RCUD = (("view",), ("view", "create"), ("view", "update"),
                             ("view", "create", "update"), ACTIONS)
MODULE_ACTIONS = {
    "spare_store": _R, "action_tracker": _R, "notifications": _R,
    "store_stock": _RCU,          # C put-away record, GRN post · E count, stock / ERP-stock import, ERP sync
    "inventory_control": _R,
    "put_away_check": _RC,        # C put-away record
    "scan_part": _RCUD,           # C issue, return, RGP out, labels · E location, inspection, RGP GRN · D cancel RGP
    "work_queue": _R, "consumption": _R,
    "receiving": _RC,             # C post ERP GRN lines to stock
    "short_rejection": _R,
    "install_confirm": _RU,       # E confirm the line / machine of an issue
    "part_ledger": _R, "erp_gap": _R,
    "erp_control": _RU,           # E sync with ERP
    "part_master": _RCUD,         # C new part / import · E edit, photo · D delete
    "data_quality": _RU,          # E fill a part's missing field
    "supplier_barcodes": _RCU,    # C map a supplier code · E switch a mapping on / off
    "scan_audit": _R,
    "departments": _RCUD,         # C department, recipient, send now · E edit · D remove a recipient
    "employees": _RCU,            # C new / import · E edit
    "reports": _R, "audit_trail": _R, "live_dashboard": _R, "gate_entry": _R,
    "challan_register": _RCUD,    # C new challan · E edit, invoice / GRN links · D cancel
    "rejection_request": _RCU,    # C new request · E settings, mail draft
    "short_mail": _RCU,           # C make a short mail · E its To / CC
    "vehicle_in_out": _R, "admin": _R,
    "child_store": _RCU,          # C RGP, count submit · E put-away, transfer, resolve, count import
}
for _module in PERMISSION_MODULES:
    _module["actions"] = list(MODULE_ACTIONS.get(_module["key"], _R))


def normalize_rights(key, value):
    """One module's rights as {view, create, update, delete}. A right the screen
    does not have is never granted, and C / E / D bring R with them. A map
    saved before 24 Oct 2026 carries one "edit" for all three writes: it reads
    as each write the screen has, so nobody lost a button the day rights split."""
    allowed = MODULE_ACTIONS.get(key, _R)
    value = value if isinstance(value, dict) else {}
    legacy = bool(value.get("edit"))
    out = {a: bool(a in allowed and value.get(a, legacy)) for a in WRITE_ACTIONS}
    # Read comes with any write asked for, even one this screen lacks: an old
    # "edit" on a read-only screen (Reports) always opened it.
    out["view"] = bool(value.get("view")) or legacy or any(bool(value.get(a)) for a in WRITE_ACTIONS)
    return {a: out[a] for a in ACTIONS}


# Screens that had no right of their own until 23 Oct 2026 (the store: "jo naye
# module bne h wo bhi add kar right matrix me"), each with the older right it
# used to open on. A login saved before the split takes that right's view / edit
# once (app._split_rights), so nobody lost a screen the day it got its own column.
# Notification Center opened for every login of the Spare Parts Store, with no
# right at all (None): such a login takes view.
SPLIT_RIGHTS = {
    "action_tracker": "spare_store",
    "consumption": "spare_store",
    "receiving": "spare_store",
    "short_rejection": "spare_store",
    "inventory_control": "store_stock",
    "put_away_check": "store_stock",
    "work_queue": "scan_part",
    "erp_control": "erp_gap",
    "data_quality": "part_master",
    "notifications": None,
}


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
        """The per-module rights map, {module: {view, create, update, delete}}.
        An admin holds every action each screen has; a store user's map is
        whatever the admin saved (missing module or action = not allowed), an
        older {view, edit} map read through normalize_rights."""
        if self.is_admin:
            return {m["key"]: normalize_rights(m["key"], dict.fromkeys(ACTIONS, True)) for m in PERMISSION_MODULES}
        try:
            saved = json.loads(self.permissions) if self.permissions else {}
        except (ValueError, TypeError):
            return {}
        return {key: normalize_rights(key, val) for key, val in saved.items() if isinstance(val, dict)}

    def set_permissions(self, perms):
        # Keep only known modules and coerce to booleans, so a stray key or a
        # non-bool from the client can't smuggle rights in.
        # An older {view, edit} map is taken as each write the screen has.
        clean = {}
        keys = {m["key"] for m in PERMISSION_MODULES}
        for key, val in (perms or {}).items():
            if key in keys and isinstance(val, dict):
                clean[key] = normalize_rights(key, val)
        self.permissions = json.dumps(clean)

    def can(self, module, action="view"):
        """Whether this login may do `action` on `module`: "view" (R), "create"
        (C), "update" (E) or "delete" (D); a tuple of them = all of them (an
        import both adds and changes). "edit" is the old name of "update"."""
        if isinstance(action, (tuple, list)):
            return all(self.can(module, a) for a in action)
        if self.is_admin:
            return True
        if action == "edit":
            action = "update"
        entry = self.get_permissions().get(module) or {}
        return bool(entry.get(action))

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
