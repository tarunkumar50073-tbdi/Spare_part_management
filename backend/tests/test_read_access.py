"""Who may READ what (the store, 24 Oct 2026: "data dikhne wala access control
theek kar de", after the day's security audit): the spare stock needs a Spare
Store right besides the store, parts are read and changed in the caller's own
stores, a read never falls back to "every store" for a store user, the mail
address book is for the Department Emails screen, and Store Saathi gives
figures only to those who may see them."""
import uuid

import pytest

from app.extensions import db
from app.models.part import Part
from app.models.user import User, UserStoreAccess

STORE = "MAINTENANCE"
_TAG = uuid.uuid4().hex[:6]


def _login(app, perms=None, stores=(STORE,), admin=False):
    u = User(username=f"ra{_TAG}{uuid.uuid4().hex[:5]}", role="ADMIN" if admin else "STORE_USER", is_active=True)
    u.set_password("pw")
    u.set_permissions(perms or {})
    db.session.add(u)
    db.session.flush()
    for code in stores:
        db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
    db.session.commit()
    c = app.test_client()
    with c.session_transaction() as s:
        s["user_id"] = u.id
    return c


@pytest.fixture()
def part(app):
    p = Part(part_no=f"RA-{_TAG}-{uuid.uuid4().hex[:4]}", part_name="Read access part", uom="NOS",
             part_type="OTHER", store_code=STORE, unit_price=10)
    db.session.add(p)
    db.session.commit()
    yield p
    db.session.rollback()
    Part.query.filter_by(id=p.id).delete()
    db.session.commit()


def test_the_spare_stock_needs_a_spare_store_right(app):
    q = {"store_code": STORE}
    assert _login(app).get("/api/v1/spare-stock", query_string=q).status_code == 403          # store only
    line = _login(app, {"install_confirm": {"edit": True}})
    assert line.get("/api/v1/spare-stock", query_string=q).status_code == 403
    assert line.get("/api/v1/spare-stock/export", query_string=q).status_code == 403
    assert line.get("/api/v1/spare-stock/installations", query_string=q).status_code == 200  # its own screen
    keeper = _login(app, {"store_stock": {"view": True}})
    assert keeper.get("/api/v1/spare-stock", query_string=q).status_code == 200
    assert keeper.get("/api/v1/spare-alerts", query_string=q).status_code == 200
    assert _login(app).get("/api/v1/spare-alerts", query_string=q).status_code == 403
    assert _login(app).get("/api/v1/spare-flow/queues", query_string=q).status_code == 403


def test_parts_are_read_and_changed_in_the_callers_own_stores(app, part):
    mine = _login(app, {"part_master": {"view": True, "edit": True}})
    other = _login(app, {"part_master": {"view": True, "edit": True}}, stores=("CHILD_PART",))
    assert mine.get(f"/api/v1/parts/{part.id}").status_code == 200
    assert other.get(f"/api/v1/parts/{part.id}").status_code == 403
    assert other.put(f"/api/v1/parts/{part.id}", json={"part_name": "renamed"}).status_code == 403
    assert other.delete(f"/api/v1/parts/{part.id}").status_code == 403
    assert mine.put(f"/api/v1/parts/{part.id}", json={"store_code": "CHILD_PART"}).status_code == 403  # not theirs
    # A list with no store: a store user names one of theirs; an admin reads all.
    assert mine.get("/api/v1/parts").status_code == 400
    assert mine.get("/api/v1/parts", query_string={"store_code": STORE}).status_code == 200
    assert other.get("/api/v1/parts", query_string={"store_code": STORE}).status_code == 403
    assert _login(app, admin=True, stores=()).get("/api/v1/parts").status_code == 200
    db.session.refresh(part)
    assert part.part_name == "Read access part" and part.store_code == STORE


def test_reads_never_fall_back_to_every_store_for_a_store_user(app):
    child = _login(app, {"child_store": {"view": True}}, stores=("CHILD_PART",))
    assert child.get("/api/v1/current-stock").status_code == 400
    assert child.get("/api/v1/current-stock", query_string={"store_code": "CHILD_PART"}).status_code == 200
    assert child.get("/api/v1/current-stock", query_string={"store_code": STORE}).status_code == 403
    reports = _login(app, {"reports": {"view": True}})
    assert reports.get("/api/v1/reports/stock/excel").status_code == 400


def test_the_mail_address_book_is_for_the_department_emails_screen(app):
    plain = _login(app, {"scan_part": {"edit": True}}).get("/api/v1/departments").get_json()["data"]
    assert all("recipients" not in d for d in plain)
    full = _login(app, {"departments": {"view": True}}).get("/api/v1/departments").get_json()["data"]
    assert all("recipients" in d for d in full)
    assert _login(app, {"scan_part": {"edit": True}}).get("/api/v1/report-recipients").status_code == 403


def test_store_saathi_gives_figures_only_to_those_who_may_see_them(app):
    r = _login(app, {"install_confirm": {"edit": True}}).post("/api/v1/assistant/ask", json={"query": "stock value"})
    assert r.status_code == 200 and "Spare Store right" in r.get_json()["data"]["answer"]
    r = _login(app, {"spare_store": {"view": True}}).post("/api/v1/assistant/ask", json={"query": "stock value"})
    assert "Spare Store right" not in r.get_json()["data"]["answer"]
