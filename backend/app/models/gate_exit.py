"""Gate Exit — a vehicle leaving the gate (out-time). With Gate Entry it gives a
vehicle's turnaround and completes window in/out tracking. One row per gate-exit
challan, matching the ERP "Gate Exit" report columns. ERP-fed; stable shape.
"""
from app.extensions import db
from app.models.base import BaseModel


class GateExit(BaseModel):
    __tablename__ = "gate_exits"

    store_code = db.Column(db.String(30), nullable=False, default="CHILD_PART", index=True)

    challan_number = db.Column(db.String(60), nullable=True, index=True)
    unit_code = db.Column(db.String(60), nullable=True)
    challan_date = db.Column(db.Date, nullable=True)
    challan_type = db.Column(db.String(60), nullable=True)
    gate_exit_number = db.Column(db.String(60), nullable=True, index=True)
    gate_exit_date = db.Column(db.Date, nullable=True, index=True)
    gate_exit_time = db.Column(db.String(20), nullable=True)
    party_code = db.Column(db.String(60), nullable=True)
    party_name = db.Column(db.String(150), nullable=True)
    vehicle_number = db.Column(db.String(40), nullable=True, index=True)

    def to_dict(self):
        return {
            "id": self.id, "store_code": self.store_code,
            "challan_number": self.challan_number, "unit_code": self.unit_code,
            "challan_date": self.challan_date.isoformat() if self.challan_date else None,
            "challan_type": self.challan_type,
            "gate_exit_number": self.gate_exit_number,
            "gate_exit_date": self.gate_exit_date.isoformat() if self.gate_exit_date else None,
            "gate_exit_time": self.gate_exit_time,
            "party_code": self.party_code, "party_name": self.party_name,
            "vehicle_number": self.vehicle_number,
        }

    def __repr__(self):
        return f"<GateExit {self.gate_exit_number} · {self.vehicle_number}>"
