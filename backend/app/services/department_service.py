"""Department master — the departments the spare store serves and the e-mail
each one's reorder notifications are sent to. The reorder notifier reads its
recipient list straight off this master (repo.reorder_recipients)."""
from app.repositories.department_repository import DepartmentRepository
from app.utils.exceptions import BadRequestError, NotFoundError


class DepartmentService:
    def __init__(self):
        self.repo = DepartmentRepository()

    def list_departments(self, active_only=False):
        return [d.to_dict() for d in self.repo.list_all(active_only=active_only)]

    def create_department(self, data):
        data = self._normalise(data)
        if self.repo.get_by_name(data["name"]):
            raise BadRequestError(f"Department '{data['name']}' already exists")
        return self.repo.create(**data).to_dict()

    def update_department(self, dept_id, data):
        dept = self.repo.get_by_id(dept_id)
        if not dept:
            raise NotFoundError(f"Department {dept_id} not found")
        data = self._normalise(data)
        # A rename must not collide with a different department.
        new_name = data.get("name")
        if new_name and new_name != dept.name and self.repo.get_by_name(new_name):
            raise BadRequestError(f"Department '{new_name}' already exists")
        return self.repo.update(dept, **data).to_dict()

    @staticmethod
    def _normalise(data):
        """Trim the name and turn a blank e-mail into a real NULL, so "cleared"
        and "never set" look the same in the DB rather than leaving an empty
        string the notifier would treat as an address."""
        data = dict(data)
        if data.get("name") is not None:
            data["name"] = data["name"].strip()
        if "email" in data:
            data["email"] = (data["email"] or "").strip() or None
        return data
