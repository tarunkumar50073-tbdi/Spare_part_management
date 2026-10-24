"""Rejection Mail (the store, 22 Oct 2026): the one mail to RQC to punch an SRV /
line rejection in ERP — "rejection request only 1 mail k liye h baaki kuch nhi".
Its details come from the ERP GRN line (or are typed in), the mail is a draft
the store sends from Outlook, and the app neither moves stock nor sends mail.

Everything here is RJ-<tag>-<n>: this file's own store, parts and users."""
import email
import uuid
from datetime import date

import pytest

from app.extensions import db
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.rejection_request import RejectionRequest
from app.models.spare_stock import SpareStock
from app.models.store import Section, Store
from app.models.user import PERMISSION_MODULES, User, UserStoreAccess
from app.services import spare_report_service
from app.services.rejection_request_service import RejectionRequestService
from app.services.spare_stock_service import SpareStockService
from app.utils.exceptions import BadRequestError

_TAG = uuid.uuid4().hex[:6].upper()
_seq = {"n": 0}
URL = "/api/v1/rejection-requests"
TODAY = date(2026, 10, 22)
svc = RejectionRequestService()


def _n():
    _seq["n"] += 1
    return _seq["n"]


@pytest.fixture(autouse=True)
def plant_today(monkeypatch):
    monkeypatch.setattr(spare_report_service, "plant_today", lambda: TODAY)


@pytest.fixture()
def make():
    made = {"stores": [], "users": [], "rr": []}

    def store():
        code = f"RJ{_TAG}{_n()}"
        s = Store(code=code, name=f"Rejection Store {code}")
        db.session.add(s)
        db.session.flush()
        db.session.add(Section(store_id=s.id, name=f"Sec {code}"))
        db.session.commit()
        made["stores"].append(code)
        return code

    def part(store_code, qty=10):
        n = _n()
        p = Part(part_no=f"RJ-{_TAG}-{n}", part_name=f"Plastic Bin {n}", uom="NOS", part_type="OTHER",
                 store_code=store_code)
        db.session.add(p)
        db.session.commit()
        if qty is not None:
            SpareStockService().set_quantity(p.id, qty, txn_type="OPENING")
        return p

    def grn(part, accept=None, receipt=200):
        n = _n()
        rr = ReceivingRegister(store_code="CHILD_PART", grn_no=f"GRN/{_TAG}/{n}", grn_date=date(2026, 10, 20),
                               ven_cd="V0142", ven_name="NILKAMAL LTD. (DHARUHERA)", gate_entry_no=f"GE{n}",
                               challan_no=f"61488856{n}", challan_dt=date(2026, 9, 25), po_no="CA00126-27/52",
                               item_cd=part.part_no, item_desc=part.part_name, challan_qty=receipt,
                               receipt_qty=receipt, accept_qty=accept, reject_qty=None)
        db.session.add(rr)
        db.session.commit()
        made["rr"].append(rr.id)
        return rr

    def user(stores=(), perms=None):
        u = User(username=f"rj{_TAG.lower()}{_n()}", role="STORE_USER", is_active=True, full_name="Ankit Rai")
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

    yield type("Make", (), {"store": staticmethod(store), "part": staticmethod(part), "grn": staticmethod(grn),
                            "user": staticmethod(user)})
    db.session.rollback()
    ReceivingRegister.query.filter(ReceivingRegister.id.in_(made["rr"])).delete(synchronize_session=False)
    Store.query.filter(Store.code.in_(made["stores"])).update({"is_active": False}, synchronize_session=False)
    User.query.filter(User.id.in_(made["users"])).update({"is_active": False}, synchronize_session=False)
    db.session.commit()


def _stock(part):
    row = SpareStock.query.filter_by(part_id=part.id).first()
    return float(row.qty_on_hand) if row else None


def test_a_mail_from_the_erp_grn_line_moves_no_stock(make):
    code = make.store()
    part = make.part(code)
    rr = make.grn(part)                                      # awaiting quality: an SRV rejection
    before = _stock(part)
    lines = svc.grn_lines(code, part.part_no)
    assert [l["id"] for l in lines] == [rr.id] and lines[0]["suggested_kind"] == "SRV"
    out = svc.create(code, {"receiving_register_id": rr.id, "qty": 200, "remark": "Bin Received Green Colour",
                            "hsn": "39232910", "po_date": "2026-08-20"}, user="store.user")
    assert out["request_no"] == "REJ-20261022-001" and out["kind"] == "SRV"
    assert (out["ven_name"], out["grn_no"], out["challan_no"], out["uom"], out["from_erp_register"]) == (
        "NILKAMAL LTD. (DHARUHERA)", rr.grn_no, rr.challan_no, "NOS", True)
    with pytest.raises(BadRequestError, match="more than the 200 received"):
        svc.create(code, {"receiving_register_id": rr.id, "qty": 201, "remark": "x"})
    # Another mail for the same line is simply another mail.
    assert svc.create(code, {"receiving_register_id": rr.id, "qty": 2, "remark": "more"})["request_no"].endswith("002")
    assert _stock(part) == before


def test_a_store_entry_grn_suggests_a_line_rejection(make):
    code = make.store()
    part = make.part(code)
    rr = make.grn(part, accept=150)
    assert svc.grn_lines(code, rr.grn_no)[0]["suggested_kind"] == "LINE"
    assert svc.create(code, {"receiving_register_id": rr.id, "qty": 5, "remark": "Rejected by user"})["kind"] == "LINE"


@pytest.mark.parametrize("over, message", [
    ({"part_id": None}, "Pick the part"),
    ({"ven_name": " "}, "Supplier is required"),
    ({"grn_no": None, "challan_no": None}, "GRN No. or the challan No."),
    ({"qty": 0}, "more than 0"),
    ({"remark": ""}, "Reason / remark is required"),
    ({"kind": "MAYBE"}, "Kind must be"),
])
def test_a_typed_mail_is_validated(make, over, message):
    code = make.store()
    part = make.part(code)
    data = {"part_id": part.id, "ven_name": "Local Vendor", "grn_no": "GRN-TYPED-1", "qty": 2, "remark": "Damaged"}
    data.update(over)
    with pytest.raises(BadRequestError, match=message):
        svc.create(code, data)


def test_the_mail_is_an_unsent_draft_in_the_stores_format(make):
    code = make.store()
    part = make.part(code)
    rr = make.grn(part, accept=200)
    svc.set_settings({"to": "rqc@tbdi.example; rajesh@tbdi.example", "cc": "store@tbdi.example",
                      "rqc_name": "Rajesh", "transport_name": "Harjeet Singh"})
    with pytest.raises(BadRequestError, match="not an e-mail address"):
        svc.set_settings({"to": "rajesh"})
    out = svc.create(code, {"receiving_register_id": rr.id, "qty": 200, "remark": "Bin Received Green Colour",
                            "hsn": "39232910"})
    data, name = svc.mail_draft(out["id"], user=make.user())
    assert name.endswith(".eml") and out["request_no"] in name
    msg = email.message_from_bytes(data)
    assert msg["X-Unsent"] == "1" and msg["Subject"] == "NILKAMAL LTD. (DHARUHERA) REJECTION"
    assert msg["To"] == "rqc@tbdi.example, rajesh@tbdi.example" and msg["Cc"] == "store@tbdi.example"
    body = next(p for p in msg.walk() if p.get_content_type() == "text/html").get_payload(decode=True).decode()
    for text in ("Dear Rajesh San", "Please punch line rejection", "Bin Received Green Colour", "39232910",
                 rr.challan_no, "@Harjeet Singh San", "vehicle no. for e-Way Bill", "Ankit Rai"):
        assert text in body, text


def test_the_list_of_mails_made(make):
    code = make.store()
    part = make.part(code)
    a = svc.create(code, {"part_id": part.id, "ven_name": "A Traders", "grn_no": "G-1", "qty": 1, "remark": "x"})
    b = svc.create(code, {"part_id": part.id, "ven_name": "B Traders", "challan_no": "C-9", "qty": 2, "remark": "y"})
    assert [r["id"] for r in svc.list(code)["rows"]] == [b["id"], a["id"]]
    assert [r["id"] for r in svc.list(code, {"q": "b trad"})["rows"]] == [b["id"]]


def test_api_rights_store_access_and_the_right_exists(app, make):
    assert any(m["key"] == "rejection_request" for m in PERMISSION_MODULES)
    code = make.store()
    part = make.part(code)
    viewer = make.user([code], {"rejection_request": {"view": True}})
    editor = make.user([code], {"rejection_request": {"view": True, "edit": True}})
    outsider = make.user([], {"rejection_request": {"view": True, "edit": True}})
    c = app.test_client()
    body = {"store_code": code, "part_id": part.id, "ven_name": "V", "grn_no": "G-API", "qty": 1, "remark": "r",
            "request_id": "form-1"}
    with c.session_transaction() as s:
        s["user_id"] = viewer.id
    assert c.get(URL, query_string={"store_code": code}).status_code == 200
    assert c.post(URL, json=body).status_code == 403
    with c.session_transaction() as s:
        s["user_id"] = outsider.id
    assert c.post(URL, json=body).status_code == 403
    with c.session_transaction() as s:
        s["user_id"] = editor.id
    r = c.post(URL, json=body)
    assert r.status_code == 201
    pk = r.get_json()["data"]["id"]
    again = c.post(URL, json=body)
    assert again.status_code == 200 and again.get_json()["data"]["replayed"] is True
    mail = c.get(f"{URL}/{pk}/mail")
    assert mail.status_code == 200 and mail.mimetype == "message/rfc822"
    assert RejectionRequest.query.filter_by(store_code=code).count() == 1
