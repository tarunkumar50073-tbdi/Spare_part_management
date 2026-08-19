"""Report Recipient master business logic — mirrors DepartmentService."""
from app.models.report_recipient import ROLES
from app.repositories.report_recipient_repository import ReportRecipientRepository
from app.utils.exceptions import BadRequestError, NotFoundError


class ReportRecipientService:
    def __init__(self):
        self.repo = ReportRecipientRepository()

    def list_recipients(self, report_key=None, active_only=False):
        return [r.to_dict() for r in self.repo.list_all(report_key=report_key, active_only=active_only)]

    def create_recipient(self, data):
        return self.repo.create(**self._normalise(data)).to_dict()

    def update_recipient(self, rid, data):
        row = self.repo.get_by_id(rid)
        if not row:
            raise NotFoundError(f"Report recipient {rid} not found")
        return self.repo.update(row, **self._normalise(data)).to_dict()

    @staticmethod
    def _normalise(data):
        """Trim text, upper-case + validate the role, and turn a blank e-mail
        into a real NULL so 'cleared' and 'never set' look the same in the DB."""
        data = dict(data)
        if data.get("name") is not None:
            data["name"] = data["name"].strip()
        if data.get("report_key") is not None:
            data["report_key"] = data["report_key"].strip()
        if data.get("role") is not None:
            data["role"] = data["role"].strip().upper()
            if data["role"] not in ROLES:
                raise BadRequestError("Role must be TO or CC")
        if "email" in data:
            data["email"] = (data["email"] or "").strip() or None
        return data
