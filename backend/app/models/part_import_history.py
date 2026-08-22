"""Part-master Excel import history — one row per committed import run.

Records who imported what file, when, and the outcome counts (inserted /
updated / failed), so a temporary Excel-driven master has an audit trail until
Oracle ERP becomes the source. Timestamps are BaseModel.created_at (UTC stored,
Asia/Kolkata displayed).
"""
from app.extensions import db
from app.models.base import BaseModel


class PartImportHistory(BaseModel):
    __tablename__ = "part_import_history"

    filename = db.Column(db.String(255), nullable=True)
    store_code = db.Column(db.String(30), nullable=True, index=True)
    total_rows = db.Column(db.Integer, nullable=False, default=0)
    inserted = db.Column(db.Integer, nullable=False, default=0)
    updated = db.Column(db.Integer, nullable=False, default=0)
    failed = db.Column(db.Integer, nullable=False, default=0)
    imported_by = db.Column(db.String(60), nullable=True)

    def __repr__(self):
        return f"<PartImportHistory {self.filename} +{self.inserted}/~{self.updated}/x{self.failed}>"
