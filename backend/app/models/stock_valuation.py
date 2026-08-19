"""Stock Valuation (Std. Rate) — the item-wise stock movement ledger: opening,
received, issued and closing per transaction. One row per transaction, matching
the ERP "Stock Valuation (Std. Rate)" report columns. ERP-fed; stable shape.
"""
from app.extensions import db
from app.models.base import BaseModel


class StockValuation(BaseModel):
    __tablename__ = "stock_valuation"

    store_code = db.Column(db.String(30), nullable=False, default="CHILD_PART", index=True)

    item_cd = db.Column(db.String(60), nullable=True, index=True)
    item_desc = db.Column(db.String(255), nullable=True)
    uom = db.Column(db.String(20), nullable=True)
    tran_dt = db.Column(db.Date, nullable=True, index=True)
    doc_no = db.Column(db.String(60), nullable=True)
    doc_type = db.Column(db.String(60), nullable=True)
    doc_source_name = db.Column(db.String(150), nullable=True)
    tran_type = db.Column(db.String(60), nullable=True)
    opening_stock = db.Column(db.Numeric(14, 2), nullable=True)
    recv_qty = db.Column(db.Numeric(14, 2), nullable=True)
    issue_qty = db.Column(db.Numeric(14, 2), nullable=True)
    closing_stock = db.Column(db.Numeric(14, 2), nullable=True)

    def to_dict(self):
        num = lambda v: float(v) if v is not None else None  # noqa: E731
        return {
            "id": self.id, "store_code": self.store_code,
            "item_cd": self.item_cd, "item_desc": self.item_desc, "uom": self.uom,
            "tran_dt": self.tran_dt.isoformat() if self.tran_dt else None,
            "doc_no": self.doc_no, "doc_type": self.doc_type,
            "doc_source_name": self.doc_source_name, "tran_type": self.tran_type,
            "opening_stock": num(self.opening_stock), "recv_qty": num(self.recv_qty),
            "issue_qty": num(self.issue_qty), "closing_stock": num(self.closing_stock),
        }

    def __repr__(self):
        return f"<StockValuation {self.item_cd} · {self.tran_dt}>"
