"""Rights are CRUD (the store, 24 Oct 2026: "proper crud bna — E matlab kewal
edit/modify, create matlab new create aur insert data, read matlab kewal view
no any action, delete matlab kewal delete"): R reads only, C adds, E changes,
D removes / cancels — each on its own, on the server as well as the screen."""
import json
import uuid

import pytest

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.department import Department
from app.models.part import Part
from app.models.user import MODULE_ACTIONS, User, UserStoreAccess, normalize_rights

STORE = "MAINTENANCE"
_TAG = uuid.uuid4().hex[:6]


def _login(app, perms):
    u = User(username=f"crud{_TAG}{uuid.uuid4().hex[:5]}", role="STORE_USER", is_active=True)
    u.set_password("pw")
    u.set_permissions(perms)
    db.session.add(u)
    db.session.flush()
    db.session.add(UserStoreAccess(user_id=u.id, store_code=STORE))
    db.session.commit()
    c = app.test_client()
    with c.session_transaction() as s:
        s["user_id"] = u.id
    return c


def _pm(**rights):
    return {"part_master": {"view": True, **rights}}


@pytest.fixture()
def part(app):
    p = Part(part_no=f"CR-{_TAG}-{uuid.uuid4().hex[:4]}", part_name="CRUD part", uom="NOS",
             part_type="OTHER", store_code=STORE)
    db.session.add(p)
    db.session.commit()
    yield p
    db.session.rollback()
    Part.query.filter(Part.part_no.like(f"CR-{_TAG}-%")).delete(synchronize_session=False)
    db.session.commit()


def _new_part():
    return {"part_no": f"CR-{_TAG}-{uuid.uuid4().hex[:4]}", "part_name": "New one", "store_code": STORE}


def test_each_right_does_its_own_thing_on_the_part_master(app, part):
    read = _login(app, _pm())
    assert read.get("/api/v1/parts", query_string={"store_code": STORE}).status_code == 200   # R reads
    assert read.post("/api/v1/parts", json=_new_part()).status_code == 403                    # ...and nothing else
    assert read.put(f"/api/v1/parts/{part.id}", json={"part_name": "x"}).status_code == 403
    assert read.delete(f"/api/v1/parts/{part.id}").status_code == 403

    create = _login(app, _pm(create=True))
    assert create.post("/api/v1/parts", json=_new_part()).status_code == 201                  # C adds
    assert create.put(f"/api/v1/parts/{part.id}", json={"part_name": "x"}).status_code == 403
    assert create.delete(f"/api/v1/parts/{part.id}").status_code == 403

    update = _login(app, _pm(update=True))
    assert update.post("/api/v1/parts", json=_new_part()).status_code == 403
    assert update.put(f"/api/v1/parts/{part.id}", json={"part_name": "Renamed"}).status_code == 200   # E changes
    assert update.delete(f"/api/v1/parts/{part.id}").status_code == 403

    delete = _login(app, _pm(delete=True))
    assert delete.post("/api/v1/parts", json=_new_part()).status_code == 403
    assert delete.put(f"/api/v1/parts/{part.id}", json={"part_name": "y"}).status_code == 403
    assert delete.delete(f"/api/v1/parts/{part.id}").status_code == 200                      # D removes
    assert db.session.get(Part, part.id) is None


def test_an_import_needs_create_and_edit(app):
    for rights, want in (({"create": True}, 403), ({"update": True}, 403)):
        c = _login(app, _pm(**rights))
        r = c.post("/api/v1/parts/import/preview", data={}, content_type="multipart/form-data")
        assert r.status_code == want
    both = _login(app, _pm(create=True, update=True))
    r = both.post("/api/v1/parts/import/preview", data={}, content_type="multipart/form-data")
    assert r.status_code == 400                                       # let in; no file sent


def test_department_people_added_and_removed_by_their_own_rights(app):
    dept = Department(name=f"CRUD dept {_TAG}", notify_reorder=False)
    db.session.add(dept)
    db.session.commit()
    adder = _login(app, {"departments": {"view": True, "create": True}})
    r = adder.post(f"/api/v1/departments/{dept.id}/recipients", json={"name": "Asha", "email": "a@example.com"})
    assert r.status_code == 201
    rec_id = r.get_json()["data"]["id"]
    assert adder.delete(f"/api/v1/departments/recipients/{rec_id}").status_code == 403
    assert adder.put(f"/api/v1/departments/recipients/{rec_id}", json={"name": "Asha K"}).status_code == 403
    remover = _login(app, {"departments": {"view": True, "delete": True}})
    assert remover.post(f"/api/v1/departments/{dept.id}/recipients", json={"name": "B"}).status_code == 403
    assert remover.delete(f"/api/v1/departments/recipients/{rec_id}").status_code == 200
    db.session.delete(db.session.get(Department, dept.id))
    db.session.commit()


def test_scan_part_issue_is_create_and_a_location_move_is_edit(app, part):
    mover = _login(app, {"scan_part": {"view": True, "update": True}})
    assert mover.post(f"/api/v1/spare-stock/parts/{part.id}/issue", json={"qty": 1}).status_code == 403
    issuer = _login(app, {"scan_part": {"view": True, "create": True}})
    r = issuer.post(f"/api/v1/spare-stock/parts/{part.id}/update-location", json={"new_location": "R1-S1-B1"})
    assert r.status_code == 403


def test_rights_are_read_the_crud_way():
    # an old {view, edit} map: edit becomes each write the screen has
    assert normalize_rights("part_master", {"view": True, "edit": True}) == \
        {"view": True, "create": True, "update": True, "delete": True}
    assert normalize_rights("store_stock", {"view": True, "edit": True}) == \
        {"view": True, "create": True, "update": True, "delete": False}         # no delete on Store Stock
    assert normalize_rights("reports", {"edit": True, "delete": True}) == \
        {"view": True, "create": False, "update": False, "delete": False}       # Reports is read only
    # any write brings read; R alone is read only
    assert normalize_rights("challan_register", {"delete": True})["view"] is True
    assert not any(normalize_rights("part_master", {"view": True})[a] for a in ("create", "update", "delete"))
    u = User(username="crudmodel", role="STORE_USER")
    u.set_permissions({"part_master": {"view": True, "create": True, "bogus": True}, "nope": {"view": True}})
    assert json.loads(u.permissions) == {"part_master": {"view": True, "create": True, "update": False, "delete": False}}
    assert u.can("part_master", "create") and not u.can("part_master", "update")
    assert u.can("part_master", ("view", "create")) and not u.can("part_master", ("create", "update"))
    assert not u.can("part_master", "edit")                                    # "edit" = E only now
    # every screen offers read; only the screens that write offer C / E / D
    assert all("view" in acts for acts in MODULE_ACTIONS.values())
    assert MODULE_ACTIONS["live_dashboard"] == ("view",)


def test_saved_rights_are_rewritten_once(app):
    from app import _crud_rights
    u = User(username=f"crudmig{_TAG}", role="STORE_USER", is_active=True)
    u.set_password("pw")
    db.session.add(u)
    db.session.commit()
    u.permissions = json.dumps({"scan_part": {"view": True, "edit": True}, "reports": {"view": True, "edit": False}})
    db.session.commit()
    mark = AppSetting.query.filter_by(key="rights_crud_2026_10_24").first()
    if mark is not None:
        db.session.delete(mark)
        db.session.commit()
    _crud_rights()
    db.session.refresh(u)
    assert json.loads(u.permissions) == {
        "scan_part": {"view": True, "create": True, "update": True, "delete": True},
        "reports": {"view": True, "create": False, "update": False, "delete": False},
    }
    assert AppSetting.get_value("rights_crud_2026_10_24") is True
    db.session.delete(u)
    db.session.commit()
