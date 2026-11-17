"""Line + machine are required on every Scan Part issue (17 Nov 2026), unless the
plant machine list could not be read (place_unavailable)."""
import pytest

from app.extensions import db
from app.models.part import Part
from app.models.user import User, UserStoreAccess
from app.services.spare_stock_service import SpareStockService

STORE = "MAINTENANCE"


@pytest.mark.require_place
def test_issue_needs_line_and_machine(app):
    p = Part(part_no="PLACE-REQ-1", part_name="PLACE TEST", uom="NOS", part_type="OTHER", store_code=STORE)
    db.session.add(p)
    db.session.commit()
    SpareStockService().set_quantity(p.id, 5, txn_type="OPENING")
    u = User(username="placeuser", role="ADMIN", is_active=True)
    u.set_password("pw-place-user-1")
    db.session.add(u)
    db.session.flush()
    db.session.add(UserStoreAccess(user_id=u.id, store_code=STORE))
    db.session.commit()
    c = app.test_client()
    with c.session_transaction() as s:
        s["user_id"] = u.id
    body = {"qty": 1, "department": "Maintenance", "issued_to": "Ravi"}
    r = c.post(f"/api/v1/spare-stock/parts/{p.id}/issue", json=body)
    assert r.status_code == 400 and "remarks" in r.get_json()["message"]
    body["remarks"] = "breakdown"
    r = c.post(f"/api/v1/spare-stock/parts/{p.id}/issue", json=body)
    assert r.status_code == 400 and "line" in r.get_json()["message"]
    r = c.post(f"/api/v1/spare-stock/parts/{p.id}/issue", json={**body, "line_name": "SA_PWM"})
    assert r.status_code == 400 and "machine" in r.get_json()["message"]
    r = c.post(f"/api/v1/spare-stock/parts/{p.id}/issue", json={**body, "line_name": "SA_PWM", "machine": "SA_PWM_11"})
    assert r.status_code in (200, 201)
    r = c.post(f"/api/v1/spare-stock/parts/{p.id}/issue", json={**body, "place_unavailable": True})
    assert r.status_code in (200, 201)


def test_issue_register_view_has_only_issues_and_no_empty_column(app):
    from sqlalchemy import text
    from app.models.spare_stock import SpareStockLedger
    p = Part(part_no="VIEW-REG-1", part_name="VIEW TEST", uom="NOS", part_type="OTHER", store_code=STORE)
    db.session.add(p)
    db.session.commit()
    SpareStockService().set_quantity(p.id, 5, txn_type="OPENING")
    SpareStockService().issue(p.id, 2, "Maintenance", issued_to="Ravi", user="sup")
    rows = db.session.execute(text("select * from issue_register where part_no = 'VIEW-REG-1'")).mappings().all()
    assert len(rows) == 1                                     # the OPENING row is not in it
    r = rows[0]
    assert float(r["qty_issued"]) == 2 and float(r["net_qty"]) == 2 and r["department"] == "Maintenance"
    assert all(v is not None for v in r.values())             # nothing empty
    assert r["line"] == "—" and r["machine"] == "—"


def test_issue_register_shows_the_return_on_the_issue_row(app):
    from sqlalchemy import text
    from app.models.spare_stock import SpareStockLedger
    p = Part(part_no="VIEW-RET-1", part_name="RETURN VIEW TEST", uom="NOS", part_type="OTHER", store_code=STORE)
    db.session.add(p)
    db.session.commit()
    SpareStockService().set_quantity(p.id, 5, txn_type="OPENING")
    out = SpareStockService().issue(p.id, 2, "Maintenance", issued_to="Ravi", user="sup", line_name="L1", machine="M1")
    r = db.session.execute(text("select * from issue_register where part_no = 'VIEW-RET-1'")).mappings().one()
    assert (r["returned_at"], r["returned_by"], r["return_reason"]) == ("—", "—", "—")
    db.session.add(SpareStockLedger(part_id=p.id, qty_delta=1, balance_after=4, txn_type="RETURN",
                                    return_of_id=out["issue"]["id"], return_no="RET-T-1", returned_by="Ravi",
                                    return_reason="UNUSED", created_by="sup"))
    db.session.commit()
    r = db.session.execute(text("select * from issue_register where part_no = 'VIEW-RET-1'")).mappings().one()
    assert float(r["qty_returned"]) == 1 and float(r["net_qty"]) == 1
    assert (r["returned_by"], r["return_reason"]) == ("Ravi", "UNUSED") and r["returned_at"] != "—"
    assert (r["line"], r["machine"]) == ("L1", "M1") and all(v is not None for v in r.values())
