"""Finished Good master business logic."""
from app.repositories.finished_good_repository import FinishedGoodRepository
from app.utils.exceptions import NotFoundError, ConflictError


class FinishedGoodService:
    def __init__(self):
        self.repo = FinishedGoodRepository()

    def list_all(self):
        return self.repo.list_all()

    def get(self, fg_id):
        fg = self.repo.get_by_id(fg_id)
        if not fg:
            raise NotFoundError(f"Finished Good {fg_id} not found")
        return fg

    def create(self, data):
        if self.repo.get_by_fg_no(data["fg_no"]):
            raise ConflictError(f"Finished Good {data['fg_no']} already exists")
        return self.repo.create(**data)
