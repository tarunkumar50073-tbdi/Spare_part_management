"""Part Search kiosk — the read-only screen on the kiosk outside the spare store
(the store, 25 Oct 2026: "spare store k bahar ki taraf 1 kiosk system lagega
jisme user part search kar sakta h uski availability dekh sakta h with photo ...
only part search kiosk ... read kar sakta h part, photo; read delete nhi").

Only what the shop floor may see of a part: its number, name, specification /
model no., photos, how many are in stock, where it sits and its section ("sabhi
option", 25 Oct 2026) — never a rate, a value, a stock level or a supplier.
Nothing here writes.

Stock reads honestly (28 Oct 2026, the kiosk polish): a part never counted
is "not counted" (qty None), not out of stock; a counted 0 — or a negative,
never shown as stock — is out of stock; material that came in at the gate and
waits for quality (QC_PENDING packets) is said apart, never added to stock.
"""
from sqlalchemy import case, func

from app.extensions import db
from app.models.part import Part
from app.models.spare_packet import SparePacket
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
        old / new Part No., name, category, specification or model no.; a plural
        finds its singular (28 Oct 2026) — an exact Part No. first. Each with its
        stock, place, section and photos."""
        text = " ".join((q or "").split())
        if len(text) < MIN_TEXT:
            return {"rows": [], "total": 0, "page": 1, "pages": 0, "q": text}
        page = max(1, int(page or 1))
        per_page = max(1, min(int(per_page or PER_PAGE), MAX_PER_PAGE))
        fields = (Part.part_no, Part.old_part_no, Part.new_part_no, Part.part_name, Part.sub_category,
                  Part.specification, Part.model_no)
        query = (db.session.query(Part, SpareStock.qty_on_hand, Section.name)
                 .outerjoin(SpareStock, SpareStock.part_id == Part.id)
                 .outerjoin(Section, Section.id == Part.section_id)
                 .filter(Part.store_code == store_code, Part.is_active.is_(True)))
        from app.utils.word_search import word_filters
        query = query.filter(*word_filters(fields, text))
        total = query.count()
        exact = case((func.upper(Part.part_no) == text.upper(), 0), else_=1)
        rows = (query.order_by(exact, func.length(Part.part_no), Part.part_no)
                .offset((page - 1) * per_page).limit(per_page).all())
        qc = self._qc_pending([part.id for part, _, _ in rows])
        return {
            "rows": [self._row(part, qty, section, qc.get(part.id, 0)) for part, qty, section in rows],
            "total": total, "page": page, "pages": -(-total // per_page), "q": text,
        }

    @staticmethod
    def _qc_pending(part_ids):
        """{part id: qty} labelled at the gate and still waiting for quality —
        not stock yet (spare_packets QC_PENDING)."""
        if not part_ids:
            return {}
        return {pid: _num(total) for pid, total in
                db.session.query(SparePacket.part_id, func.sum(SparePacket.qty))
                .filter(SparePacket.part_id.in_(part_ids), SparePacket.status == "QC_PENDING")
                .group_by(SparePacket.part_id) if total}

    @staticmethod
    def _row(part, qty, section, qc_pending=0):
        counted = qty is not None
        qty = max(_num(qty), 0) if counted else None          # a negative is never shown as stock
        return {
            "id": part.id, "part_no": part.part_no, "part_name": part.part_name,
            "specification": part.specification, "model_no": part.model_no, "uom": part.uom,
            "location": part.location, "rework_location": part.rework_location, "section": section,
            "qty": qty, "counted": counted, "available": bool(counted and qty > 0),
            "qc_pending": qc_pending, "discontinued": bool(part.discontinued),
            "image_file": part.image_file, "photos": part.photo_files,
        }
