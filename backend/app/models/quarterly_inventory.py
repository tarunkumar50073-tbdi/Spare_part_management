"""Quarterly Physical Inventory reconciliation — ERP quantity vs physical
count, uploaded via Excel per Fiscal Year + Quarter (Toyota Boshoku
Inventory Excel format). A fully separate module from Daily Stock Count:
different cadence and purpose — daily count feeds Coverage Day, this is a
periodic ERP-vs-physical audit."""
from app.extensions import db
from app.models.base import BaseModel

QUARTERS = ["Q1", "Q2", "Q3", "Q4"]
INVENTORY_STATUSES = ["MATCH", "SHORT", "EXCESS"]


class QuarterlyInventory(BaseModel):
    __tablename__ = "quarterly_inventory"

    fiscal_year = db.Column(db.String(10), nullable=False, index=True)  # e.g. "2026-27"
    quarter = db.Column(db.String(2), nullable=False, index=True)
    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)

    erp_quantity = db.Column(db.Numeric(12, 2), nullable=False)
    physical_quantity = db.Column(db.Numeric(12, 2), nullable=False)
    status = db.Column(db.String(10), nullable=False)  # MATCH/SHORT/EXCESS, computed at write time

    part = db.relationship("Part")

    __table_args__ = (
        db.UniqueConstraint("fiscal_year", "quarter", "part_id", name="uq_qty_inv_fy_q_part"),
        db.CheckConstraint(f"quarter IN ({','.join(repr(q) for q in QUARTERS)})", name="ck_qty_inv_quarter"),
        db.CheckConstraint(f"status IN ({','.join(repr(s) for s in INVENTORY_STATUSES)})", name="ck_qty_inv_status"),
    )

    def __repr__(self):
        return f"<QuarterlyInventory {self.fiscal_year} {self.quarter} part={self.part_id} {self.status}>"
