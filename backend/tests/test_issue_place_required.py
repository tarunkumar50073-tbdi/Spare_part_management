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
    assert r.status_code == 400 and "line" in r.get_json()["message"]
    r = c.post(f"/api/v1/spare-stock/parts/{p.id}/issue", json={**body, "line_name": "SA_PWM"})
    assert r.status_code == 400 and "machine" in r.get_json()["message"]
    r = c.post(f"/api/v1/spare-stock/parts/{p.id}/issue", json={**body, "line_name": "SA_PWM", "machine": "SA_PWM_11"})
    assert r.status_code in (200, 201)
    r = c.post(f"/api/v1/spare-stock/parts/{p.id}/issue", json={**body, "place_unavailable": True})
    assert r.status_code in (200, 201)
