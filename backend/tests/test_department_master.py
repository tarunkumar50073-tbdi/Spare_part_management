"""Department Email Master: departments are seeded, an admin can set each one's
reorder e-mail, blank clears to NULL, names stay unique, and only the
notify-flagged departments that actually carry an address are handed to the
reorder notifier. Writes need a signed-in person with the right to edit the
master; the machine key alone is refused (the master decides who is mailed).
"""
import pytest

from app.extensions import db
from app.models.user import User
from app.repositories.department_repository import DepartmentRepository
from app.services.department_service import DepartmentService
from app.utils.exceptions import BadRequestError, NotFoundError

_seq = {"n": 0}


@pytest.fixture()
def client(app):
    return app.test_client()


def _name(base):
    _seq["n"] += 1
    return f"{base}-{_seq['n']}"


def test_departments_are_seeded():
    names = {d["name"] for d in DepartmentService().list_departments()}
    # The three consuming departments the issue flow uses, plus the reorder-mail
    # recipients, exist out of the box.
    assert {"Press Shop", "Maintenance", "Tool Room", "Purchase"} <= names


def test_purchase_is_a_reorder_recipient_once_it_has_an_address():
    svc = DepartmentService()
    purchase = DepartmentRepository().get_by_name("Purchase")
    assert purchase.notify_reorder is True

    # Seeded blank -> not yet a recipient (never mail an empty address).
    assert all(r.name != "Purchase" or r.email for r in DepartmentRepository().reorder_recipients())

    svc.update_department(purchase.id, {"email": "purchase@plant.test"})
    recipients = {r.name: r.email for r in DepartmentRepository().reorder_recipients()}
    assert recipients.get("Purchase") == "purchase@plant.test"


def test_create_and_update_sets_email_and_flag():
    svc = DepartmentService()
    dept = svc.create_department({"name": _name("Utility")})
    assert dept["email"] is None and dept["notify_reorder"] is False

    updated = svc.update_department(dept["id"], {"email": "utility@plant.test", "notify_reorder": True})
    assert updated["email"] == "utility@plant.test"
    assert updated["notify_reorder"] is True


def test_blank_email_is_stored_as_null():
    svc = DepartmentService()
    dept = svc.create_department({"name": _name("Paint"), "email": "paint@plant.test"})
    cleared = svc.update_department(dept["id"], {"email": "   "})
    assert cleared["email"] is None  # blank clears, not an empty string


def test_duplicate_name_is_rejected():
    svc = DepartmentService()
    name = _name("Weld")
    svc.create_department({"name": name})
    with pytest.raises(BadRequestError):
        svc.create_department({"name": name})


def test_rename_onto_existing_name_is_rejected():
    svc = DepartmentService()
    a = svc.create_department({"name": _name("Assembly")})
    taken = _name("Machining")
    svc.create_department({"name": taken})
    with pytest.raises(BadRequestError):
        svc.update_department(a["id"], {"name": taken})


def test_update_missing_department_raises():
    with pytest.raises(NotFoundError):
        DepartmentService().update_department(999999, {"email": "x@plant.test"})


def test_reorder_recipients_skips_flagged_without_address():
    svc = DepartmentService()
    d = svc.create_department({"name": _name("Store-Room"), "notify_reorder": True})  # flagged, no email
    assert not any(r.id == d["id"] for r in DepartmentRepository().reorder_recipients())

    svc.update_department(d["id"], {"email": "storeroom@plant.test"})
    assert any(r.id == d["id"] for r in DepartmentRepository().reorder_recipients())


def test_create_route_requires_admin(client):
    _seq["n"] += 1
    user = User(username=f"deptnonadmin{_seq['n']}", role="STORE_USER", is_active=True)
    user.set_password("pw")
    db.session.add(user)
    db.session.commit()
    with client.session_transaction() as sess:
        sess["user_id"] = user.id
    resp = client.post("/api/v1/departments", json={"name": _name("X-Ray")})
    assert resp.status_code == 403  # a signed-in non-admin cannot mutate the master


def _admin(client):
    _seq["n"] += 1
    user = User(username=f"deptadmin{_seq['n']}", role="ADMIN", is_active=True)
    user.set_password("pw")
    db.session.add(user)
    db.session.commit()
    with client.session_transaction() as sess:
        sess["user_id"] = user.id
    return client


def test_machine_caller_cannot_manage_master(client):
    name = _name("CNC-Line")
    resp = client.post(
        "/api/v1/departments",
        json={"name": name, "email": "cnc@plant.test", "notify_reorder": True},
        headers={"X-API-Key": "test-machine-key"},
    )
    assert resp.status_code == 403  # the key alone does not decide who is mailed
    assert DepartmentRepository().get_by_name(name) is None


def test_signed_in_admin_manages_master_through_the_route(client):
    admin = _admin(client)
    resp = admin.post("/api/v1/departments",
                      json={"name": _name("CNC-Line"), "email": "cnc@plant.test", "notify_reorder": True})
    assert resp.status_code == 201
    created = resp.get_json()["data"]
    assert created["email"] == "cnc@plant.test" and created["notify_reorder"] is True
    resp = admin.put(f"/api/v1/departments/{created['id']}", json={"notify_reorder": False})
    assert resp.status_code == 200 and resp.get_json()["data"]["notify_reorder"] is False


def test_invalid_email_is_rejected_at_the_route(client):
    resp = _admin(client).post("/api/v1/departments", json={"name": _name("Bad-Mail"), "email": "not-an-email"})
    assert resp.status_code == 422  # marshmallow Email validation bites (Unprocessable Entity)


def test_department_recipients_add_list_delete():
    from app.models.department import Department
    from app.services.department_service import DepartmentService
    svc = DepartmentService()
    dept = Department.query.first()
    r = svc.add_recipient(dept.id, "Ravi Kumar", "ravi.kumar@toyota-boshoku.com")
    assert r["name"] == "Ravi Kumar" and r["email"] == "ravi.kumar@toyota-boshoku.com"
    row = next(d for d in svc.list_departments() if d["id"] == dept.id)
    assert any(x["email"] == "ravi.kumar@toyota-boshoku.com" for x in row["recipients"])
    svc.delete_recipient(r["id"])
    row2 = next(d for d in svc.list_departments() if d["id"] == dept.id)
    assert not any(x["id"] == r["id"] for x in row2["recipients"])
