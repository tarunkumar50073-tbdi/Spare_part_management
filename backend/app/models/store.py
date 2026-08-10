"""Store and Section masters — the two levels the dashboard is organised by.

Deliberately tables rather than a Python list. Part.category is the cautionary
tale: its values live in code behind a CHECK constraint, so adding one needs a
developer and a deploy. Stores and sections are exactly the things that keep
being added — Consumables as a third store, Tool Room / Press Shop / Seat
Slider as sections under Maintenance — so they are rows, and a new card
appears on the dashboard the moment one exists.
"""
from app.extensions import db
from app.models.base import BaseModel

# Seeded on first boot so a fresh install has somewhere to put its parts.
# Everything already loaded is child-part stock, hence that one being default.
DEFAULT_STORE_CODE = "CHILD_PART"
SEED_STORES = [
    {"code": DEFAULT_STORE_CODE, "name": "Child Parts Store", "icon": "📦", "sort_order": 1},
    {"code": "MAINTENANCE", "name": "Spare Parts Store", "icon": "🔧", "sort_order": 2},
]


class Store(BaseModel):
    __tablename__ = "stores"

    code = db.Column(db.String(30), unique=True, nullable=False, index=True)
    name = db.Column(db.String(100), nullable=False)
    # Shown on the dashboard card. Plain text so a new store can be given one
    # without shipping an icon set.
    icon = db.Column(db.String(10), nullable=True)
    description = db.Column(db.String(255), nullable=True)
    sort_order = db.Column(db.Integer, nullable=False, default=100)
    is_active = db.Column(db.Boolean, nullable=False, default=True)

    sections = db.relationship(
        "Section", back_populates="store", cascade="all, delete-orphan",
        order_by="Section.sort_order",
    )

    def to_dict(self):
        return {
            "id": self.id, "code": self.code, "name": self.name,
            "icon": self.icon, "description": self.description,
            "sort_order": self.sort_order, "is_active": self.is_active,
        }

    def __repr__(self):
        return f"<Store {self.code}>"


class Section(BaseModel):
    """An area within a store — Tool Room, Press Shop, Mezzanine. Scoped to
    its store, so two stores can each have a section of the same name without
    colliding."""
    __tablename__ = "sections"

    store_id = db.Column(db.Integer, db.ForeignKey("stores.id"), nullable=False, index=True)
    name = db.Column(db.String(60), nullable=False)
    sort_order = db.Column(db.Integer, nullable=False, default=100)
    is_active = db.Column(db.Boolean, nullable=False, default=True)

    store = db.relationship("Store", back_populates="sections")

    __table_args__ = (
        db.UniqueConstraint("store_id", "name", name="uq_section_store_name"),
    )

    def to_dict(self):
        return {
            "id": self.id, "store_id": self.store_id,
            "store_code": self.store.code if self.store else None,
            "name": self.name, "sort_order": self.sort_order, "is_active": self.is_active,
        }

    def __repr__(self):
        return f"<Section {self.name}>"
