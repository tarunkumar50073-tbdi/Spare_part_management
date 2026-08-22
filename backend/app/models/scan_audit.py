"""Scan audit trail — one row per barcode scan, success or failure.

Every scan across all sources (tablet camera, USB / Bluetooth gun, manual
entry) and every mode (lookup / issue / receive / update-location / history)
lands here through the single shared resolve service, so the store has a
complete record of what was scanned, by whom, when, and whether it resolved.

Deliberately holds no device-identifying or personal data beyond the acting
username — just what is needed for traceability. ``part_id`` is nullable
because a failed/unknown scan has no part to point at. Timestamps come from
``BaseModel.created_at`` (stored UTC; displayed Asia/Kolkata by the frontend).
"""
from app.extensions import db
from app.models.base import BaseModel

# Where the scan physically came from.
SCAN_SOURCES = ("TABLET_CAMERA", "USB_SCANNER", "BLUETOOTH_SCANNER", "MANUAL_ENTRY")
# What the operator was trying to do — the Scan Part screen mode.
SCAN_MODES = ("LOOKUP", "ISSUE", "RECEIVE", "UPDATE_LOCATION", "HISTORY", "MAPPING")
# Outcome of resolving the scanned value.
SCAN_RESULTS = ("SUCCESS", "UNKNOWN_BARCODE", "INACTIVE_BARCODE", "FAILED")


class ScanAudit(BaseModel):
    __tablename__ = "scan_audit"

    # The raw value that was scanned/typed (never altered before lookup, so a
    # supplier code is recorded exactly as read). Indexed for "who scanned X".
    scanned_code = db.Column(db.String(80), nullable=False, index=True)

    # The part it resolved to, or NULL when the scan did not resolve.
    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=True, index=True)

    scan_source = db.Column(db.String(20), nullable=False)
    scan_mode = db.Column(db.String(20), nullable=False)
    result = db.Column(db.String(20), nullable=False, index=True)

    # The acting user (username), or NULL for a machine caller.
    user = db.Column(db.String(60), nullable=True)
    store_code = db.Column(db.String(30), nullable=True, index=True)

    part = db.relationship("Part")

    __table_args__ = (
        db.CheckConstraint(
            f"scan_source IN ({','.join(repr(s) for s in SCAN_SOURCES)})",
            name="ck_scan_audit_source",
        ),
        db.CheckConstraint(
            f"scan_mode IN ({','.join(repr(m) for m in SCAN_MODES)})",
            name="ck_scan_audit_mode",
        ),
        db.CheckConstraint(
            f"result IN ({','.join(repr(r) for r in SCAN_RESULTS)})",
            name="ck_scan_audit_result",
        ),
    )

    def __repr__(self):
        return f"<ScanAudit {self.scanned_code} {self.result} {self.scan_mode}>"
