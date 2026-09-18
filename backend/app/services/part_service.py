"""Part master business logic."""
from app.extensions import db
from app.models.part import Part, CATEGORIES
from app.repositories.part_repository import PartRepository
from app.repositories.supplier_repository import SupplierRepository
from app.services.live_stock_service import LiveStockService
from app.utils.exceptions import NotFoundError, ConflictError
from app.utils.excel_io import bulk_import, build_template, build_export, to_number, to_text

# Normalized (upper, no space/dash/slash) input -> canonical CATEGORIES value,
# so an Excel cell like "Maintenance / Tool Room" or "in parts" still matches.
CATEGORY_ALIASES = {c.upper().replace(" ", "").replace("-", "").replace("/", ""): c for c in CATEGORIES}

FIELD_ALIASES = {
    "part_no": {"partno", "partnumber"},
    "part_name": {"partname", "description"},
    "uom": {"uom", "unit", "unitofmeasure"},
    "barcode": {"barcode", "qrcode", "scancode"},
    "part_type": {"parttype", "routing", "materialrouting"},
    "min_stock_level": {"minstocklevel", "minstock", "min"},
    "reorder_level": {"reorder", "reorderlevel", "reorderpoint", "reorderqty", "reoder", "reoderlevel"},
    "max_stock_level": {"maxstocklevel", "maxstock", "max"},
    "category": {"category"},
    "sub_category": {"subcategory"},
    "new_part_no": {"newpartno", "newpartnumber"},
    "old_part_no": {"oldpartno", "oldpartnumber", "referencecode"},
    "package_standard": {"packagestandard", "packgstnd", "packingstandard"},
    "supplier_code": {"suppliercode", "vendorcode"},
    "daily_consumption": {"dailyconsumption", "consumption", "dailyconsumptionqty"},
    "unit_price": {"unitprice", "rate", "price"},
    # The two fields the Spare Parts Store is organised around — its dashboard
    # groups by the rack parsed out of location and flags rework parts by
    # rework_location. Neither had a way in before, so the only way to set them
    # was the one-off loader script.
    "location": {"location", "storelocation", "binlocation", "shelf"},
    "rework_location": {"reworklocation", "reworkloc", "reworkshelf"},
}
REQUIRED_FIELDS = ["part_no", "part_name"]

TEMPLATE_COLUMNS = [
    "Part No", "Part Name", "UOM", "Barcode", "Part Type (DOL/OTHER)", "Min Stock Level", "Reorder Level", "Max Stock Level",
    "Category (BOP/Import/Maintenance-Tool Room/Consumable/In-Parts)", "Sub Category", "New Part No", "Old Part No", "Package Standard",
    "Supplier Code", "Daily Consumption", "Unit Price", "Location", "Rework Location",
]

EXPORT_COLUMNS = [
    ("Part No", "part_no"), ("Part Name", "part_name"), ("UOM", "uom"), ("Barcode", "barcode"),
    ("Part Type", "part_type"), ("Min Stock Level", "min_stock_level"),
    ("Reorder Level", "reorder_level"), ("Max Stock Level", "max_stock_level"), ("Status", "status_label"),
    ("Category", "category"), ("Sub Category", "sub_category"),
    ("New Part No", "new_part_no"), ("Old Part No", "old_part_no"), ("Package Standard", "package_standard"),
    ("Supplier Code", "supplier_code"), ("Daily Consumption", "daily_consumption"), ("Unit Price", "unit_price"),
    ("Location", "location"), ("Rework Location", "rework_location"), ("Store", "store_code"),
]


class PartService:
    def __init__(self):
        self.repo = PartRepository()
        self.supplier_repo = SupplierRepository()

    def list_parts(self, keyword=None, is_active=None, store_code=None, section_id=None, missing=None):
        return self.repo.search(
            keyword=keyword, is_active=is_active,
            store_code=store_code, section_id=section_id, missing=missing,
        )

    def count_missing(self, store_code=None, is_active=None):
        return self.repo.count_missing(store_code=store_code, is_active=is_active)

    def derive_component_types(self, store_code, only_missing=True, dry_run=False):
        """Auto-fill each spare's sub_category (component type: Sensor / Cylinder
        / Pilot Pin / Punch …) from its description. `only_missing` leaves parts
        that already carry a sub_category alone; `dry_run` previews the counts
        without writing. Reports the distribution + a sample of the parts nothing
        matched (pure catalog codes a human still has to look at)."""
        from collections import Counter
        from app.utils.db_tx import atomic
        from app.utils.part_category import derive_component_type

        parts = self.repo.get_active(store_code)
        dist = Counter()
        to_set = []
        uncategorised = []
        for p in parts:
            if only_missing and (p.sub_category or "").strip():
                dist["(already set)"] += 1
                continue
            component = derive_component_type(p.part_name)
            if component is None:
                dist["(uncategorised)"] += 1
                if len(uncategorised) < 15:
                    uncategorised.append(p.part_no)
                continue
            dist[component] += 1
            if p.sub_category != component:
                to_set.append((p, component))

        if not dry_run and to_set:
            with atomic():
                for p, component in to_set:
                    self.repo.update(p, sub_category=component)

        matched = sum(v for k, v in dist.items() if not k.startswith("("))
        return {
            "store_code": store_code,
            "dry_run": dry_run,
            "total_parts": len(parts),
            "matched": matched,
            "updated": 0 if dry_run else len(to_set),
            "would_update": len(to_set) if dry_run else None,
            "distribution": dict(dist.most_common()),
            "uncategorised_sample": uncategorised,
        }

    def get(self, part_id):
        part = self.repo.get_by_id(part_id)
        if not part:
            raise NotFoundError(f"Part {part_id} not found")
        return part

    def create(self, data):
        if self.repo.get_by_part_no(data["part_no"]):
            raise ConflictError(f"Part no {data['part_no']} already exists")
        part = self.repo.create(**data)
        LiveStockService.invalidate_rows_cache()
        return part

    def update(self, part_id, data):
        part = self.get(part_id)
        updated = self.repo.update(part, **data)
        # cov_days / rack columns in the cached Live Stock rows depend on
        # Part fields (daily_consumption, category, etc.) — drop the cache so
        # they don't read stale for the TTL after an edit (audit finding M-3).
        LiveStockService.invalidate_rows_cache()
        return updated

    def delete(self, part_id):
        part = self.get(part_id)
        self.repo.delete(part)
        LiveStockService.invalidate_rows_cache()

    def bulk_import_excel(self, file_stream, store_code=None, section_id=None,
                          user=None, filename=None, sheet_name=None):
        """Upsert by Part No — creates new parts, updates fields on existing
        ones (e.g. bulk-setting daily_consumption/category for an already-
        loaded part master), rather than rejecting duplicates outright.

        store_code/section_id stamp NEW rows with the store the file was
        uploaded from, so a spares list imported from inside the Spare Parts
        Store does not land with store_code = NULL and vanish from every
        dashboard. An existing part keeps the store it already has — an import
        is for filling fields in, not for moving parts between stores.

        Reports a granular outcome (inserted / updated / failed) and records the
        run in the import history. Missing parts are never auto-deleted.
        """
        stats = {"inserted": 0, "updated": 0}

        def row_processor(raw_row):
            part_no = to_text(raw_row.get("part_no"))
            if not part_no:
                raise ValueError("Part No is required")

            existing = self.repo.get_by_part_no(part_no)
            category_raw = to_text(raw_row.get("category"), "").upper().replace(" ", "").replace("-", "").replace("/", "")
            category = CATEGORY_ALIASES.get(category_raw)
            supplier_code = to_text(raw_row.get("supplier_code"))
            supplier = self.supplier_repo.get_by_vendor_code(supplier_code) if supplier_code else None

            # min/max belong in here, not only on the Part(...) below. They
            # were update-only-for-new-rows, so the intended way to fill the
            # spares store's 298 missing maximums — export, type the Max
            # column, re-import — reported "N rows imported" and changed
            # nothing at all. Every other field on this dict was already
            # updatable; these two were simply left out.
            fields = {
                "uom": to_text(raw_row.get("uom"), "PCS") or "PCS",
                "barcode": to_text(raw_row.get("barcode"), "") or None,
                "min_stock_level": to_number(raw_row.get("min_stock_level"), None),
                "reorder_level": to_number(raw_row.get("reorder_level"), None),
                "max_stock_level": to_number(raw_row.get("max_stock_level"), None),
                "category": category,
                "sub_category": to_text(raw_row.get("sub_category"), "") or None,
                "new_part_no": to_text(raw_row.get("new_part_no"), "") or None,
                "old_part_no": to_text(raw_row.get("old_part_no"), "") or None,
                "package_standard": to_number(raw_row.get("package_standard"), None),
                "supplier_id": supplier.id if supplier else None,
                "daily_consumption": to_number(raw_row.get("daily_consumption"), None),
                "unit_price": to_number(raw_row.get("unit_price"), None),
                "location": to_text(raw_row.get("location"), "") or None,
                "rework_location": to_text(raw_row.get("rework_location"), "") or None,
            }

            if existing:
                # A blank cell leaves the field alone rather than clearing it.
                # That is this importer's rule for every other field, and the
                # safer half of the choice: someone exporting 485 rows to fix
                # forty maximums must not silently wipe the other 445 by
                # leaving their columns untouched. Clearing a value stays a
                # deliberate act — do it on the screen, not by omission.
                for key, value in fields.items():
                    if value is not None:
                        setattr(existing, key, value)
                stats["updated"] += 1
                return

            part_name = to_text(raw_row.get("part_name"))
            if not part_name:
                raise ValueError("Part Name is required")
            part_type = to_text(raw_row.get("part_type"), "OTHER").upper()
            if part_type not in ("DOL", "OTHER", "TOOL_ROOM"):
                part_type = "OTHER"

            new_fields = dict(fields)
            # min_stock_level is NOT NULL on the model, so a new row with a
            # blank Min column needs the column default rather than None.
            if new_fields["min_stock_level"] is None:
                new_fields["min_stock_level"] = 0

            db.session.add(Part(
                part_no=part_no,
                part_name=part_name,
                part_type=part_type,
                store_code=store_code,
                section_id=section_id,
                **new_fields,
            ))
            stats["inserted"] += 1

        report = bulk_import(file_stream, FIELD_ALIASES, REQUIRED_FIELDS, row_processor, sheet_name)
        LiveStockService.invalidate_rows_cache()
        report["inserted"] = stats["inserted"]
        report["updated"] = stats["updated"]
        report["failed"] = report.get("error_count", 0)
        report["skipped"] = 0
        # Record the run (a temporary-master audit trail until ERP is the source).
        from app.models.part_import_history import PartImportHistory
        hist = PartImportHistory(
            filename=filename, store_code=store_code, imported_by=user,
            total_rows=report.get("total_rows", 0),
            inserted=stats["inserted"], updated=stats["updated"],
            failed=report.get("error_count", 0),
        )
        db.session.add(hist)
        db.session.commit()
        report["history_id"] = hist.id
        return report

    def preview_import(self, file_stream, sheet_name=None):
        """Dry-run: parse + validate the file and return the planned action for
        every row (INSERT / UPDATE / ERROR) WITHOUT writing anything. Detects
        duplicate Part No. within the same file. Lets the user confirm before
        committing (spec §2)."""
        from app.utils.excel_io import read_rows, AmbiguousSheetError
        from app.utils.exceptions import BadRequestError
        try:
            rows = list(read_rows(file_stream, FIELD_ALIASES, REQUIRED_FIELDS, sheet_name))
        except AmbiguousSheetError as exc:
            raise BadRequestError(str(exc), errors={"sheets": exc.sheet_names}) from exc
        except ValueError as exc:
            raise BadRequestError(str(exc)) from exc

        counts = {"insert": 0, "update": 0, "error": 0}
        preview = []
        seen = {}
        for row_no, raw in rows:
            part_no = to_text(raw.get("part_no"))
            part_name = to_text(raw.get("part_name"))
            action, reason = "INSERT", None
            if not part_no:
                action, reason = "ERROR", "Part No is required"
            elif part_no in seen:
                action, reason = "ERROR", f"Duplicate Part No in file (first at row {seen[part_no]})"
            elif self.repo.get_by_part_no(part_no):
                action = "UPDATE"
            elif not part_name:
                action, reason = "ERROR", "Part Name is required for a new part"
            if part_no and part_no not in seen:
                seen[part_no] = row_no
            counts[action.lower()] += 1
            preview.append({"row": row_no, "part_no": part_no, "part_name": part_name,
                            "action": action, "reason": reason})
        return {"total_rows": len(rows), "counts": counts, "rows": preview}

    def import_history(self, limit=50):
        from app.models.part_import_history import PartImportHistory
        q = PartImportHistory.query.order_by(
            PartImportHistory.created_at.desc(), PartImportHistory.id.desc())
        if limit:
            q = q.limit(limit)
        return [{
            "id": h.id, "filename": h.filename, "store_code": h.store_code,
            "total_rows": h.total_rows, "inserted": h.inserted, "updated": h.updated,
            "failed": h.failed, "imported_by": h.imported_by,
            "at": h.created_at.isoformat() if h.created_at else None,
        } for h in q.all()]

    @staticmethod
    def build_template():
        return build_template(TEMPLATE_COLUMNS)

    def export_all(self, store_code=None):
        """The whole master, or one store's slice of it. Scoped because the
        export is the input to the import: a Spare Parts keeper filling in
        maximums should get 485 rows to work through, not 739 with the child
        parts mixed in."""
        query = self.repo.get_all()
        if store_code:
            query = query.filter(Part.store_code == store_code)
        rows = []
        for part in query.order_by(Part.part_no.asc()).all():
            rows.append({
                "part_no": part.part_no, "part_name": part.part_name, "uom": part.uom,
                "barcode": part.barcode or "",
                "part_type": part.part_type,
                "min_stock_level": float(part.min_stock_level or 0),
                "reorder_level": float(part.reorder_level) if part.reorder_level is not None else "",
                "max_stock_level": float(part.max_stock_level) if part.max_stock_level is not None else "",
                "status_label": "Active" if part.is_active else "Inactive",
                "category": part.category or "", "sub_category": part.sub_category or "",
                "new_part_no": part.new_part_no or "", "old_part_no": part.old_part_no or "",
                "package_standard": float(part.package_standard) if part.package_standard is not None else "",
                "supplier_code": part.supplier.vendor_code if part.supplier else "",
                "daily_consumption": float(part.daily_consumption) if part.daily_consumption is not None else "",
                "unit_price": float(part.unit_price) if part.unit_price is not None else "",
                "location": part.location or "",
                "rework_location": part.rework_location or "",
                "store_code": part.store_code or "",
            })
        return build_export(EXPORT_COLUMNS, rows)
