"""A part marked Discontinued (the store, 22 Oct 2026: Tool Room parts with no
minimum are "future me required nhi h ya discontinue ho chuke h"; chose to keep
them with their stock): status "Discontinued" — never Out of Stock / Below
Minimum / Reorder, never on a to-order list or a missing-level count — while
its stock stays in the lists and in the stock value.

Everything here is DC-<tag>-<n>: this file's own store, sections and parts."""
import io
import uuid

import pytest
from openpyxl import Workbook

from app.extensions import db
from app.models.part import Part
from app.models.store import Section, Store
from app.models.user import User, UserStoreAccess
from app.repositories.part_repository import PartRepository
from app.services.inventory_control_service import InventoryControlService
from app.services.part_service import PartService
from app.services.spare_dashboard_service import SpareDashboardService
from app.services.spare_stock_service import SpareStockService

_TAG = uuid.uuid4().hex[:6].upper()
_seq = {"n": 0}


def _n():
    _seq["n"] += 1
    return _seq["n"]


@pytest.fixture()
def make():
    made = {"stores": [], "users": []}

    def store():
        code = f"DC{_TAG}{_n()}"
        s = Store(code=code, name=f"Discontinued Store {code}")
        db.session.add(s)
        db.session.flush()
        sec = Section(store_id=s.id, name=f"Tool Room {code}")
        db.session.add(sec)
        db.session.commit()
        made["stores"].append(code)
        return code, sec.id

    def part(store_code, section_id, qty=None, **over):
        n = _n()
        p = Part(part_no=f"DC-{_TAG}-{n}", part_name=f"Old Part {n}", uom="NOS", part_type="OTHER",
                 store_code=store_code, section_id=section_id, **over)
        db.session.add(p)
        db.session.commit()
        if qty is not None:
            SpareStockService().set_quantity(p.id, qty, txn_type="OPENING")
        return p

    def user(perms, stores=None):
        # A store user reaches the parts of their own stores only (24 Oct
        # 2026): by default, the stores this test made.
        u = User(username=f"dc{_TAG.lower()}{_n()}", role="STORE_USER", is_active=True)
        u.set_password("pw")
        u.set_permissions(perms)
        db.session.add(u)
        db.session.flush()
        for code in (made["stores"] if stores is None else stores):
            db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
        db.session.commit()
        made["users"].append(u.id)
        return u

    yield type("Make", (), {"store": staticmethod(store), "part": staticmethod(part), "user": staticmethod(user)})
    db.session.rollback()
    Store.query.filter(Store.code.in_(made["stores"])).update({"is_active": False}, synchronize_session=False)
    User.query.filter(User.id.in_(made["users"])).update({"is_active": False}, synchronize_session=False)
    db.session.commit()


def _row(code, part):
    return next(r for r in SpareStockService().list_stock(code) if r["part_id"] == part.id)


def test_a_discontinued_part_is_never_short_and_keeps_its_stock(make):
    code, sec = make.store()
    empty = make.part(code, sec, qty=0)                                  # no min: Out of Stock today
    held = make.part(code, sec, qty=4, unit_price=250)
    never = make.part(code, sec)                                         # never counted
    assert _row(code, empty)["status"] == "Out of Stock"
    for p in (empty, held, never):
        p.discontinued = True
    db.session.commit()
    stock = SpareStockService()
    assert [_row(code, p)["status"] for p in (empty, held, never)] == ["Discontinued", "Discontinued", "Not Counted"]
    assert _row(code, held)["stock_value"] == 1000 and _row(code, held)["discontinued"] is True
    assert stock.get_summary(code)["needs_reordering"] == 0
    assert stock.list_below_minimum(code) == [] or all(r["part_id"] not in (empty.id, held.id)
                                                       for r in stock.list_below_minimum(code))
    ic = InventoryControlService().overview(code)
    listed = {r["part_id"] for key in ("critical", "short", "reorder", "excess") for r in ic.get(key, [])}
    assert not listed & {empty.id, held.id}
    gauges = stock.analytics(code)
    assert gauges["counted_parts"] == 0                                   # no part of the store's health
    assert gauges["total_value"] == 1000                                  # but its money is still there


def test_overview_counts_it_on_its_own_and_never_as_missing_a_level(make):
    code, sec = make.store()
    make.part(code, sec, qty=0, discontinued=True)
    make.part(code, sec, qty=2, unit_price=10, discontinued=True)
    make.part(code, sec, qty=0)                                          # an active part with no levels
    ov = SpareDashboardService().overview(code)
    health = {h["status"]: h["count"] for h in ov["health"]}
    assert health["Discontinued"] == 2 and health["Out of Stock"] == 1
    assert ov["data_quality"]["missing_max"] == 1 and ov["data_quality"]["missing_min"] == 1
    counts = PartRepository().count_missing(store_code=code)
    assert counts["max"] == 1
    assert [p.discontinued for p in PartRepository().search(store_code=code, missing="max")] == [False]


def test_marked_on_the_part_master_and_by_excel(app, make):
    code, sec = make.store()
    p = make.part(code, sec, qty=1)
    editor = make.user({"part_master": {"view": True, "edit": True}})
    c = app.test_client()
    with c.session_transaction() as sess:
        sess["user_id"] = editor.id
    r = c.put(f"/api/v1/parts/{p.id}", json={"discontinued": True})
    assert r.status_code == 200 and r.get_json()["data"]["discontinued"] is True
    wb = Workbook()
    wb.active.append(["Part No", "Part Name", "Discontinued"])
    wb.active.append([p.part_no, p.part_name, "No"])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    PartService().bulk_import_excel(buf, store_code=code)
    db.session.refresh(p)
    assert p.discontinued is False
