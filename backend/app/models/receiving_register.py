"""Receiving Register (PO base) — the GRN-level receiving history of a part:
what was received, when, from whom, against which PO/challan, and how much was
accepted vs rejected. One row per GRN-item, matching the ERP "Receiving
Register" report columns.

Used for "part ki history" — search an item and see its full receipt timeline.
ERP is the eventual source; this table carries it now and an ERP sync populates
the same columns later with no caller-side change.
"""
from app.extensions import db
from app.models.base import BaseModel


class ReceivingRegister(BaseModel):
    __tablename__ = "receiving_register"

    store_code = db.Column(db.String(30), nullable=False, default="CHILD_PART", index=True)

    grn_no = db.Column(db.String(60), nullable=True, index=True)
    grn_date = db.Column(db.Date, nullable=True, index=True)
    ven_cd = db.Column(db.String(60), nullable=True, index=True)
    ven_name = db.Column(db.String(150), nullable=True)
    gate_entry_no = db.Column(db.String(60), nullable=True)
    gate_entry_dt = db.Column(db.Date, nullable=True)
    challan_no = db.Column(db.String(60), nullable=True)
    challan_dt = db.Column(db.Date, nullable=True)
    po_no = db.Column(db.String(60), nullable=True)
    item_cd = db.Column(db.String(60), nullable=True, index=True)
    item_desc = db.Column(db.String(255), nullable=True)
    challan_qty = db.Column(db.Numeric(14, 2), nullable=True)
    receipt_qty = db.Column(db.Numeric(14, 2), nullable=True)
    accept_qty = db.Column(db.Numeric(14, 2), nullable=True)
    reject_qty = db.Column(db.Numeric(14, 2), nullable=True)

    def to_dict(self):
        num = lambda v: float(v) if v is not None else None  # noqa: E731
        return {
            "id": self.id, "store_code": self.store_code,
            "grn_no": self.grn_no, "grn_date": self.grn_date.isoformat() if self.grn_date else None,
            "ven_cd": self.ven_cd, "ven_name": self.ven_name,
            "gate_entry_no": self.gate_entry_no,
            "gate_entry_dt": self.gate_entry_dt.isoformat() if self.gate_entry_dt else None,
            "challan_no": self.challan_no, "challan_dt": self.challan_dt.isoformat() if self.challan_dt else None,
            "po_no": self.po_no, "item_cd": self.item_cd, "item_desc": self.item_desc,
            "challan_qty": num(self.challan_qty), "receipt_qty": num(self.receipt_qty),
            "accept_qty": num(self.accept_qty), "reject_qty": num(self.reject_qty),
        }

    def __repr__(self):
        return f"<ReceivingRegister {self.grn_no} · {self.item_cd}>"
