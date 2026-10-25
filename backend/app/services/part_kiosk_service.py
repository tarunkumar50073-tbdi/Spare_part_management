"""Part Search kiosk — the read-only screen on the kiosk outside the spare store
(the store, 25 Oct 2026: "spare store k bahar ki taraf 1 kiosk system lagega
jisme user part search kar sakta h uski availability dekh sakta h with photo ...
only part search kiosk ... read kar sakta h part, photo; read delete nhi").

Only what the shop floor may see of a part: its number, name, specification /
model no., photos, how many are in stock, where it sits and its section ("sabhi
option", 25 Oct 2026) — never a rate, a value, a stock level or a supplier.
Nothing here writes.
"""
from sqlalchemy import case, func, or_

from app.extensions import db
from app.models.part import Part
from app.models.spare_stock import SpareStock
from app.models.store import Section

MIN_TEXT = 2
PER_PAGE, MAX_PER_PAGE = 24, 60


def _num(value):
    if value is None:
        return 0
    value = float(value)
    return int(value) if value.is_integer() else round(value, 2)


class PartKioskService:

    def search(self, store_code, q, page=1, per_page=PER_PAGE):
        """The store's active parts matching every typed word — in the Part No.,
        old / new Part No., name, specification or model no. — an exact Part No.
        first. Each with its stock, place, section and photos."""
        text = " ".join((q or "").split())
        if len(text) < MIN_TEXT:
            return {"rows": [], "total": 0, "page": 1, "pages": 0, "q": text}
        page = max(1, int(page or 1))
        per_page = max(1, min(int(per_page or PER_PAGE), MAX_PER_PAGE))
        fields = (Part.part_no, Part.old_part_no, Part.new_part_no, Part.part_name, Part.specification, Part.model_no)
        query = (db.session.query(Part, SpareStock.qty_on_hand, Section.name)
                 .outerjoin(SpareStock, SpareStock.part_id == Part.id)
                 .outerjoin(Section, Section.id == Part.section_id)
                 .filter(Part.store_code == store_code, Part.is_active.is_(True)))
        for word in text.split()[:6]:
            like = f"%{word}%"
            query = query.filter(or_(*(f.ilike(like) for f in fields)))
        total = query.count()
        exact = case((func.upper(Part.part_no) == text.upper(), 0), else_=1)
        rows = (query.order_by(exact, func.length(Part.part_no), Part.part_no)
                .offset((page - 1) * per_page).limit(per_page).all())
        return {
            "rows": [self._row(part, qty, section) for part, qty, section in rows],
            "total": total, "page": page, "pages": -(-total // per_page), "q": text,
        }

    @staticmethod
    def _row(part, qty, section):
        qty = _num(qty)
        return {
            "id": part.id, "part_no": part.part_no, "part_name": part.part_name,
            "specification": part.specification, "model_no": part.model_no, "uom": part.uom,
            "location": part.location, "rework_location": part.rework_location, "section": section,
            "qty": qty, "available": qty > 0, "discontinued": bool(part.discontinued),
            "image_file": part.image_file, "photos": part.photo_files,
        }
