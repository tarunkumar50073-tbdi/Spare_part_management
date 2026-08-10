"""Milkrun grouping business logic — which suppliers share one route's
vehicle (e.g. Milkrun Manesar = 3 suppliers, Milkrun Faridabad = 4
suppliers, each its own separate vehicle)."""
from app.repositories.milkrun_group_repository import MilkrunGroupRepository, SupplierMilkrunMappingRepository
from app.repositories.supplier_repository import SupplierRepository
from app.utils.exceptions import NotFoundError, BadRequestError


class MilkrunGroupService:
    def __init__(self):
        self.repo = MilkrunGroupRepository()
        self.mapping_repo = SupplierMilkrunMappingRepository()
        self.supplier_repo = SupplierRepository()

    def _enrich_group(self, group):
        d = group.to_dict()
        members = self.mapping_repo.list_by_group(group.id)
        d["suppliers"] = [
            {"vendor_code": m.vendor_code, "supplier_name": s.supplier_name if (s := self.supplier_repo.get_by_vendor_code(m.vendor_code)) else None}
            for m in members
        ]
        d["supplier_count"] = len(members)
        return d

    def list_all(self, status=None):
        return [self._enrich_group(g) for g in self.repo.list_all(status=status)]

    def get(self, group_id):
        group = self.repo.get_by_id(group_id)
        if not group:
            raise NotFoundError(f"Milkrun group {group_id} not found")
        return group

    def create(self, data):
        group = self.repo.create(**data)
        return self._enrich_group(group)

    def update(self, group_id, data):
        group = self.get(group_id)
        group = self.repo.update(group, **data)
        return self._enrich_group(group)

    def delete(self, group_id):
        group = self.get(group_id)
        self.repo.delete(group)

    def assign_supplier(self, vendor_code, milkrun_group_id):
        if not self.supplier_repo.get_by_vendor_code(vendor_code):
            raise BadRequestError(f"Unknown vendor code: {vendor_code}")
        if not self.repo.get_by_id(milkrun_group_id):
            raise NotFoundError(f"Milkrun group {milkrun_group_id} not found")
        existing = self.mapping_repo.get_by_vendor_code(vendor_code)
        if existing:
            existing.milkrun_group_id = milkrun_group_id
            existing.status = "Active"
            from app.extensions import db
            db.session.commit()
            return existing
        return self.mapping_repo.create(vendor_code=vendor_code, milkrun_group_id=milkrun_group_id)

    def unassign_supplier(self, vendor_code):
        existing = self.mapping_repo.get_by_vendor_code(vendor_code)
        if existing:
            self.mapping_repo.delete(existing)

    def get_arrival_vendor_codes(self, vendor_code):
        """The vendor_code's own code, widened to its whole active milkrun
        group's codes if it belongs to one — shared by SupplierVehicleService
        and the Window Schedule's today-status view so both treat a
        milkrun-grouped supplier's arrival the same way (whichever grouped
        supplier's ERP line lands first counts for the whole group)."""
        mapping = self.mapping_repo.get_by_vendor_code(vendor_code)
        if not mapping or mapping.status != "Active":
            return [vendor_code]
        siblings = self.mapping_repo.list_by_group(mapping.milkrun_group_id)
        return [m.vendor_code for m in siblings if m.status == "Active"] or [vendor_code]

    def get_group_map(self):
        """{vendor_code: {group_code, group_name}} — one query, for
        enriching other pages (e.g. Supplier Window Schedule) without N+1."""
        mapping = self.mapping_repo.map_by_vendor_code()
        groups = {g.id: g for g in self.repo.list_all()}
        return {
            vendor_code: {"group_code": groups[m.milkrun_group_id].group_code, "group_name": groups[m.milkrun_group_id].group_name}
            for vendor_code, m in mapping.items() if m.milkrun_group_id in groups
        }
