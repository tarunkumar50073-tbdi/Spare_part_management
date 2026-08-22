"""Barcode resolve / label / mapping / scan-audit — the shared backend service.

Camera, scanner gun and manual entry all resolve through ONE method here
(``resolve``), so every scan is validated, store-scoped and audited the same
way. The internal barcode payload is only the stable Part No.; all part detail
is fetched from the DB (and, later, ERP) after resolving — never encoded in the
barcode. Nothing here fakes ERP data: stock is reported as MANUAL until an ERP
Current-Stock source lands (see the erp-integration plan).
"""
from datetime import timezone

from app.models.base import utcnow
from app.models.erp_stock import ERPStock
from app.models.part_barcode import SYMBOLOGIES
from app.models.scan_audit import SCAN_MODES, SCAN_SOURCES
from app.repositories.barcode_repository import (
    LabelPrintAuditRepository, PartBarcodeRepository, ScanAuditRepository,
)
from app.repositories.part_repository import PartRepository
from app.repositories.spare_stock_repository import SpareStockRepository
from app.repositories.supplier_repository import SupplierRepository
from app.services.spare_stock_service import SpareStockService
from app.utils.db_tx import atomic
from app.utils.exceptions import (
    BadRequestError, ConflictError, NotFoundError, ValidationError,
)

# An ERP stock snapshot older than this reads as STALE rather than SYNCED.
# 24h suits the hourly ERP poller; a missed sync then shows honestly as stale.
STALE_AFTER_HOURS = 24

# The label template. Configurable — 100mm x 50mm is only the starting default
# because the label-roll size may change; the frontend reads these values rather
# than hardcoding a size. (A later admin-editable template can override these.)
LABEL_DEFAULTS = {
    "width_mm": 100,
    "height_mm": 50,
    "symbology": "CODE128",
    "show_part_no": True,
    "show_description": True,
    "description_max_chars": 48,
}


class BarcodeService:
    def __init__(self):
        self.pb_repo = PartBarcodeRepository()
        self.scan_repo = ScanAuditRepository()
        self.print_repo = LabelPrintAuditRepository()
        self.part_repo = PartRepository()
        self.stock_repo = SpareStockRepository()
        self.supplier_repo = SupplierRepository()
        self.spare_service = SpareStockService()

    # ---- scan resolution (the single shared entry point) ----

    def _audit(self, code, result, scan_source, scan_mode, user, store_code, part_id=None):
        """Record the scan outcome. Committed on its own so a failed scan is
        still traceable even though the request then raises."""
        return self.scan_repo.create(
            scanned_code=code, part_id=part_id, scan_source=scan_source,
            scan_mode=scan_mode, result=result, user=user, store_code=store_code,
        )

    def resolve(self, store_code, code, scan_source="MANUAL_ENTRY",
                scan_mode="LOOKUP", user=None):
        """Resolve a scanned value to a spare part in this store and audit it.

        Order (spec §17): active barcode mapping first, then a direct Part No. /
        Part.barcode fallback. Supplier barcodes live in the mapping table so
        they resolve here too. Every outcome is written to the scan audit.
        """
        if scan_source not in SCAN_SOURCES:
            scan_source = "MANUAL_ENTRY"
        if scan_mode not in SCAN_MODES:
            scan_mode = "LOOKUP"
        # Trim harmless surrounding whitespace only; the value is otherwise used
        # exactly as scanned (a supplier code is never rewritten before lookup).
        code = (code or "").strip()
        if not code:
            self._audit("", "FAILED", scan_source, scan_mode, user, store_code)
            raise BadRequestError("No code scanned")

        mapping = self.pb_repo.get_active_by_code(code)
        part = mapping.part if mapping else self.part_repo.get_by_scan_code(code)

        if part is None:
            # A deactivated mapping for this exact code reads as INACTIVE, not
            # merely unknown — so a damaged/retired label is diagnosable.
            inactive = self.pb_repo.get_by_code(code)
            result = "INACTIVE_BARCODE" if inactive else "UNKNOWN_BARCODE"
            self._audit(code, result, scan_source, scan_mode, user, store_code)
            raise NotFoundError(f"No part found for code '{code}'")

        if part.store_code != store_code:
            # Do not leak another store's part id through this store's scanner.
            self._audit(code, "UNKNOWN_BARCODE", scan_source, scan_mode, user, store_code)
            raise NotFoundError(f"No part in this store for code '{code}'")

        if not part.is_active:
            self._audit(code, "INACTIVE_BARCODE", scan_source, scan_mode, user, store_code, part_id=part.id)
            raise NotFoundError(f"Part '{part.part_no}' is inactive")

        self._audit(code, "SUCCESS", scan_source, scan_mode, user, store_code, part_id=part.id)

        payload = self.spare_service.get_for_part(part.id)
        payload["scanned_code"] = code
        payload["resolved_by"] = mapping.source if mapping else "PART_NO"
        payload["scan_mode"] = scan_mode
        payload.update(self._data_status(part))
        return payload

    def _data_status(self, part):
        """Honest freshness of the stock figure shown — never fakes ERP data:
        - MANUAL: no ERP feed for this part; the store's physical figure is shown.
        - SYNCED: an ERP snapshot exists and was refreshed within STALE_AFTER_HOURS.
        - STALE:  an ERP snapshot exists but is older than that window.
        (LIVE is reserved for a real-time ERP query, which does not exist yet.)
        Also carries the ERP stock-WRITE status so the UI can say whether an
        issue/receive will reflect back in ERP."""
        erp = ERPStock.query.filter_by(part_id=part.id).first()
        last_sync = erp.synced_at if erp else None
        if last_sync is None:
            source, warning = "MANUAL", "ERP live stock not available yet — showing the store's physical figure."
        else:
            aware = last_sync if last_sync.tzinfo else last_sync.replace(tzinfo=timezone.utc)
            age_h = (utcnow() - aware).total_seconds() / 3600.0
            if age_h > STALE_AFTER_HOURS:
                source, warning = "STALE", f"ERP stock is stale — last synced over {STALE_AFTER_HOURS}h ago."
            else:
                source, warning = "SYNCED", None
        return {
            "data_status": {
                "stock_source": source,          # LIVE / SYNCED / MANUAL / STALE
                "erp_available": erp is not None,
                "erp_qty": float(erp.qty_on_hand) if erp and erp.qty_on_hand is not None else None,
                "erp_last_sync": last_sync.isoformat() if last_sync else None,
                "warning": warning,
                "write": self.spare_service.erp_write_status(),
            }
        }

    # ---- internal barcode allocation ----

    def ensure_internal_barcode(self, part, user=None):
        """Guarantee a primary INTERNAL Code-128 barcode exists for the part,
        with the Part No. as its payload. Idempotent."""
        existing = self.pb_repo.primary_internal(part.id)
        if existing:
            if not existing.is_active:
                self.pb_repo.update(existing, is_active=True)
            return existing

        clash = self.pb_repo.get_by_code(part.part_no)
        if clash and clash.part_id != part.id:
            raise ConflictError(
                f"Barcode '{part.part_no}' is already mapped to another part"
            )
        if clash and clash.part_id == part.id:
            return self.pb_repo.update(
                clash, source="INTERNAL", is_primary=True, is_active=True,
                symbology="CODE128", created_by=clash.created_by or user,
            )
        return self.pb_repo.create(
            part_id=part.id, code=part.part_no, symbology="CODE128",
            source="INTERNAL", is_primary=True, is_active=True, created_by=user,
        )

    # ---- label print / reprint ----

    def label_config(self):
        return dict(LABEL_DEFAULTS)

    def record_print(self, part_id, copies=1, user=None, is_reprint=False, reason=None):
        """Record a label print/reprint and return the data the label needs.

        Blocks printing for an inactive part (an admin must reactivate it first,
        per spec). A reprint requires a reason.
        """
        part = self.part_repo.get_by_id(part_id)
        if not part:
            raise NotFoundError(f"Part {part_id} not found")
        if not part.is_active:
            raise ValidationError(
                "Cannot print a label for an inactive part — reactivate it first"
            )
        try:
            copies = int(copies or 1)
        except (TypeError, ValueError):
            raise BadRequestError("copies must be a whole number")
        if copies < 1:
            raise BadRequestError("copies must be at least 1")

        already_printed = self.print_repo.has_any_for_part(part_id)
        effective_reprint = bool(is_reprint) or already_printed
        reason = (reason or "").strip() or None
        if effective_reprint and not reason:
            raise ValidationError("A reprint reason is required")

        with atomic():
            barcode = self.ensure_internal_barcode(part, user=user)
            audit = self.print_repo.create(
                part_id=part.id, barcode_value=barcode.code, copies=copies,
                printed_by=user, is_reprint=effective_reprint, reason=reason,
            )

        return {
            "print_id": audit.id,
            "part_id": part.id,
            "part_no": part.part_no,
            "part_name": part.part_name,
            "barcode_value": barcode.code,
            "symbology": barcode.symbology,
            "copies": copies,
            "is_reprint": effective_reprint,
            "reason": reason,
            "printed_by": user,
            "printed_at": audit.created_at.isoformat() if audit.created_at else None,
        }

    def print_history(self, part_id, limit=50):
        part = self.part_repo.get_by_id(part_id)
        if not part:
            raise NotFoundError(f"Part {part_id} not found")
        return [{
            "id": r.id,
            "barcode_value": r.barcode_value,
            "copies": r.copies,
            "printed_by": r.printed_by,
            "is_reprint": r.is_reprint,
            "reason": r.reason,
            "printed_at": r.created_at.isoformat() if r.created_at else None,
        } for r in self.print_repo.list_for_part(part_id, limit=limit)]

    # ---- scan audit (admin view) ----

    def list_scan_audit(self, store_code=None, result=None, scan_mode=None,
                        scan_source=None, part_id=None, limit=200):
        rows = self.scan_repo.list_filtered(
            store_code=store_code, result=result, scan_mode=scan_mode,
            scan_source=scan_source, part_id=part_id, limit=limit,
        )
        return [{
            "id": r.id,
            "scanned_code": r.scanned_code,
            "part_id": r.part_id,
            "part_no": r.part.part_no if r.part else None,
            "part_name": r.part.part_name if r.part else None,
            "scan_source": r.scan_source,
            "scan_mode": r.scan_mode,
            "result": r.result,
            "user": r.user,
            "store_code": r.store_code,
            "at": r.created_at.isoformat() if r.created_at else None,
        } for r in rows]

    # ---- barcode listing + supplier mapping ----

    def list_part_barcodes(self, part_id):
        part = self.part_repo.get_by_id(part_id)
        if not part:
            raise NotFoundError(f"Part {part_id} not found")
        return [{
            "id": b.id,
            "code": b.code,
            "symbology": b.symbology,
            "source": b.source,
            "supplier_id": b.supplier_id,
            "supplier_name": b.supplier.supplier_name if b.supplier else None,
            "is_primary": b.is_primary,
            "is_active": b.is_active,
            "created_by": b.created_by,
            "created_at": b.created_at.isoformat() if b.created_at else None,
        } for b in self.pb_repo.list_for_part(part_id)]

    def map_supplier_barcode(self, part_id, code, supplier_id=None,
                             symbology="CODE128", user=None):
        """Admin maps a vendor's barcode to an internal part. One code value maps
        to one part only — a duplicate is blocked (409). The internal Part No. is
        never replaced; this is an additional way to reach the same part."""
        part = self.part_repo.get_by_id(part_id)
        if not part:
            raise NotFoundError(f"Part {part_id} not found")
        code = (code or "").strip()
        if not code:
            raise BadRequestError("Supplier barcode value is required")
        if symbology not in SYMBOLOGIES:
            symbology = "OTHER"

        clash = self.pb_repo.get_by_code(code)
        if clash:
            if clash.part_id == part_id and not clash.is_active:
                return self.list_part_barcodes(part_id)  # reactivate path handled separately
            raise ConflictError(
                f"Barcode '{code}' is already mapped"
                + ("" if clash.part_id == part_id else " to another part")
            )
        if supplier_id is not None and not self.supplier_repo.get_by_id(supplier_id):
            raise NotFoundError(f"Supplier {supplier_id} not found")

        self.pb_repo.create(
            part_id=part_id, code=code, symbology=symbology, source="SUPPLIER",
            supplier_id=supplier_id, is_primary=False, is_active=True, created_by=user,
        )
        return self.list_part_barcodes(part_id)

    def set_mapping_active(self, mapping_id, active, user=None):
        mapping = self.pb_repo.get_by_id(mapping_id)
        if not mapping:
            raise NotFoundError(f"Barcode mapping {mapping_id} not found")
        if mapping.source == "INTERNAL" and not active:
            raise ValidationError("The internal barcode cannot be deactivated")
        self.pb_repo.update(mapping, is_active=bool(active))
        return self.list_part_barcodes(mapping.part_id)
