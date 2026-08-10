"""Quarterly Inventory data access layer."""
from app.extensions import db
from app.models.quarterly_inventory import QuarterlyInventory
from app.repositories.base_repository import BaseRepository


class QuarterlyInventoryRepository(BaseRepository):
    model = QuarterlyInventory

    def search(self, fiscal_year=None, quarter=None, status=None):
        query = self.model.query
        if fiscal_year:
            query = query.filter(self.model.fiscal_year == fiscal_year)
        if quarter:
            query = query.filter(self.model.quarter == quarter)
        if status:
            query = query.filter(self.model.status == status)
        return query

    def upsert(self, fiscal_year, quarter, part_id, erp_quantity, physical_quantity, status):
        row = self.model.query.filter_by(fiscal_year=fiscal_year, quarter=quarter, part_id=part_id).first()
        if row:
            row.erp_quantity = erp_quantity
            row.physical_quantity = physical_quantity
            row.status = status
        else:
            row = self.model(
                fiscal_year=fiscal_year, quarter=quarter, part_id=part_id,
                erp_quantity=erp_quantity, physical_quantity=physical_quantity, status=status,
            )
            db.session.add(row)
        return row

    def list_fiscal_years(self):
        rows = self.model.query.with_entities(self.model.fiscal_year).distinct().order_by(self.model.fiscal_year.asc()).all()
        return [r[0] for r in rows]

    def list_quarters(self, fiscal_year):
        rows = self.model.query.filter_by(fiscal_year=fiscal_year).with_entities(self.model.quarter).distinct().all()
        return sorted({r[0] for r in rows})
