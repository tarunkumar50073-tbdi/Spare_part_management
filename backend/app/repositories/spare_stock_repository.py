"""Spare on-hand stock and its movement ledger — data access only."""
from sqlalchemy import func
from sqlalchemy.orm import joinedload

from app.extensions import db
from app.models.part import Part
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.repositories.base_repository import BaseRepository


class SpareStockRepository(BaseRepository):
    model = SpareStock

    def get_by_part(self, part_id):
        return self.model.query.filter_by(part_id=part_id).first()

    def get_or_create(self, part_id):
        """A part with no row has never been counted, which is not the same as
        having none — but every movement needs somewhere to land, so the row is
        created at the moment of the first one."""
        row = self.get_by_part(part_id)
        if not row:
            row = self.model(part_id=part_id, qty_on_hand=0)
            db.session.add(row)
            db.session.flush()
        return row

    def map_by_part(self, store_code=None):
        """part_id -> qty on hand. One query for a whole dashboard rather than
        a lookup per part."""
        query = db.session.query(self.model.part_id, self.model.qty_on_hand)
        if store_code:
            query = query.join(Part, Part.id == self.model.part_id).filter(Part.store_code == store_code)
        return {part_id: float(qty or 0) for part_id, qty in query.all()}

    def list_for_store(self, store_code, section_id=None, only_counted=False, section_ids=None):
        """Parts of a store with their stock row attached, left-joined so parts
        that have never been counted still appear — they are the ones someone
        most needs to see.

        section_ids (a set/list) scopes to several sections at once — a section
        group like Tool Room (= Press Tool Room + General Tool Room); it takes
        precedence over the single section_id. Neither given = the whole store."""
        query = (
            db.session.query(Part, self.model)
            .outerjoin(self.model, self.model.part_id == Part.id)
            .filter(Part.store_code == store_code, Part.is_active.is_(True))
        )
        if section_ids:
            query = query.filter(Part.section_id.in_(list(section_ids)))
        elif section_id:
            query = query.filter(Part.section_id == section_id)
        if only_counted:
            query = query.filter(self.model.id.isnot(None))
        return query.order_by(Part.part_no.asc()).all()

    def count_counted(self, store_code):
        return (
            db.session.query(func.count(self.model.id))
            .join(Part, Part.id == self.model.part_id)
            .filter(Part.store_code == store_code, Part.is_active.is_(True))
            .scalar() or 0
        )


class SpareStockLedgerRepository(BaseRepository):
    model = SpareStockLedger

    def list_for_part(self, part_id, limit=25):
        return (
            self.model.query.filter_by(part_id=part_id)
            .order_by(self.model.created_at.desc(), self.model.id.desc())
            .limit(limit).all()
        )

    def list_for_store_between(self, store_code, since, until=None):
        """Ledger rows in a window — what a shift received and issued. Joined
        to Part so one store's movements never include the other's."""
        query = (
            self.model.query.options(joinedload(self.model.part))
            .join(Part, Part.id == self.model.part_id)
            .filter(Part.store_code == store_code, self.model.created_at >= since)
        )
        if until:
            query = query.filter(self.model.created_at < until)
        return query.order_by(self.model.created_at.asc()).all()

    def recent_for_store(self, store_code, limit=20):
        return (
            self.model.query.options(joinedload(self.model.part))
            .join(Part, Part.id == self.model.part_id)
            .filter(Part.store_code == store_code)
            .order_by(self.model.created_at.desc(), self.model.id.desc())
            .limit(limit).all()
        )
