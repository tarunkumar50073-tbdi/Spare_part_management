"""Remarks are required on every Scan Part issue (17 Nov 2026); line + machine
are not asked at the store (18 Nov 2026) and never stop an issue."""
import pytest

from app.extensions import db
from app.models.part import Part
from app.models.user import User, UserStoreAccess
from app.services.spare_stock_service import SpareStockService

STORE = "MAINTENANCE"


@pytest.mark.require_place
def test_issue_needs_remarks_but_no_line_or_machine(app):
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
    assert r.status_code in (200, 201)
    # A line / machine sent by an old screen is dropped, not saved.
    r = c.post(f"/api/v1/spare-stock/parts/{p.id}/issue", json={**body, "line_name": "SA_PWM", "machine": "SA_PWM_11"})
    assert r.status_code in (200, 201)
    from app.models.spare_stock import SpareStockLedger
    rows = SpareStockLedger.query.filter_by(part_id=p.id, txn_type="ISSUE").all()
    assert len(rows) == 2 and all(x.line_name is None and x.machine is None for x in rows)
    assert c.get("/api/v1/employees/machines?department=Maintenance").status_code == 404


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
    assert "line" not in r and "machine" not in r            # not asked at the store (18 Nov 2026)


def test_issue_register_shows_the_return_on_the_issue_row(app):
    from sqlalchemy import text
    from app.models.spare_stock import SpareStockLedger
    p = Part(part_no="VIEW-RET-1", part_name="RETURN VIEW TEST", uom="NOS", part_type="OTHER", store_code=STORE)
    db.session.add(p)
    db.session.commit()
    SpareStockService().set_quantity(p.id, 5, txn_type="OPENING")
    out = SpareStockService().issue(p.id, 2, "Maintenance", issued_to="Ravi", user="sup")
    r = db.session.execute(text("select * from issue_register where part_no = 'VIEW-RET-1'")).mappings().one()
    assert (r["returned_at"], r["returned_by"], r["return_reason"]) == ("—", "—", "—")
    assert (r["return_no"], r["return_received_by"]) == ("—", "—")
    # New columns last (21 Nov 2026), the issue's own IS/… number at the very end.
    assert list(r.keys())[-3:] == ["return_no", "return_received_by", "issue_slip_no"]
    assert r["issue_slip_no"].startswith("DX/") and "/IS" in r["issue_slip_no"]
    db.session.add(SpareStockLedger(part_id=p.id, qty_delta=1, balance_after=4, txn_type="RETURN",
                                    return_of_id=out["issue"]["id"], return_no="RET-T-1", returned_by="Ravi",
                                    return_reason="UNUSED", created_by="sup"))
    db.session.commit()
    r = db.session.execute(text("select * from issue_register where part_no = 'VIEW-RET-1'")).mappings().one()
    assert float(r["qty_returned"]) == 1 and float(r["net_qty"]) == 1
    assert (r["returned_by"], r["return_reason"]) == ("Ravi", "UNUSED") and r["returned_at"] != "—"
    assert (r["return_no"], r["return_received_by"]) == ("RET-T-1", "sup")
    db.session.add(SpareStockLedger(part_id=p.id, qty_delta=1, balance_after=5, txn_type="RETURN",
                                    return_of_id=out["issue"]["id"], return_no="RET-T-2", returned_by="Ravi",
                                    return_reason="UNUSED", created_by="keeper"))
    db.session.commit()
    r = db.session.execute(text("select * from issue_register where part_no = 'VIEW-RET-1'")).mappings().one()
    assert (r["return_no"], r["return_received_by"]) == ("RET-T-1, RET-T-2", "keeper")
    assert "line" not in r and all(v is not None for v in r.values())
