"""Part master data access layer."""
from sqlalchemy import func
from sqlalchemy.orm import joinedload
from app.extensions import db
from app.models.part import Part
from app.repositories.base_repository import BaseRepository


class PartRepository(BaseRepository):
    model = Part

    def get_by_part_no(self, part_no):
        return self.model.query.filter_by(part_no=part_no).first()

    def get_by_barcode(self, barcode):
        return self.model.query.filter_by(barcode=barcode).first()

    def get_by_scan_code(self, code):
        """Scan-match a part by its dedicated barcode first, falling back to
        part_no — parts without a distinct barcode label still scan correctly."""
        return self.get_by_barcode(code) or self.get_by_part_no(code)

    # "Not set" for these three is a missing value OR a zero/blank — the Spare
    # Parts sheets carry 0 for "no maximum decided" rather than leaving the
    # cell empty. Written to match the store dashboard's own test exactly
    # (Number(max_stock_level || 0) > 0 means planned, MaintenanceStore.jsx),
    # so the chip count and the "still without a maximum" figure cannot
    # disagree — if they ever do, this predicate is the thing that is wrong.
    _MISSING_FILTERS = {
        "max": lambda m: (m.max_stock_level.is_(None)) | (m.max_stock_level == 0),
        "rate": lambda m: (m.unit_price.is_(None)) | (m.unit_price == 0),
        "location": lambda m: (m.location.is_(None)) | (m.location == ""),
    }

    def search(self, keyword=None, is_active=None, store_code=None, section_id=None, missing=None):
        query = self.model.query
        if keyword:
            like = f"%{keyword}%"
            query = query.filter(
                (self.model.part_no.ilike(like)) | (self.model.part_name.ilike(like))
            )
        if is_active is not None:
            query = query.filter(self.model.is_active == is_active)
        if store_code:
            query = query.filter(self.model.store_code == store_code)
        if section_id:
            query = query.filter(self.model.section_id == section_id)
        # Applied in SQL rather than to a fetched page: filtering after
        # pagination would leave page 3 of "missing max" holding whatever
        # happened to survive from rows 21-30, and a count that meant nothing.
        predicate = self._MISSING_FILTERS.get(missing)
        if predicate:
            query = query.filter(predicate(self.model))
        return query.order_by(self.model.part_no.asc())

    def count_missing(self, store_code=None, is_active=None):
        """How many parts are short of a max, a rate and a location, plus the
        store's own total — the four chip counts, in one round trip rather than
        four list calls the screen would otherwise throw away.

        `total` is here rather than read off the list response because that
        response is the *filtered* page: with "Missing Max" selected the All
        chip took the filtered total and read "All 293" beside "Missing Max
        293", as though the store had shrunk to the parts it was complaining
        about."""
        def scoped(query):
            if store_code:
                query = query.filter(self.model.store_code == store_code)
            if is_active is not None:
                query = query.filter(self.model.is_active == is_active)
            return query

        out = {"total": scoped(db.session.query(func.count(self.model.id))).scalar() or 0}
        for key, predicate in self._MISSING_FILTERS.items():
            query = db.session.query(func.count(self.model.id)).filter(predicate(self.model))
            out[key] = scoped(query).scalar() or 0
        return out

    def count_by_section(self, store_code):
        """section_id -> active part count, for the store's section cards.
        One grouped query rather than a scan per card."""
        rows = (
            db.session.query(self.model.section_id, func.count(self.model.id))
            .filter(self.model.store_code == store_code, self.model.is_active.is_(True))
            .group_by(self.model.section_id)
            .all()
        )
        return {section_id: count for section_id, count in rows}

    def get_active(self, store_code=None):
        """Active parts, optionally only those belonging to one store.

        The Child Parts screens pass their store code: without it, loading the
        press-shop spares list turned "Total Active Parts" from 253 into 738
        and put stamping pins into the Child Parts live stock."""
        query = self.model.query.options(joinedload(self.model.supplier)).filter_by(is_active=True)
        if store_code:
            query = query.filter(self.model.store_code == store_code)
        return query.order_by(self.model.part_no.asc()).all()
