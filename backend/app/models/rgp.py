"""Pending RGP (Returnable Gate Pass) — returnable material sent out on a
challan and not yet fully returned. One row per pending challan-item, matching
the ERP "Pending RGP" report columns. Balance Qty > 0 means it is still out.

ERP is the eventual source of truth; this table exists now so the store can
carry the report and the Live Dashboard can show a real Pending-RGP count, and
an ERP sync can populate the same columns later with no caller-side change.
"""
from datetime import date

from app.extensions import db
from app.models.base import BaseModel


class RGP(BaseModel):
    __tablename__ = "rgps"

    # Which store the gate pass belongs to (Child Parts by default).
    store_code = db.Column(db.String(30), nullable=False, default="CHILD_PART", index=True)

    ven_cd = db.Column(db.String(60), nullable=True, index=True)
    ven_name = db.Column(db.String(150), nullable=True)
    challan_no = db.Column(db.String(60), nullable=True, index=True)
    challan_dt = db.Column(db.Date, nullable=True)
    challan_type = db.Column(db.String(60), nullable=True)
    resp_loc_name = db.Column(db.String(150), nullable=True)
    resp_emp = db.Column(db.String(60), nullable=True)
    resp_emp_name = db.Column(db.String(150), nullable=True)
    target_dt = db.Column(db.Date, nullable=True)
    item_cd = db.Column(db.String(60), nullable=True, index=True)
    item_desc = db.Column(db.String(255), nullable=True)
    challan_qty = db.Column(db.Numeric(14, 2), nullable=True)
    receipt_qty = db.Column(db.Numeric(14, 2), nullable=True)
    balance_qty = db.Column(db.Numeric(14, 2), nullable=True, index=True)
    pend_days = db.Column(db.Integer, nullable=True)

    @property
    def pending_days(self):
        """Use the stored Pend Days; fall back to days since the challan date."""
        if self.pend_days is not None:
            return self.pend_days
        if self.challan_dt:
            return (date.today() - self.challan_dt).days
        return None

    def to_dict(self):
        num = lambda v: float(v) if v is not None else None  # noqa: E731
        return {
            "id": self.id, "store_code": self.store_code,
            "ven_cd": self.ven_cd, "ven_name": self.ven_name,
            "challan_no": self.challan_no,
            "challan_dt": self.challan_dt.isoformat() if self.challan_dt else None,
            "challan_type": self.challan_type,
            "resp_loc_name": self.resp_loc_name,
            "resp_emp": self.resp_emp, "resp_emp_name": self.resp_emp_name,
            "target_dt": self.target_dt.isoformat() if self.target_dt else None,
            "item_cd": self.item_cd, "item_desc": self.item_desc,
            "challan_qty": num(self.challan_qty), "receipt_qty": num(self.receipt_qty),
            "balance_qty": num(self.balance_qty), "pend_days": self.pending_days,
        }

    def __repr__(self):
        return f"<RGP {self.challan_no} · {self.item_cd}>"
