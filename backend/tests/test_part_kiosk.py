"""Part Search kiosk (the store, 25 Oct 2026): the kiosk outside the spare store
— search a part, see its photo, stock, location and section; read only ("read
kar sakta h part, photo; read delete nhi"). It shows nothing the shop floor
should not see (no rate, value, levels or supplier) and its login opens nothing
else.

Everything here is PK-<tag>-<n>: this file's own store, parts and users."""
import uuid

import pytest

from app.extensions import db
from app.models.part import Part
from app.models.store import Section, Store
from app.models.user import MODULE_ACTIONS, PERMISSION_MODULES, User, UserStoreAccess
from app.services.part_kiosk_service import PartKioskService
from app.services.spare_stock_service import SpareStockService

_TAG = uuid.uuid4().hex[:6].upper()
_seq = {"n": 0}
URL = "/api/v1/part-kiosk/parts"
svc = PartKioskService()


def _n():
    _seq["n"] += 1
    return _seq["n"]


@pytest.fixture()
def make():
    made = {"stores": [], "users": []}

    def store():
        code = f"PK{_TAG}{_n()}"
        s = Store(code=code, name=f"Kiosk Store {code}")
        db.session.add(s)
        db.session.flush()
        sec = Section(store_id=s.id, name=f"Press Tool Room {code}")
        db.session.add(sec)
        db.session.commit()
        made["stores"].append(code)
        return code, sec

    def part(store_code, section=None, name="BEARING 6204 ZZ", qty=5, **kw):
        n = _n()
        p = Part(part_no=kw.pop("part_no", f"PK-{_TAG}-{n}"), part_name=name, uom="NOS", part_type="OTHER",
                 store_code=store_code, section_id=section.id if section else None, unit_price=1250,
                 min_stock_level=2, max_stock_level=9, **kw)
        db.session.add(p)
        db.session.commit()
        if qty is not None:
            SpareStockService().set_quantity(p.id, qty, txn_type="OPENING")
        return p

    def user(stores=(), perms=None):
        u = User(username=f"pk{_TAG.lower()}{_n()}", role="STORE_USER", is_active=True)
        u.set_password("pw")
        if perms:
            u.set_permissions(perms)
        db.session.add(u)
        db.session.flush()
        for code in stores:
            db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
        db.session.commit()
        made["users"].append(u.id)
        return u

    yield type("Make", (), {"store": staticmethod(store), "part": staticmethod(part), "user": staticmethod(user)})
    db.session.rollback()
    Store.query.filter(Store.code.in_(made["stores"])).update({"is_active": False}, synchronize_session=False)
    User.query.filter(User.id.in_(made["users"])).update({"is_active": False}, synchronize_session=False)
    db.session.commit()


def test_a_part_shows_its_stock_place_section_and_photos_but_no_money(make):
    code, sec = make.store()
    p = make.part(code, sec, specification="DEEP GROOVE", model_no="6204ZZ", location="R4-S1-B1",
                  rework_location="R9-S1-B2", qty=12)
    row = svc.search(code, p.part_no)["rows"][0]
    assert row["part_no"] == p.part_no and row["part_name"] == "BEARING 6204 ZZ"
    assert row["qty"] == 12 and row["available"] is True and row["uom"] == "NOS"
    assert row["location"] == "R4-S1-B1" and row["rework_location"] == "R9-S1-B2"
    assert row["section"] == sec.name and row["specification"] == "DEEP GROOVE" and row["model_no"] == "6204ZZ"
    assert row["photos"] == [] and "image_file" in row
    for hidden in ("unit_price", "rate", "value", "min_stock_level", "max_stock_level", "reorder_level", "supplier_id"):
        assert hidden not in row, hidden


def test_every_word_must_match_an_exact_part_no_first_inactive_left_out(make):
    code, sec = make.store()
    a = make.part(code, sec, name="BEARING 6204 ZZ", qty=0)
    b = make.part(code, sec, name="BEARING 6205 ZZ")
    make.part(code, sec, name="SEAL 6204")
    gone = make.part(code, sec, name="BEARING 6204 OLD")
    gone.is_active = False
    db.session.commit()
    rows = svc.search(code, "bearing 6204")["rows"]
    assert [r["part_no"] for r in rows] == [a.part_no]
    assert rows[0]["available"] is False and rows[0]["qty"] == 0
    assert svc.search(code, b.part_no.lower())["rows"][0]["part_no"] == b.part_no
    assert svc.search(code, "b")["rows"] == []                # too short to search
    assert svc.search(code, "bearing")["total"] == 2


def test_kiosk_right_is_read_only_and_opens_nothing_else(app, make):
    assert any(m["key"] == "part_kiosk" for m in PERMISSION_MODULES)
    assert MODULE_ACTIONS["part_kiosk"] == ("view",)
    code, sec = make.store()
    p = make.part(code, sec)
    kiosk = make.user([code], {"part_kiosk": {"view": True, "create": True, "update": True, "delete": True}})
    assert not kiosk.can("part_kiosk", "update")              # the screen has no write to grant
    other_store = make.user([], {"part_kiosk": {"view": True}})
    nobody = make.user([code], {"reports": {"view": True}})
    c = app.test_client()

    def as_(u):
        with c.session_transaction() as s:
            s["user_id"] = u.id

    as_(kiosk)
    r = c.get(URL, query_string={"store_code": code, "q": p.part_no})
    assert r.status_code == 200 and r.get_json()["data"]["rows"][0]["part_no"] == p.part_no
    assert c.get("/api/v1/spare-stock", query_string={"store_code": code}).status_code == 403
    assert c.put(f"/api/v1/parts/{p.id}", json={"part_name": "X"}).status_code == 403
    assert c.delete(f"/api/v1/parts/{p.id}/image").status_code == 403
    assert c.get(f"/api/v1/parts/{p.id}/image").status_code == 404   # no photo yet — but not refused
    as_(other_store)
    assert c.get(URL, query_string={"store_code": code, "q": "bear"}).status_code == 403
    as_(nobody)
    assert c.get(URL, query_string={"store_code": code, "q": "bear"}).status_code == 403


def test_stock_reads_honestly_not_counted_out_of_stock_and_waiting_for_qc(make):
    """The kiosk polish (28 Oct 2026): a part never counted is "not counted",
    never "out of stock"; a counted 0 or a negative is out of stock and no
    negative is shown; what came in at the gate and waits for quality is said
    apart and never added to the stock."""
    from datetime import date
    from app.models.spare_packet import SpareBatch, SparePacket
    from app.models.spare_stock import SpareStock
    code, sec = make.store()
    never = make.part(code, sec, name="KIOSK NEVER COUNTED", qty=None)
    zero = make.part(code, sec, name="KIOSK ZERO", qty=0)
    minus = make.part(code, sec, name="KIOSK MINUS", qty=0)
    SpareStock.query.filter_by(part_id=minus.id).update({"qty_on_hand": -3})
    gate = make.part(code, sec, name="KIOSK AT GATE", qty=2)
    batch = SpareBatch(receipt_no=f"RCP-K{gate.id}", store_code=code, part_id=gate.id, source="GATE",
                       received_on=date(2026, 10, 28), qty=5, uom="NOS")
    db.session.add(batch)
    db.session.flush()
    for i, status in enumerate(("QC_PENDING", "QC_PENDING", "CANCELLED"), start=1):
        db.session.add(SparePacket(code=f"TBK{gate.id}-{i:02d}", kind="UNIT", batch_id=batch.id, part_id=gate.id,
                                   seq=i, qty=1, uom="NOS", status=status))
    db.session.commit()
    rows = {r["part_name"]: r for r in svc.search(code, "kiosk")["rows"]}
    assert (rows["KIOSK NEVER COUNTED"]["counted"], rows["KIOSK NEVER COUNTED"]["qty"],
            rows["KIOSK NEVER COUNTED"]["available"]) == (False, None, False)
    assert (rows["KIOSK ZERO"]["counted"], rows["KIOSK ZERO"]["qty"], rows["KIOSK ZERO"]["available"]) == (True, 0, False)
    assert (rows["KIOSK MINUS"]["qty"], rows["KIOSK MINUS"]["available"]) == (0, False)
    g = rows["KIOSK AT GATE"]
    assert (g["qty"], g["available"], g["qc_pending"]) == (2, True, 2)       # 2 waiting, not added; cancelled left out
    assert rows["KIOSK ZERO"]["qc_pending"] == 0
