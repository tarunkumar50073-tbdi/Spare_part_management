"""Store / Section masters, and the per-store figures the dashboard cards show.

The card counts reuse COVService.is_short and the same excess rule as every
other screen, just scoped to one store — so a store card and the screens
inside it can never disagree about how many parts are short.
"""
from app.repositories.part_repository import PartRepository
from app.repositories.rack_bin_repository import RackBinRepository
from app.repositories.store_repository import SectionRepository, StoreRepository
from app.services.cov_service import COVService
from app.utils.exceptions import BadRequestError, NotFoundError


class StoreService:
    def __init__(self):
        self.repo = StoreRepository()
        self.section_repo = SectionRepository()
        self.part_repo = PartRepository()
        self.rack_bin_repo = RackBinRepository()
        self.cov_service = COVService()

    # ---- masters ----

    def list_stores(self, user=None, with_summary=False):
        """Stores the caller may open. A machine caller (ERP, no user) sees
        all of them; a person sees only what their rights allow."""
        stores = self.repo.list_active()
        if user is not None:
            stores = [s for s in stores if user.can_access_store(s.code)]

        # Sections come with every listing, summary or not: the sidebar draws
        # one nav item per section and asking for them separately would have
        # meant a request per store on every page. They are a cheap row read —
        # it is the summary below that scans the part list.
        def base(store):
            d = store.to_dict()
            d["sections"] = [sec.to_dict() for sec in self.section_repo.list_for_store(store.id)]
            return d

        if not with_summary:
            return [base(s) for s in stores]

        summaries = self._summaries_by_store()
        out = []
        for s in stores:
            d = base(s)
            d["summary"] = summaries.get(s.code, self._empty_summary())
            out.append(d)
        return out

    def get_store(self, code):
        store = self.repo.get_by_code(code)
        if not store:
            raise NotFoundError(f"Store '{code}' not found")
        return store

    def create_store(self, data):
        if self.repo.get_by_code(data["code"]):
            raise BadRequestError(f"Store '{data['code']}' already exists")
        return self.repo.create(**data).to_dict()

    def update_store(self, code, data):
        return self.repo.update(self.get_store(code), **data).to_dict()

    def list_sections(self, store_code):
        """Sections of a store, each carrying the figures its card shows.

        Spares are judged on Min/Max stock, not Coverage Days — nothing here
        is consumed against production — so a section reports how much of its
        list is planned (min/max set) and how much of it moves through rework,
        rather than short/excess counts that would have no basis."""
        store = self.get_store(store_code)
        counts = self.part_repo.count_by_section(store.code)
        parts_by_section = {}
        for part in self.part_repo.search(store_code=store.code, is_active=True).all():
            parts_by_section.setdefault(part.section_id, []).append(part)

        out = []
        for section in self.section_repo.list_for_store(store.id):
            parts = parts_by_section.get(section.id, [])
            d = section.to_dict()
            d["total_parts"] = counts.get(section.id, 0)
            d["with_min_max"] = sum(1 for p in parts if (p.max_stock_level or 0) > 0)
            d["with_rework"] = sum(1 for p in parts if p.rework_location)
            d["locations"] = len({p.location for p in parts if p.location})
            out.append(d)
        return out

    def create_section(self, store_code, data):
        store = self.get_store(store_code)
        if self.section_repo.get_by_name(store.id, data["name"]):
            raise BadRequestError(f"'{data['name']}' already exists in {store.name}")
        return self.section_repo.create(store_id=store.id, **data).to_dict()

    def update_section(self, section_id, data):
        section = self.section_repo.get_by_id(section_id)
        if not section:
            raise NotFoundError(f"Section {section_id} not found")
        return self.section_repo.update(section, **data).to_dict()

    # ---- card figures ----

    @staticmethod
    def _empty_summary():
        return {"total_parts": 0, "short_parts": 0, "excess_parts": 0, "sections": 0}

    def _summaries_by_store(self):
        """One pass over every active part, bucketed by store — cheaper than
        asking each store to scan the part list itself."""
        dead_stock_ids = self.rack_bin_repo.get_dead_stock_part_ids()
        latest_map = self.cov_service.get_latest_map()

        out = {}
        for part in self.part_repo.get_active():
            code = part.store_code
            if not code:
                continue
            bucket = out.setdefault(code, self._empty_summary())
            bucket["total_parts"] += 1
            status = self.cov_service.get_status(part, latest_map=latest_map)
            if self.cov_service.is_short(part, status, dead_stock_ids):
                bucket["short_parts"] += 1
            elif status["basis"] == "COV" and status["indicator"] == "Excess":
                bucket["excess_parts"] += 1

        for store in self.repo.list_active():
            bucket = out.setdefault(store.code, self._empty_summary())
            bucket["sections"] = len(self.section_repo.list_for_store(store.id))
        return out
