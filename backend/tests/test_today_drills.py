"""The two 'today' tiles open the rows behind them: Today Added to Stock lists
today's RECEIPT rows (with where the stock-in came from and the supplier) and
Today Issued its ISSUE rows — each list ties out to its card."""
from app.extensions import db
from app.models.part import Part
from app.models.spare_flow import SpareTransaction
from app.models.spare_stock import SpareStockLedger
from app.services.spare_stock_service import SpareStockService

_seq = {"n": 0}


def _part():
    _seq["n"] += 1
    p = Part(part_no=f"TD-{_seq['n']}", part_name=f"Today Part {_seq['n']}", uom="NO",
             part_type="OTHER", store_code="MAINTENANCE")
    db.session.add(p)
    db.session.commit()
    return p


def test_today_receipts_tie_out_to_the_card_and_name_the_source():
    svc = SpareStockService()
    p = _part()
    svc.set_quantity(p.id, 10, txn_type="OPENING")
    svc._write(p.id, 15, "RECEIPT", reference="GRN-TD-1", user="ERP-GRN", extra={"status": "ERP_GRN"})
    db.session.commit()
    led = SpareStockLedger.query.filter_by(part_id=p.id, txn_type="RECEIPT").one()
    db.session.add(SpareTransaction(part_id=p.id, txn_type="GRN", qty=5, grn_no="GRN-TD-1",
                                    supplier_name="Test Vendor", ledger_id=led.id))
    db.session.commit()

    rows = [r for r in svc.today_receipts("MAINTENANCE") if r["part_id"] == p.id]
    assert len(rows) == 1
    assert rows[0]["qty_delta"] == 5 and rows[0]["reference"] == "GRN-TD-1"
    assert rows[0]["source"].startswith("ERP GRN") and rows[0]["supplier"] == "Test Vendor"
    assert "status" not in rows[0]          # the drill's status donut is for part health only

    all_rows = svc.today_receipts("MAINTENANCE")
    card = svc.today_movements("MAINTENANCE")
    assert len(all_rows) == card["received_lines"]
    assert round(sum(r["qty_delta"] for r in all_rows), 2) == card["received_qty"]


def test_today_issues_carry_the_taker(app):
    svc = SpareStockService()
    p = _part()
    svc.set_quantity(p.id, 4, txn_type="OPENING")
    svc.issue(p.id, 1, "Maintenance", issued_to="Ravi", user="tester")
    rows = [r for r in svc.today_issues("MAINTENANCE") if r["part_id"] == p.id]
    assert rows and rows[0]["issued_to"] == "Ravi" and "issued_to_code" in rows[0]

    client = app.test_client()
    with client.session_transaction() as s:
        from app.models.user import User
        admin = User.query.filter_by(role="ADMIN").first()
        if admin is None:
            admin = User(username="td_admin", role="ADMIN", is_active=True)
            admin.set_password("pw")
            db.session.add(admin)
            db.session.commit()
        s["user_id"] = admin.id
    r = client.get("/api/v1/spare-stock/today/receipts?store_code=MAINTENANCE")
    assert r.status_code == 200 and isinstance(r.get_json()["data"], list)
