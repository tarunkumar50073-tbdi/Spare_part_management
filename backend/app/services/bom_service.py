"""BOM (Finished Good -> child Part qty-per-unit) business logic. Creating a
BOM line auto-creates the Finished Good if it's new, so the SCM forecast
upload and this master can both drive off the same fg_no."""
from app.extensions import db
from app.models.bom import BOM
from app.repositories.bom_repository import BOMRepository
from app.repositories.finished_good_repository import FinishedGoodRepository
from app.repositories.part_repository import PartRepository
from app.utils.exceptions import NotFoundError, ConflictError, BadRequestError
from app.utils.excel_io import bulk_import, build_template, build_export, to_number, to_text

FIELD_ALIASES = {
    "fg_no": {"finishedgoodno", "fgno"},
    "fg_name": {"finishedgoodname", "fgname"},
    "part_no": {"partno", "childpartno"},
    "qty_per_unit": {"qtyperunit", "qty", "quantity"},
}
REQUIRED_FIELDS = ["fg_no", "part_no", "qty_per_unit"]

TEMPLATE_COLUMNS = ["Finished Good No", "Finished Good Name", "Part No", "Qty per Unit"]

EXPORT_COLUMNS = [
    ("Finished Good No", "fg_no"), ("Finished Good Name", "fg_name"),
    ("Part No", "part_no"), ("Part Name", "part_name"), ("Qty per Unit", "qty_per_unit"),
]


class BOMService:
    def __init__(self):
        self.repo = BOMRepository()
        self.fg_repo = FinishedGoodRepository()
        self.part_repo = PartRepository()

    def list_all(self):
        return [self._enrich(b) for b in self.repo.list_all()]

    def get(self, bom_id):
        bom = self.repo.get_by_id(bom_id)
        if not bom:
            raise NotFoundError(f"BOM line {bom_id} not found")
        return bom

    def create(self, data):
        fg = self.fg_repo.get_or_create(data["fg_no"], data.get("fg_name") or data["fg_no"])
        part = self.part_repo.get_by_part_no(data["part_no"])
        if not part:
            raise BadRequestError(f"Unknown part no: {data['part_no']}")
        if self.repo.get_by_fg_and_part(fg.id, part.id):
            raise ConflictError(f"BOM line for {fg.fg_no} / {part.part_no} already exists")
        bom = self.repo.create(finished_good_id=fg.id, child_part_id=part.id, qty_per_unit=data["qty_per_unit"])
        return self._enrich(bom)

    def update(self, bom_id, data):
        bom = self.get(bom_id)
        bom = self.repo.update(bom, qty_per_unit=data["qty_per_unit"])
        return self._enrich(bom)

    def delete(self, bom_id):
        bom = self.get(bom_id)
        self.repo.delete(bom)

    def bulk_import_excel(self, file_stream):
        seen_pairs = set()

        def row_processor(raw_row):
            fg_no = to_text(raw_row.get("fg_no"))
            if not fg_no:
                raise ValueError("Finished Good No is required")
            part_no = to_text(raw_row.get("part_no"))
            if not part_no:
                raise ValueError("Part No is required")
            pair_key = (fg_no, part_no)
            if pair_key in seen_pairs:
                raise ValueError(f"Duplicate BOM line in file: {fg_no}/{part_no}")
            seen_pairs.add(pair_key)

            part = self.part_repo.get_by_part_no(part_no)
            if not part:
                raise ValueError(f"Unknown Part No: {part_no}")

            qty_per_unit = to_number(raw_row.get("qty_per_unit"))
            if qty_per_unit is None:
                raise ValueError("Qty per Unit is required")

            fg = self.fg_repo.get_or_create(fg_no, to_text(raw_row.get("fg_name")) or fg_no)
            if self.repo.get_by_fg_and_part(fg.id, part.id):
                raise ValueError(f"BOM line already exists: {fg_no}/{part_no}")

            db.session.add(BOM(finished_good_id=fg.id, child_part_id=part.id, qty_per_unit=qty_per_unit))

        return bulk_import(file_stream, FIELD_ALIASES, REQUIRED_FIELDS, row_processor)

    @staticmethod
    def build_template():
        return build_template(TEMPLATE_COLUMNS)

    def export_all(self):
        return build_export(EXPORT_COLUMNS, self.list_all())

    @staticmethod
    def _enrich(bom):
        d = bom.to_dict()
        d["fg_no"] = bom.finished_good.fg_no
        d["fg_name"] = bom.finished_good.fg_name
        d["part_no"] = bom.child_part.part_no
        d["part_name"] = bom.child_part.part_name
        return d
