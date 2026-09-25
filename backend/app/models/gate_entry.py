"""Gate Entry — a vehicle/material arriving at the gate. Powers window-time
(when a vehicle came in vs its scheduled window) and "material kab aaya" (an
item's arrival history). One row per gate-entry item, matching the ERP "Gate
Entry" report columns. ERP-fed; the shape is stable for a later sync.
"""
from app.extensions import db
from app.models.base import BaseModel


class GateEntry(BaseModel):
    __tablename__ = "gate_entries"

    store_code = db.Column(db.String(30), nullable=False, default="CHILD_PART", index=True)

    gate_entry_no = db.Column(db.String(60), nullable=True, index=True)
    gate_entry_dt = db.Column(db.Date, nullable=True, index=True)
    gate_entry_time = db.Column(db.String(20), nullable=True)
    ven_cd = db.Column(db.String(60), nullable=True, index=True)
    ven_name = db.Column(db.String(150), nullable=True)
    bill_no = db.Column(db.String(60), nullable=True)
    bill_date = db.Column(db.Date, nullable=True)
    po_no = db.Column(db.String(60), nullable=True)
    item_code = db.Column(db.String(60), nullable=True, index=True)
    reference_code = db.Column(db.String(60), nullable=True)
    item_desc = db.Column(db.String(255), nullable=True)
    qty = db.Column(db.Numeric(14, 2), nullable=True)
    hsn = db.Column(db.String(30), nullable=True)

    # A part's arrivals are matched case-insensitively (upper(item_code) =
    # part_no), which the plain item_code index cannot serve.
    __table_args__ = (
        db.Index("ix_gate_entries_item_code_upper", db.func.upper(item_code)),
    )

    def to_dict(self):
        return {
            "id": self.id, "store_code": self.store_code,
            "gate_entry_no": self.gate_entry_no,
            "gate_entry_dt": self.gate_entry_dt.isoformat() if self.gate_entry_dt else None,
            "gate_entry_time": self.gate_entry_time,
            "ven_cd": self.ven_cd, "ven_name": self.ven_name,
            "bill_no": self.bill_no, "bill_date": self.bill_date.isoformat() if self.bill_date else None,
            "po_no": self.po_no, "item_code": self.item_code,
            "reference_code": self.reference_code, "item_desc": self.item_desc,
            "qty": float(self.qty) if self.qty is not None else None, "hsn": self.hsn,
        }

    def __repr__(self):
        return f"<GateEntry {self.gate_entry_no} · {self.item_code}>"
