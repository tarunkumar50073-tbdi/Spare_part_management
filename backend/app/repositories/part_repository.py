"""Part master data access layer."""
import re

from sqlalchemy import case, func
from sqlalchemy.orm import joinedload
from app.extensions import db
from app.models.part import Part
from app.models.supplier import Supplier
from app.repositories.base_repository import BaseRepository
from app.utils.bin_location import strip_scan_description


def rack_of(column):
    """The rack in a location, as the store reads it: the text before the first
    "-", trimmed ("R4-S1-B1 (1)" -> "R4"; "OLD STORE" -> "OLD STORE") — the
    same rule as rackOf() on the store's own screens (MaintenanceStore.jsx)."""
    loc = func.coalesce(column, "")
    return func.trim(func.substr(loc, 1, func.instr(loc + "-", "-") - 1))


def _rack_order(rack):
    """R1, R2 ... R15 in number order, then the named places A-Z."""
    m = re.fullmatch(r"R(\d+)", rack.upper())
    return (0, int(m.group(1)), "") if m else (1, 0, rack.upper())


class PartRepository(BaseRepository):
    model = Part

    def get_by_part_no(self, part_no):
        # Case-insensitive: a part number typed/scanned in lower case (cntr2025)
        # must still resolve CNTR2025. Surrounding whitespace is trimmed.
        if not part_no:
            return None
        return self.model.query.filter(
            func.lower(self.model.part_no) == part_no.strip().lower()).first()

    def get_by_barcode(self, barcode):
        if not barcode:
            return None
        return self.model.query.filter(
            func.lower(self.model.barcode) == barcode.strip().lower()).first()

    def get_by_scan_code(self, code):
        """Scan-match a part by its dedicated barcode first, falling back to
        part_no — parts without a distinct barcode label still scan correctly.
        Both lookups are case-insensitive.

        A printed label QR can carry MORE than the code: the bin sheet encodes
        "PartNo Location", and the old lot tag "GateEntryNo PartNo" (no longer
        printed since 17 Oct 2026 — paper waste — but tags already on material
        still get scanned). So if the whole scan doesn't match, try each
        whitespace-separated token too — the part-no / barcode token resolves,
        the gate-no / location one is ignored. This lets the issue flow,
        put-away and every scan screen read a bin-sheet or lot-tag QR, not just
        a bare part number.

        Since 17 Oct 2026 the bin sheet QR ends in " | description"
        (utils/bin_location): the tokens are taken from the text BEFORE it only,
        so a word of the description can never resolve some other part."""
        code = (code or "").strip()
        if not code:
            return None
        hit = self.get_by_barcode(code) or self.get_by_part_no(code)
        if hit:
            return hit
        core = strip_scan_description(code)
        if core != code:
            hit = self.get_by_barcode(core) or self.get_by_part_no(core)
            if hit:
                return hit
        tokens = core.split()
        if len(tokens) > 1:
            for tok in tokens:
                hit = self.get_by_barcode(tok) or self.get_by_part_no(tok)
                if hit:
                    return hit
        return None

    # "Not set" for these three is a missing value OR a zero/blank — the Spare
    # Parts sheets carry 0 for "no maximum decided" rather than leaving the
    # cell empty. Written to match the store dashboard's own test exactly
    # (Number(max_stock_level || 0) > 0 means planned, MaintenanceStore.jsx),
    # so the chip count and the "still without a maximum" figure cannot
    # disagree — if they ever do, this predicate is the thing that is wrong.
    _MISSING_FILTERS = {
        # A discontinued part needs no maximum: never "missing" one.
        "max": lambda m: ((m.max_stock_level.is_(None)) | (m.max_stock_level == 0)) & (m.discontinued.is_(False)),
        "rate": lambda m: (m.unit_price.is_(None)) | (m.unit_price == 0),
        "location": lambda m: (m.location.is_(None)) | (m.location == ""),
        "photo": lambda m: (m.image_file.is_(None)) | (m.image_file == ""),
    }

    def search(self, keyword=None, is_active=None, store_code=None, section_id=None, missing=None,
               category=None, sub_category=None, rack=None):
        query = self.model.query
        if keyword:
            # Partial match (so a part is found without typing the whole code)
            # across the Part No., its old / new numbers, the description and the
            # supplier (code or name). A left join keeps parts with no supplier.
            like = f"%{keyword.strip()}%"
            query = query.outerjoin(Supplier, self.model.supplier_id == Supplier.id).filter(
                (self.model.part_no.ilike(like))
                | (self.model.part_name.ilike(like))
                | (self.model.specification.ilike(like))
                | (self.model.model_no.ilike(like))
                | (self.model.old_part_no.ilike(like))
                | (self.model.new_part_no.ilike(like))
                | (Supplier.vendor_code.ilike(like))
                | (Supplier.supplier_name.ilike(like))
            )
        if is_active is not None:
            query = query.filter(self.model.is_active == is_active)
        if store_code:
            query = query.filter(self.model.store_code == store_code)
        if section_id:
            query = query.filter(self.model.section_id == section_id)
        # The Part Master's filters (21 Oct 2026): category, sub category (exact,
        # case aside — they are picked from the store's own values) and rack.
        if category:
            query = query.filter(func.lower(self.model.category) == category.strip().lower())
        if sub_category:
            query = query.filter(func.lower(func.trim(self.model.sub_category)) == sub_category.strip().lower())
        if rack:
            query = query.filter(func.upper(rack_of(self.model.location)) == rack.strip().upper())
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

    def filter_options(self, store_code=None, section_id=None, is_active=None):
        """The values the Part Master's filters offer, each with its part count:
        racks (in rack order, each also with how many of its parts still have
        no photo — the Photo Mode works rack by rack), categories and sub
        categories (most parts first). `photos` is the scope's own tally.
        `is_active` narrows them the way the list they filter is narrowed: the
        Photo Mode lists active parts only, so an inactive part counted here made
        its tally read 4,893 against the 4,892 parts shown (23 Oct 2026)."""
        no_photo = self._MISSING_FILTERS["photo"](self.model)

        def grouped(expr):
            q = db.session.query(expr, func.count(self.model.id),
                                 func.sum(case((no_photo, 1), else_=0)))
            if is_active is not None:
                q = q.filter(self.model.is_active == is_active)
            if store_code:
                q = q.filter(self.model.store_code == store_code)
            if section_id:
                q = q.filter(self.model.section_id == section_id)
            # One entry per value, case aside ("Cable" / "cable", "R4" / "r4" —
            # the filters match case-blind too), under its commonest spelling.
            merged = {}
            for v, n, missing in q.group_by(expr).all():
                if v in (None, ""):
                    continue
                spelling, total, best, bare = merged.get(v.upper(), (v, 0, 0, 0))
                merged[v.upper()] = (v if n > best else spelling, total + n, max(best, n), bare + (missing or 0))
            return [(v, n, bare) for v, n, _, bare in merged.values()]

        racks = sorted(grouped(rack_of(self.model.location)), key=lambda r: _rack_order(r[0]))
        cats = sorted(grouped(self.model.category), key=lambda r: (-r[1], r[0]))
        subs = sorted(grouped(func.trim(self.model.sub_category)), key=lambda r: (-r[1], r[0].upper()))
        scope = db.session.query(func.count(self.model.id), func.sum(case((no_photo, 1), else_=0)))
        if is_active is not None:
            scope = scope.filter(self.model.is_active == is_active)
        if store_code:
            scope = scope.filter(self.model.store_code == store_code)
        if section_id:
            scope = scope.filter(self.model.section_id == section_id)
        total, bare = scope.one()
        return {
            "racks": [{"value": v, "count": n, "no_photo": bare} for v, n, bare in racks],
            "categories": [{"value": v, "count": n} for v, n, _ in cats],
            "sub_categories": [{"value": v, "count": n} for v, n, _ in subs],
            "photos": {"total": total or 0, "with_photo": (total or 0) - (bare or 0)},
        }

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
