"""Consumption month-over-month / YoY comparison (Phase C2)."""
from app.extensions import db
from app.models.part import Part
from app.models.spare_stock import SpareStockLedger
from app.services.spare_stock_service import SpareStockService

STORE = "MAINTENANCE"


def test_consumption_comparison_shape_and_current(app):
    part = Part(part_no="CC-CMP-1", part_name="Cmp Part", uom="PCS", part_type="OTHER", store_code=STORE)
    db.session.add(part)
    db.session.commit()
    db.session.add(SpareStockLedger(part_id=part.id, qty_delta=-7, balance_after=0, txn_type="ISSUE"))
    db.session.commit()

    svc = SpareStockService()
    # The issue shows up in the monthly series (whichever month it lands in).
    assert any(m["value"] >= 7 for m in svc.monthly_consumption(STORE, months=15))

    c = svc.consumption_comparison(STORE)
    assert set(c) == {"current", "previous", "year_ago"}
    assert isinstance(c["current"]["value"], float)
    for k in ("previous", "year_ago"):
        assert "change_pct" in c[k]  # None when the baseline month had no issues
