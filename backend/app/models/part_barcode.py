"""Barcodes mapped to a spare part.

DX Store's own internal Code-128 label is the default/primary barcode for every
spare — its payload is only the stable internal Part No. (e.g. CNTR2025), never
any description/price/stock. Most spares arrive with no supplier barcode, so the
internal label is the norm; where a supplier barcode IS available, unique and
readable, an admin may map it to the same internal part here.

Why a table rather than the single ``Part.barcode`` column: a part can carry
one primary internal barcode AND several supplier barcodes, each of which must
resolve to the same internal Part No. ``Part.barcode`` stays as a cheap lookup
fallback (and older data), but this table is the authoritative mapping. A code
value is globally unique (one barcode → one part); duplicate mappings are
blocked by the unique constraint plus a service-level check that returns 409.
Deactivated mappings are kept (``is_active=False``) for history, never deleted.
"""
from app.extensions import db
from app.models.base import BaseModel

# INTERNAL = DX Store's own Code-128 label (payload = Part No.). SUPPLIER = a
# barcode printed by the vendor that an admin has mapped to this part.
BARCODE_SOURCES = ("INTERNAL", "SUPPLIER")
# Code-128 is the internal default; supplier labels may be other symbologies.
SYMBOLOGIES = ("CODE128", "EAN13", "EAN8", "UPC", "QR", "OTHER")


class PartBarcode(BaseModel):
    __tablename__ = "part_barcodes"

    part_id = db.Column(db.Integer, db.ForeignKey("parts.id"), nullable=False, index=True)

    # The scannable value. Globally unique: one barcode value maps to exactly
    # one internal part (spec rule). For an INTERNAL row this equals the Part No.
    code = db.Column(db.String(80), nullable=False, unique=True, index=True)

    symbology = db.Column(db.String(20), nullable=False, default="CODE128")

    # INTERNAL (our label) vs SUPPLIER (a vendor's barcode mapped in by an admin).
    source = db.Column(db.String(20), nullable=False, default="INTERNAL")

    # Only meaningful for SUPPLIER rows — which vendor the barcode came from.
    supplier_id = db.Column(db.Integer, db.ForeignKey("suppliers.id"), nullable=True)

    # One primary barcode per part (the internal one). Supplier mappings are
    # secondary and never replace the internal Part No.
    is_primary = db.Column(db.Boolean, nullable=False, default=False)

    # Deactivated (damaged/duplicated/unsuitable) mappings stay as history.
    is_active = db.Column(db.Boolean, nullable=False, default=True)

    created_by = db.Column(db.String(60), nullable=True)

    part = db.relationship("Part")
    supplier = db.relationship("Supplier")

    __table_args__ = (
        db.CheckConstraint(
            f"source IN ({','.join(repr(s) for s in BARCODE_SOURCES)})",
            name="ck_part_barcode_source",
        ),
    )

    def __repr__(self):
        return f"<PartBarcode {self.code} part={self.part_id} {self.source}>"
