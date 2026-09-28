"""Line / Machine / Die master — the places a spare part is installed onto.

At installation (Scan Part -> Update Line / Machine) the operator records where
the part went: the production Line, the Machine, and the Die. These used to be
free text, so the same press was spelt "Press-07", "press 7" and "PRESS07" and
never grouped. This master turns each into a pick-list; the operator selects
instead of typing, and a value still missing from the master can be typed (and
quick-added) so the floor is never blocked.

One table holds all three, told apart by ``kind`` (LINE / MACHINE / DIE), because
they are structurally the same — a short ``code`` and a ``name``. A Line carries
both: ``name`` = the line name (e.g. "Seat Slider") and ``code`` = the line no.
(e.g. "L-03"); picking one Line fills both boxes on the install form. A Machine
or Die uses ``name`` for its value and leaves ``code`` blank.

Nothing here is a foreign key: the ledger keeps storing the chosen text (as it
always has), so old rows are untouched and renaming a machine never rewrites
history. Items are deactivated, never deleted, so a retired line still reads on
past installations. The master is seeded from the distinct values already on the
ledger (see EquipmentService.seed_from_ledger) so the dropdowns start populated.
"""
import re

from app.extensions import db
from app.models.base import BaseModel

# The three things recorded at installation. Stored uppercase; the CHECK below
# keeps anything else out at the database.
KINDS = ("LINE", "MACHINE", "DIE")


def normalise_name(raw):
    """Collapse inner whitespace and trim; '' -> None. The display label is kept
    in the operator's own case (a line is "Seat Slider", not "SEAT SLIDER")."""
    name = " ".join(str(raw or "").split())
    return name or None


def normalise_code(raw):
    """Trim, collapse whitespace, upper-case; '' -> None. A code is a short id
    (line no. / machine no. / die no.) so it is matched case-insensitively."""
    code = " ".join(str(raw or "").split()).upper()
    return code or None


class Equipment(BaseModel):
    __tablename__ = "equipment"

    # LINE | MACHINE | DIE — see KINDS.
    kind = db.Column(db.String(10), nullable=False, index=True)
    # Short id: the line no. for a LINE, usually blank for a MACHINE / DIE.
    code = db.Column(db.String(40), nullable=True, index=True)
    # The label the operator picks and that is written to the ledger.
    name = db.Column(db.String(80), nullable=False)
    is_active = db.Column(db.Boolean, nullable=False, default=True)
    created_by = db.Column(db.String(60), nullable=True)
    updated_by = db.Column(db.String(60), nullable=True)

    __table_args__ = (
        db.CheckConstraint("kind IN ('LINE','MACHINE','DIE')", name="ck_equipment_kind"),
        # Case-insensitive backstop for the (kind, name) rule the service checks:
        # two counters quick-adding the same machine at once can both pass the
        # check-then-insert, so the DB must reject the second. A functional index
        # (kind, lower(name)) because the rule is case-insensitive; SQLite and the
        # export path both support it. The table is created fresh with this index
        # (db.create_all), so an existing DB gets it too.
        db.Index("uq_equipment_kind_lower_name", "kind", db.func.lower(name), unique=True),
    )

    def to_dict(self):
        return {
            "id": self.id, "kind": self.kind, "code": self.code, "name": self.name,
            "is_active": self.is_active, "created_by": self.created_by,
            "updated_by": self.updated_by,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }

    def __repr__(self):
        return f"<Equipment {self.kind} {self.name}>"
