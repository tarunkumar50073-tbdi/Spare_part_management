"""Report Recipient master data access."""
from app.models.report_recipient import ReportRecipient
from app.repositories.base_repository import BaseRepository


class ReportRecipientRepository(BaseRepository):
    model = ReportRecipient

    def list_all(self, report_key=None, active_only=False):
        q = self.model.query
        if report_key:
            q = q.filter_by(report_key=report_key)
        if active_only:
            q = q.filter_by(is_active=True)
        # TO before CC (role desc), then sort_order/name — a stable, readable order.
        return q.order_by(self.model.report_key.asc(), self.model.role.desc(),
                          self.model.sort_order.asc(), self.model.name.asc()).all()

    def recipients_for(self, report_key):
        """The exact (to, cc) address lists the mailer will use for a report:
        active recipients that carry an address, TO and CC split out. A row with
        no address is silently skipped (never mailed to an empty string)."""
        active = [r for r in self.list_all(report_key=report_key, active_only=True) if (r.email or "").strip()]
        to = [r.email.strip() for r in active if r.role == "TO"]
        cc = [r.email.strip() for r in active if r.role == "CC"]
        return to, cc
