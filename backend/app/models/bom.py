"""Bill of Materials — how many units of a child Part go into one unit of a
Finished Good. Used to explode the SCM customer forecast into child-part
requirement."""
from app.extensions import db
from app.models.base import BaseModel


class BOM(BaseModel):
    __tablename__ = "boms"

    finished_good_id = db.Column(db.Integer, db.ForeignKey("finished_goods.id"), nullable=False, index=True)
    child_part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)
    qty_per_unit = db.Column(db.Numeric(12, 4), nullable=False)

    finished_good = db.relationship("FinishedGood")
    child_part = db.relationship("Part")

    __table_args__ = (
        db.UniqueConstraint("finished_good_id", "child_part_id", name="uq_bom_fg_part"),
    )

    def __repr__(self):
        return f"<BOM fg={self.finished_good_id} part={self.child_part_id} qty_per={self.qty_per_unit}>"
