"""Short Mail (the store, 25 Oct 2026): the mail to Purchase for material that
came short against an invoice — one mail per invoice and day, every short part
in one table, in the store's own words — kept apart from the Rejection Mail
("short mail and rejection mail alag alag ho"): its own right and To / CC. A
draft the store sends from Outlook; the app sends nothing."""
import email
import uuid
from datetime import date

import pytest

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.user import MODULE_ACTIONS, PERMISSION_MODULES, User
from app.services import spare_report_service
from app.services.short_mail_service import SETTING_KEY, ShortMailService
from app.utils.exceptions import BadRequestError

_TAG = uuid.uuid4().hex[:6]
URL = "/api/v1/short-mail"
TODAY = date(2026, 10, 25)
svc = ShortMailService()


@pytest.fixture(autouse=True)
def plant_today(monkeypatch):
    monkeypatch.setattr(spare_report_service, "plant_today", lambda: TODAY)


@pytest.fixture(autouse=True)
def fresh_settings():
    AppSetting.set_value(SETTING_KEY, {"to": "", "cc": ""}, "SYSTEM")
    db.session.commit()
    yield
    AppSetting.set_value(SETTING_KEY, {"to": "", "cc": ""}, "SYSTEM")
    db.session.commit()


def _mail(**over):
    data = {
        "supplier": "NILKAMAL LTD. (DHARUHERA)", "invoice_no": "INV-6148", "invoice_date": "2026-10-23",
        "received_on": "2026-10-25",
        "lines": [
            {"part_no": "CNTR1001", "description": "Plastic Bin Green", "invoice_qty": 200, "received_qty": 180},
            {"part_no": "CNTR1002", "description": "Plastic Bin Lid", "invoice_qty": 50, "received_qty": 0},
        ],
    }
    data.update(over)
    return data


def _html(raw):
    msg = email.message_from_bytes(raw)
    return msg, next(p for p in msg.walk() if p.get_content_type() == "text/html").get_payload(decode=True).decode()


def test_the_mail_is_an_unsent_draft_in_the_stores_words():
    svc.set_settings({"to": "purchase@tbdi.example; buyer@tbdi.example", "cc": "store@tbdi.example"})
    user = type("U", (), {"full_name": "Ankit Rai", "username": "ankit"})()
    raw, name = svc.draft(_mail(), user=user)
    assert name.endswith(".eml") and "INV-6148" in name
    msg, body = _html(raw)
    assert msg["X-Unsent"] == "1"
    assert msg["Subject"] == "NILKAMAL LTD. (DHARUHERA) SHORT MATERIAL RECEIVED - INVOICE NO. INV-6148"
    assert msg["To"] == "purchase@tbdi.example, buyer@tbdi.example" and msg["Cc"] == "store@tbdi.example"
    for text in ("Dear Sir,", "This is to inform you that today we have short material received against "
                 "invoice no. INV-6148 on dated 23-Oct-2026. Detail is given below:-",
                 "Part No.", "Part Description", "Invoice Qty", "Received Qty", "Short Qty",
                 "CNTR1001", "Plastic Bin Green", "CNTR1002", "Ankit Rai"):
        assert text in body, text
    # the short qty of each part: 200 - 180 and 50 - 0
    assert ">20</td>" in body and ">50</td>" in body


def test_an_earlier_day_is_named_and_a_missing_invoice_date_left_out():
    _, body = _html(svc.draft(_mail(received_on="2026-10-24", invoice_date=None))[0])
    assert "that on 24-Oct-2026 we have short material received against invoice no. INV-6148. Detail" in body


@pytest.mark.parametrize("over, message", [
    ({"lines": []}, "at least one short part"),
    ({"supplier": ""}, "Supplier is required"),
    ({"invoice_no": " "}, "Invoice no. is required"),
    ({"lines": [{"part_no": "P1", "invoice_qty": 5, "received_qty": 5}]}, "is not short"),
    ({"lines": [{"part_no": "P1", "invoice_qty": 5, "received_qty": -1}]}, "cannot be less than 0"),
    ({"lines": [{"part_no": "P1", "invoice_qty": 0, "received_qty": 0}]}, "must be more than 0"),
    ({"lines": [{"part_no": f"P{i}", "invoice_qty": 2, "received_qty": 1} for i in range(61)]}, "At most 60"),
])
def test_a_mail_is_checked(over, message):
    with pytest.raises(BadRequestError, match=message):
        svc.draft(_mail(**over))


def test_settings_are_its_own_not_the_rejection_mails():
    svc.set_settings({"to": "purchase@tbdi.example"})
    assert svc.settings() == {"to": "purchase@tbdi.example", "cc": ""}
    assert (AppSetting.get_value("rejection_mail") or {}).get("to") != "purchase@tbdi.example"
    with pytest.raises(BadRequestError, match="not an e-mail address"):
        svc.set_settings({"to": "purchase"})


def _user(perms):
    u = User(username=f"sm{_TAG}{len(perms)}{uuid.uuid4().hex[:4]}", role="STORE_USER", is_active=True)
    u.set_password("pw")
    u.set_permissions(perms)
    db.session.add(u)
    db.session.commit()
    return u


def test_api_its_own_right():
    assert any(m["key"] == "short_mail" for m in PERMISSION_MODULES)
    assert MODULE_ACTIONS["short_mail"] == ("view", "create", "update")


def test_api_rights(app):
    rejection_only = _user({"rejection_request": {"view": True, "create": True, "update": True}})
    viewer = _user({"short_mail": {"view": True}})
    maker = _user({"short_mail": {"view": True, "create": True, "update": True}})
    c = app.test_client()

    def as_(u):
        with c.session_transaction() as s:
            s["user_id"] = u.id

    as_(rejection_only)                                     # the Rejection Mail right does not open it
    assert c.get(f"{URL}/settings").status_code == 403
    assert c.post(f"{URL}/draft", json=_mail()).status_code == 403
    as_(viewer)
    assert c.get(f"{URL}/settings").status_code == 200
    assert c.post(f"{URL}/draft", json=_mail()).status_code == 403
    assert c.put(f"{URL}/settings", json={"to": "p@tbdi.example"}).status_code == 403
    as_(maker)
    r = c.post(f"{URL}/draft", json=_mail())
    assert r.status_code == 200 and r.mimetype == "message/rfc822"
    assert c.post(f"{URL}/draft", json=_mail(lines=[])).status_code == 400
    assert c.put(f"{URL}/settings", json={"to": "p@tbdi.example"}).status_code == 200
