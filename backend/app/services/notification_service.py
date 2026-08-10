"""Store-operator notification list — active alerts stay active until the
underlying condition is resolved (see RackAlertService/HoldingService for
what actually resolves each type), plus a manual resolve for operator-
acknowledged ones (e.g. FIFO_VIOLATION_RISK)."""
from app.models.base import utcnow
from app.repositories.notification_repository import NotificationRepository
from app.utils.exceptions import NotFoundError


class NotificationService:
    def __init__(self):
        self.repo = NotificationRepository()

    def list_active(self, type_=None):
        return self.repo.list_active(type_)

    def resolve(self, notification_id):
        row = self.repo.get_by_id(notification_id)
        if not row:
            raise NotFoundError(f"Notification {notification_id} not found")
        return self.repo.update(row, status="RESOLVED", resolved_at=utcnow())

    def create_or_refresh(self, type_, message, part_id=None, holding_entry_id=None):
        """Upserts an ACTIVE notification for (type, part_id) rather than
        spamming duplicates — refreshes the message on the existing row if
        one is already active for this type+part."""
        existing = self.repo.find_active(type_, part_id) if part_id else None
        if existing:
            return self.repo.update(existing, message=message, holding_entry_id=holding_entry_id)
        return self.repo.create(type=type_, part_id=part_id, holding_entry_id=holding_entry_id, message=message, status="ACTIVE")

    def resolve_for_holding_entry(self, holding_entry_id):
        """Called when a HoldingEntry completes — closes out any notification tied to it."""
        for n in self.repo.model.query.filter_by(holding_entry_id=holding_entry_id, status="ACTIVE").all():
            self.repo.update(n, status="RESOLVED", resolved_at=utcnow())

    def resolve_all_for_part(self, part_id, types):
        """Called when a part's Holding Area queue empties out — there's
        nothing left to act on, so every holding-related notification for
        that part (not just the one tied to the completed entry) should
        clear, including ones with no holding_entry_id link (e.g.
        RACK_SPACE_AVAILABLE, which is raised per-part, not per-entry)."""
        for n in self.repo.model.query.filter(
            self.repo.model.part_id == part_id, self.repo.model.type.in_(types), self.repo.model.status == "ACTIVE"
        ).all():
            self.repo.update(n, status="RESOLVED", resolved_at=utcnow())
