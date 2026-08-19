"""Pending GRN For Inspection — material received (GRN made) but still pending
inspection. One row per pending GRN-item, matching the ERP report columns.
ERP-fed; stable shape. A count of these feeds the receiving-pipeline view.
"""
from app.extensions import db
from app.models.base import BaseModel


class PendingGRN(BaseModel):
    __tablename__ = "pending_grn"

    store_code = db.Column(db.String(30), nullable=False, default="CHILD_PART", index=True)

    ven_cd = db.Column(db.String(60), nullable=True, index=True)
    ven_name = db.Column(db.String(150), nullable=True)
    grn_no = db.Column(db.String(60), nullable=True, index=True)
    grn_dt = db.Column(db.Date, nullable=True)
    grn_location = db.Column(db.String(150), nullable=True)
    item_cd = db.Column(db.String(60), nullable=True, index=True)
    item_desc = db.Column(db.String(255), nullable=True)
    receipt_qty = db.Column(db.Numeric(14, 2), nullable=True)
    uom = db.Column(db.String(20), nullable=True)
    pending_days = db.Column(db.Integer, nullable=True)

    def to_dict(self):
        return {
            "id": self.id, "store_code": self.store_code,
            "ven_cd": self.ven_cd, "ven_name": self.ven_name,
            "grn_no": self.grn_no, "grn_dt": self.grn_dt.isoformat() if self.grn_dt else None,
            "grn_location": self.grn_location, "item_cd": self.item_cd, "item_desc": self.item_desc,
            "receipt_qty": float(self.receipt_qty) if self.receipt_qty is not None else None,
            "uom": self.uom, "pending_days": self.pending_days,
        }

    def __repr__(self):
        return f"<PendingGRN {self.grn_no} · {self.item_cd}>"
