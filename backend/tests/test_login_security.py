"""The sign-in Security Check and account block, the QMP portal's way (the store,
23 Oct 2026: "mere login page me captcha is type se ho and method bhi ye rhe"):
a code of 2 letters + 2 numbers the server draws and checks, one try per code,
and a username blocked for 15 minutes after 5 wrong username / password tries,
each wrong try saying how many are left.

conftest switches both off for the suite; this file switches them on.
"""
import re
import uuid
from datetime import timedelta

import pytest

from app.extensions import db
from app.models.base import utcnow
from app.models.login_attempt import LoginAttempt
from app.models.user import User
from app.utils import captcha

URL = "/api/v1/auth/login"
PASSWORD = "Right-Pass-1"
_TAG = uuid.uuid4().hex[:6]
_seq = {"n": 0}


def _n():
    _seq["n"] += 1
    return _seq["n"]


@pytest.fixture()
def guarded(app):
    app.config["LOGIN_CAPTCHA_ENABLED"] = True
    app.config["LOGIN_LOCK_ENABLED"] = True
    yield
    app.config["LOGIN_CAPTCHA_ENABLED"] = False
    app.config["LOGIN_LOCK_ENABLED"] = False


@pytest.fixture()
def user():
    u = User(username=f"ls_{_TAG}_{_n()}", role="STORE_USER", is_active=True)
    u.set_password(PASSWORD)
    db.session.add(u)
    db.session.commit()
    yield u
    LoginAttempt.query.filter_by(username=u.username.lower()).delete()
    u.is_active = False
    db.session.commit()


@pytest.fixture()
def code(monkeypatch):
    """Every code drawn is this one, so a test can type it."""
    monkeypatch.setattr(captcha, "make_code", lambda: "8N4F")
    return "8N4F"


def _try(client, username, password, typed):
    client.get("/api/v1/auth/captcha")          # draws the code into the session
    return client.post(URL, json={"username": username, "password": password, "captcha": typed})


def test_the_code_is_two_letters_and_two_numbers_drawn_as_a_picture(app, guarded):
    for _ in range(50):
        c = captcha.make_code()
        assert len(c) == 4 and sum(ch.isdigit() for ch in c) == 2 and sum(ch.isalpha() for ch in c) == 2
        assert not set(c) & set("IOL01")
    svg = app.test_client().get("/api/v1/auth/captcha").get_json()["data"]["svg"]
    assert svg.startswith("<svg") and "<line" in svg and len(re.findall(r"<text ", svg)) == 4


def test_the_session_holds_no_readable_code(app, code, guarded):
    c = app.test_client()
    c.get("/api/v1/auth/captcha")
    with c.session_transaction() as s:
        held = s[captcha.SESSION_KEY]
    assert code not in str(held) and set(held) == {"h", "t"}


def test_sign_in_needs_the_code_and_a_code_is_good_once(app, guarded, user, code):
    c = app.test_client()
    assert c.post(URL, json={"username": user.username, "password": PASSWORD}).status_code == 400   # no code
    r = _try(c, user.username, PASSWORD, "AB12")
    assert r.status_code == 400 and "Security code is wrong" in r.get_json()["message"]
    # A wrong code costs no try of the account.
    assert LoginAttempt.query.filter_by(username=user.username.lower()).first() is None
    assert _try(c, user.username, PASSWORD, code.lower()).status_code == 200        # any case
    # The code was used up by that sign-in: sending it again without a new one fails.
    c2 = app.test_client()
    c2.get("/api/v1/auth/captcha")
    assert c2.post(URL, json={"username": user.username, "password": PASSWORD, "captcha": code}).status_code == 200
    assert c2.post(URL, json={"username": user.username, "password": PASSWORD, "captcha": code}).status_code == 400


def test_five_wrong_tries_block_the_account_for_fifteen_minutes(app, guarded, user, code):
    c = app.test_client()
    for n in range(1, 5):
        r = _try(c, user.username, "wrong", code)
        assert r.status_code == 401
        assert r.get_json()["message"] == (
            f"Wrong username or password. You have entered wrong {n} time(s) — "
            f"{5 - n} attempt(s) left before the account is blocked for 15 minutes.")
    r = _try(c, user.username, "wrong", code)
    assert r.status_code == 423 and "blocked for 15 minutes" in r.get_json()["message"]
    # Blocked: even the right password is refused, and says how long is left.
    r = _try(c, user.username, PASSWORD, code)
    assert r.status_code == 423 and "Try again in 15 minute(s)" in r.get_json()["message"]
    # Once the 15 minutes are over the right password gets in, and the count is wiped.
    guard = LoginAttempt.query.filter_by(username=user.username.lower()).first()
    guard.locked_until = utcnow() - timedelta(seconds=1)
    db.session.commit()
    assert _try(c, user.username, PASSWORD, code).status_code == 200
    assert LoginAttempt.query.filter_by(username=user.username.lower()).first() is None


def test_a_good_sign_in_resets_the_count(app, guarded, user, code):
    c = app.test_client()
    _try(c, user.username, "wrong", code)
    _try(c, user.username, "wrong", code)
    assert _try(c, user.username, PASSWORD, code).status_code == 200
    r = _try(c, user.username, "wrong", code)
    assert "wrong 1 time(s) — 4 attempt(s) left" in r.get_json()["message"]


def test_an_unknown_username_reads_the_same_as_a_real_one(app, guarded, code):
    name = f"nobody_{_TAG}"
    r = _try(app.test_client(), name, "wrong", code)
    assert r.status_code == 401 and "wrong 1 time(s) — 4 attempt(s) left" in r.get_json()["message"]
    LoginAttempt.query.filter_by(username=name.lower()).delete()
    db.session.commit()


def test_a_wrong_try_older_than_the_block_no_longer_counts(app, guarded, user, code):
    c = app.test_client()
    _try(c, user.username, "wrong", code)
    guard = LoginAttempt.query.filter_by(username=user.username.lower()).first()
    guard.last_failed_at = utcnow() - timedelta(minutes=16)
    db.session.commit()
    r = _try(c, user.username, "wrong", code)
    assert "wrong 1 time(s) — 4 attempt(s) left" in r.get_json()["message"]


def test_sign_in_needs_no_code_while_the_check_is_off(app):
    """Off by default since 24 Oct 2026 ("login page ko without captcha rhne
    de"): the code endpoint says so, and the screen signs in without one."""
    assert app.config["LOGIN_CAPTCHA_ENABLED"] is False
    c = app.test_client()
    body = c.get("/api/v1/auth/captcha").get_json()["data"]
    assert body == {"enabled": False}
