"""Finished Good (customer-facing product) master — parent of the BOM tree
that drives child-part requirement from the SCM forecast."""
from app.extensions import db
from app.models.base import BaseModel


class FinishedGood(BaseModel):
    __tablename__ = "finished_goods"

    fg_no = db.Column(db.String(30), unique=True, nullable=False, index=True)
    fg_name = db.Column(db.String(150), nullable=False)

    def __repr__(self):
        return f"<FinishedGood {self.fg_no} {self.fg_name}>"
