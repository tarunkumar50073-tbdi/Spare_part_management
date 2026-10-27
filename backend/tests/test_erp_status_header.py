"""The header's "Last ERP data" pill: when ERP data last arrived — the newest of
ERP's old stock push (erp_stock, silent since 10 Aug 2026) and the ERP mirror
sync, which rewrites the GRN register every run. On 27 Oct 2026 the header
still said 10 Aug while GRNs arrived daily."""
from datetime import date, datetime, timedelta, timezone

from app.extensions import db
from app.models.receiving_register import ReceivingRegister
from app.services.store_dashboard_service import StoreDashboardService


def test_last_erp_data_is_the_newest_erp_sync_not_the_old_stock_push():
    before = StoreDashboardService().get_last_erp_sync()
    row = ReceivingRegister(store_code="CHILD_PART", grn_no="GRN-HDR-1", grn_date=date(2026, 10, 27),
                            item_cd="HDR-1", receipt_qty=1, accept_qty=1)
    db.session.add(row)
    db.session.commit()
    latest = datetime.fromisoformat(StoreDashboardService().get_last_erp_sync())
    assert abs(latest - datetime.now(timezone.utc)) < timedelta(minutes=5)
    assert before is None or datetime.fromisoformat(before) <= latest
