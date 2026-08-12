"""Department master — the departments the spare store issues to and, more to
the point, the e-mail each one's reorder / low-stock notifications are sent to.

A table rather than a code constant for the same reason as the Store master:
a plant keeps adding departments and changing whose inbox the mail lands in,
and neither should need a developer or a redeploy.
"""
from app.extensions import db
from app.models.base import BaseModel

# Seeded on first boot so the master is never empty: the three consuming
# departments the issue flow already knows, plus Purchase and Store as the
# usual reorder-mail recipients. Purchase is pre-flagged to receive the reorder
# mail (it raises the PO); every e-mail starts blank — the row exists before
# the address is known, and an admin fills it in.
SEED_DEPARTMENTS = [
    {"name": "Press Shop", "sort_order": 1},
    {"name": "Maintenance", "sort_order": 2},
    {"name": "Tool Room", "sort_order": 3},
    {"name": "Purchase", "sort_order": 4, "notify_reorder": True},
    {"name": "Store", "sort_order": 5},
]


class Department(BaseModel):
    __tablename__ = "departments"

    name = db.Column(db.String(60), unique=True, nullable=False, index=True)
    # Where this department's reorder / low-stock mails are sent. Blank until an
    # admin fills it. A group distribution list is fine — one address per row.
    email = db.Column(db.String(255), nullable=True)
    # Whether the reorder e-mail should go to this department. Lets Purchase be
    # the recipient while a consuming department (Press Shop…) stays only a tag
    # on issues, not a mail target.
    notify_reorder = db.Column(db.Boolean, nullable=False, default=False)
    sort_order = db.Column(db.Integer, nullable=False, default=100)
    is_active = db.Column(db.Boolean, nullable=False, default=True)

    def to_dict(self):
        return {
            "id": self.id, "name": self.name, "email": self.email,
            "notify_reorder": self.notify_reorder,
            "sort_order": self.sort_order, "is_active": self.is_active,
        }

    def __repr__(self):
        return f"<Department {self.name}>"
