"""Part x Supplier breakdown data access layer."""
from sqlalchemy.orm import joinedload
from app.extensions import db
from app.models.part_supplier import PartSupplier
from app.repositories.base_repository import BaseRepository
from app.utils.db_tx import maybe_commit


class PartSupplierRepository(BaseRepository):
    model = PartSupplier

    def list_by_part(self, part_id):
        return self.model.query.filter_by(part_id=part_id).all()

    def map_by_part(self):
        """{part_id: [PartSupplier, ...]} in one query — same batching
        pattern as COVService.get_latest_map(), so callers looping over all
        active parts don't do one query per part."""
        rows = self.model.query.options(joinedload(self.model.supplier)).all()
        out = {}
        for row in rows:
            out.setdefault(row.part_id, []).append(row)
        return out

    def upsert(self, part_id, supplier_id, qty=None, share_pct=None):
        row = self.model.query.filter_by(part_id=part_id, supplier_id=supplier_id).first()
        if row:
            if qty is not None:
                row.qty = qty
            if share_pct is not None:
                row.share_pct = share_pct
        else:
            row = self.model(part_id=part_id, supplier_id=supplier_id, qty=qty, share_pct=share_pct)
            db.session.add(row)
        maybe_commit()
        return row
