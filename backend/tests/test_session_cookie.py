"""Session cookie (the store's "chhote security fix", 16 Oct 2026).

The cookie settings used to be written with app.config.setdefault, but Flask's
own defaults already fill those keys, so none of them applied: a sign-in
cookie lived Flask's default 31 days and carried no SameSite. These tests pin
what is in force now — SameSite=Lax, HttpOnly, and one sign-in lasting 12 h
from the moment of signing in (not sliding forward on every request) — and
that signing out still ends the session, which the screens' 30-minute idle
sign-out relies on."""
import time
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

import pytest
from itsdangerous.timed import TimestampSigner

from app import _session_hours
from app.extensions import db
from app.models.user import User

PASSWORD = "pw-cookie-1"
_seq = {"n": 0}


@pytest.fixture()
def client(app):
    return app.test_client()


def _user():
    _seq["n"] += 1
    u = User(username=f"cookieuser{_seq['n']}", role="ADMIN", is_active=True)
    u.set_password(PASSWORD)
    db.session.add(u)
    db.session.commit()
    return u


def _login(client, user):
    resp = client.post("/api/v1/auth/login", json={"username": user.username, "password": PASSWORD})
    assert resp.status_code == 200
    return resp


def _session_cookie(resp):
    found = [c for c in resp.headers.getlist("Set-Cookie") if c.startswith("session=")]
    return found[0] if found else None


def test_cookie_settings_are_in_force_on_a_created_app(app):
    assert app.config["SESSION_COOKIE_HTTPONLY"] is True
    assert app.config["SESSION_COOKIE_SAMESITE"] == "Lax"
    assert app.config["PERMANENT_SESSION_LIFETIME"] == timedelta(hours=12)
    assert app.permanent_session_lifetime == timedelta(hours=12)
    assert app.config["SESSION_REFRESH_EACH_REQUEST"] is False


def test_login_cookie_is_lax_httponly_and_expires_in_12_hours(client):
    before = datetime.now(timezone.utc)
    cookie = _session_cookie(_login(client, _user()))
    assert cookie, "login must set the session cookie"
    parts = [p.strip() for p in cookie.split(";")]
    lowered = [p.lower() for p in parts]
    assert "samesite=lax" in lowered
    assert "httponly" in lowered
    expires = next(p for p in parts if p.lower().startswith("expires="))
    when = parsedate_to_datetime(expires.split("=", 1)[1])
    assert abs((when - before) - timedelta(hours=12)) < timedelta(minutes=2)


def test_cookie_life_does_not_slide_with_use(client):
    _login(client, _user())
    me = client.get("/api/v1/auth/me")
    assert me.get_json()["data"] is not None
    # No fresh cookie on an ordinary request: the 12 h still count from sign-in.
    assert _session_cookie(me) is None
    assert _session_cookie(client.get("/api/v1/admin/system-status")) is None


def _login_hours_ago(client, monkeypatch, user, hours):
    """Sign in with the cookie's signature dated `hours` back — what the cookie
    of someone who signed in that long ago carries."""
    real = TimestampSigner.get_timestamp
    monkeypatch.setattr(TimestampSigner, "get_timestamp", lambda self: int(time.time()) - int(hours * 3600))
    try:
        _login(client, user)
    finally:
        monkeypatch.setattr(TimestampSigner, "get_timestamp", real)


def test_signed_in_user_is_logged_out_after_12_hours(client, monkeypatch):
    _login_hours_ago(client, monkeypatch, _user(), 12.1)
    # The server refuses the 12-hour-old cookie even if a browser still sends it.
    assert client.get("/api/v1/auth/me").get_json()["data"] is None
    assert client.get("/api/v1/admin/system-status").status_code == 401


def test_still_signed_in_before_12_hours(client, monkeypatch):
    user = _user()
    _login_hours_ago(client, monkeypatch, user, 11.5)
    assert client.get("/api/v1/auth/me").get_json()["data"]["username"] == user.username
    assert client.get("/api/v1/admin/system-status").status_code == 200


def test_sign_out_still_ends_the_session(client):
    # The screens' 30-minute idle sign-out (AuthContext) calls /auth/logout.
    _login(client, _user())
    resp = client.post("/api/v1/auth/logout")
    assert resp.status_code == 200
    cleared = _session_cookie(resp)
    assert cleared and "expires=thu, 01 jan 1970" in cleared.lower()
    assert client.get("/api/v1/auth/me").get_json()["data"] is None
    assert client.get("/api/v1/admin/system-status").status_code == 401


def test_session_hours_env_override(monkeypatch):
    monkeypatch.delenv("SESSION_LIFETIME_HOURS", raising=False)
    assert _session_hours() == 12.0
    monkeypatch.setenv("SESSION_LIFETIME_HOURS", "8")
    assert _session_hours() == 8.0
    for bad in ("abc", "0", "-3", "100000"):
        monkeypatch.setenv("SESSION_LIFETIME_HOURS", bad)
        assert _session_hours() == 12.0


# ---- a device login (Live Board TV / Kiosk) is never signed out by itself (4 Nov 2026) ----------

def _device(rights):
    _seq["n"] += 1
    u = User(username=f"cookiedevice{_seq['n']}", role="STORE_USER", is_active=True)
    u.set_password(PASSWORD)
    u.set_permissions(rights)
    db.session.add(u)
    db.session.commit()
    return u


def _expires(cookie):
    part = next(p.strip() for p in cookie.split(";") if p.strip().lower().startswith("expires="))
    return parsedate_to_datetime(part.split("=", 1)[1])


def test_which_logins_are_device_logins():
    assert _device({"live_dashboard": {"view": True}}).device_only
    assert _device({"part_kiosk": {"view": True}}).device_only
    assert _device({"live_dashboard": {"view": True}, "part_kiosk": {"view": True}}).device_only
    assert not _device({"live_dashboard": {"view": True}, "reports": {"view": True}}).device_only
    assert not _device({}).device_only
    assert not _user().device_only                                   # an administrator


def test_a_device_login_lasts_30_days_from_its_last_use(client):
    before = datetime.now(timezone.utc)
    cookie = _session_cookie(_login(client, _device({"live_dashboard": {"view": True}})))
    assert abs((_expires(cookie) - before) - timedelta(days=30)) < timedelta(minutes=2)
    # Every request writes it again, so a screen in use never runs out.
    again = _session_cookie(client.get("/api/v1/auth/me"))
    assert again and _expires(again) >= _expires(cookie)


def test_a_device_cookie_older_than_12_hours_still_works_but_a_person_s_does_not(client, monkeypatch):
    tv = _device({"live_dashboard": {"view": True}})
    _login_hours_ago(client, monkeypatch, tv, 13)
    assert client.get("/api/v1/auth/me").get_json()["data"]["username"] == tv.username
    other = client.application.test_client()
    _login_hours_ago(other, monkeypatch, _device({"reports": {"view": True}}), 13)
    assert other.get("/api/v1/auth/me").get_json()["data"] is None


def test_a_device_cookie_runs_out_after_30_days_unused(client, monkeypatch):
    _login_hours_ago(client, monkeypatch, _device({"part_kiosk": {"view": True}}), 30 * 24 + 1)
    assert client.get("/api/v1/auth/me").get_json()["data"] is None
