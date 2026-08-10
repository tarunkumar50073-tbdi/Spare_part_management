"""BOM data access layer."""
from app.models.bom import BOM
from app.repositories.base_repository import BaseRepository


class BOMRepository(BaseRepository):
    model = BOM

    def list_all(self):
        return self.model.query.order_by(self.model.id.desc()).all()

    def list_by_child_part(self, part_id):
        return self.model.query.filter_by(child_part_id=part_id).all()

    def get_by_fg_and_part(self, finished_good_id, child_part_id):
        return self.model.query.filter_by(
            finished_good_id=finished_good_id, child_part_id=child_part_id
        ).first()
