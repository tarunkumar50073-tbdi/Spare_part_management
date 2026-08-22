"""Data access for barcode mappings, scan audit and label-print audit.

Query-only concerns for the barcode module; business rules (duplicate blocking,
resolve fallback order, audit-on-every-scan) live in BarcodeService.
"""
from app.models.part_barcode import PartBarcode
from app.models.scan_audit import ScanAudit
from app.models.label_print_audit import LabelPrintAudit
from app.repositories.base_repository import BaseRepository


class PartBarcodeRepository(BaseRepository):
    model = PartBarcode

    def get_by_code(self, code):
        """Any mapping for this exact code (active or not) — used to block
        duplicates and to detect a deactivated code on scan."""
        return self.model.query.filter_by(code=code).first()

    def get_active_by_code(self, code):
        return self.model.query.filter_by(code=code, is_active=True).first()

    def list_for_part(self, part_id):
        return (
            self.model.query.filter_by(part_id=part_id)
            .order_by(self.model.is_primary.desc(), self.model.source.asc(), self.model.id.asc())
            .all()
        )

    def primary_internal(self, part_id):
        return self.model.query.filter_by(
            part_id=part_id, source="INTERNAL", is_primary=True
        ).first()


class ScanAuditRepository(BaseRepository):
    model = ScanAudit

    def list_filtered(self, store_code=None, result=None, scan_mode=None,
                      scan_source=None, part_id=None, since=None, until=None, limit=200):
        q = self.model.query
        if store_code:
            q = q.filter(self.model.store_code == store_code)
        if result:
            q = q.filter(self.model.result == result)
        if scan_mode:
            q = q.filter(self.model.scan_mode == scan_mode)
        if scan_source:
            q = q.filter(self.model.scan_source == scan_source)
        if part_id:
            q = q.filter(self.model.part_id == part_id)
        if since:
            q = q.filter(self.model.created_at >= since)
        if until:
            q = q.filter(self.model.created_at <= until)
        q = q.order_by(self.model.created_at.desc(), self.model.id.desc())
        if limit:
            q = q.limit(limit)
        return q.all()


class LabelPrintAuditRepository(BaseRepository):
    model = LabelPrintAudit

    def list_for_part(self, part_id, limit=50):
        q = (
            self.model.query.filter_by(part_id=part_id)
            .order_by(self.model.created_at.desc(), self.model.id.desc())
        )
        if limit:
            q = q.limit(limit)
        return q.all()

    def has_any_for_part(self, part_id):
        return self.model.query.filter_by(part_id=part_id).first() is not None
