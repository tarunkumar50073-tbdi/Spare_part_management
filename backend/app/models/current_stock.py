"""Current Stock — ERP's real on-hand per item: closing stock plus what's under
receiving and under inspection. One row per item, matching the ERP "Current
Stock" report columns. This is the highest-value mirror: it is the ERP on-hand
that the ERP-vs-Physical gap should reconcile against. ERP-fed; stable shape.
"""
from app.extensions import db
from app.models.base import BaseModel


class CurrentStock(BaseModel):
    __tablename__ = "current_stock"

    store_code = db.Column(db.String(30), nullable=False, default="CHILD_PART", index=True)

    group_cd = db.Column(db.String(60), nullable=True)
    group_name = db.Column(db.String(150), nullable=True)
    item_cd = db.Column(db.String(60), nullable=True, index=True)
    reference_code = db.Column(db.String(60), nullable=True)
    item_desc = db.Column(db.String(255), nullable=True)
    uom = db.Column(db.String(20), nullable=True)
    closing_stock = db.Column(db.Numeric(14, 2), nullable=True)
    under_recv = db.Column(db.Numeric(14, 2), nullable=True)
    under_insp = db.Column(db.Numeric(14, 2), nullable=True)
    total = db.Column(db.Numeric(14, 2), nullable=True)

    def to_dict(self):
        num = lambda v: float(v) if v is not None else None  # noqa: E731
        return {
            "id": self.id, "store_code": self.store_code,
            "group_cd": self.group_cd, "group_name": self.group_name,
            "item_cd": self.item_cd, "reference_code": self.reference_code, "item_desc": self.item_desc,
            "uom": self.uom, "closing_stock": num(self.closing_stock),
            "under_recv": num(self.under_recv), "under_insp": num(self.under_insp), "total": num(self.total),
        }

    def __repr__(self):
        return f"<CurrentStock {self.item_cd} · {self.total}>"
