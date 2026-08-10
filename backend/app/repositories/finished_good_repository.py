"""Finished Good master data access layer."""
from app.models.finished_good import FinishedGood
from app.repositories.base_repository import BaseRepository


class FinishedGoodRepository(BaseRepository):
    model = FinishedGood

    def get_by_fg_no(self, fg_no):
        return self.model.query.filter_by(fg_no=fg_no).first()

    def get_or_create(self, fg_no, fg_name):
        fg = self.get_by_fg_no(fg_no)
        if not fg:
            return self.create(fg_no=fg_no, fg_name=fg_name)
        if fg_name and fg.fg_name != fg_name:
            fg.fg_name = fg_name
            from app.utils.db_tx import maybe_commit
            maybe_commit()
        return fg

    def list_all(self):
        return self.model.query.order_by(self.model.fg_no.asc()).all()
