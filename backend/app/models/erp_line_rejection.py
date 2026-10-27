"""ERP's line rejection slips (termsdb.line_rejection_report), read only — the
store asked on 27 Oct 2026 that every ERP table the app can read comes in, up
to date. One row per ERP row (erp_id); each read replaces the copy. Mostly
child parts; the spare store sees its own parts' slips on Short & Rejection."""
from app.extensions import db
from app.models.base import BaseModel


class ErpLineRejection(BaseModel):
    __tablename__ = "erp_line_rejections"

    erp_id = db.Column(db.Integer, nullable=False, unique=True)
    return_slip_no = db.Column(db.String(40), nullable=True, index=True)
    return_slip_date = db.Column(db.Date, nullable=True, index=True)
    return_slip_time = db.Column(db.String(10), nullable=True)
    ref_doc_no = db.Column(db.String(60), nullable=True)
    item_cd = db.Column(db.String(40), nullable=True, index=True)
    item_desc = db.Column(db.String(255), nullable=True)
    uom = db.Column(db.String(20), nullable=True)
    return_qty = db.Column(db.Numeric(14, 2), nullable=True)
    return_from_loc = db.Column(db.String(20), nullable=True)
    return_from_name = db.Column(db.String(80), nullable=True)
    party_cd = db.Column(db.String(40), nullable=True)
    party_name = db.Column(db.String(160), nullable=True)
    challan_no = db.Column(db.String(60), nullable=True)
    challan_dt = db.Column(db.String(20), nullable=True)
    synced_at = db.Column(db.DateTime(timezone=True), nullable=True)
