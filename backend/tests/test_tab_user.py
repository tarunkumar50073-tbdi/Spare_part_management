"""One login per browser, many tabs (the store, 24 Oct 2026: "agar 1 me khula h
to dusre me bina login na khule kyunki 1 website par alag alag user kholenge").

Every tab shares the one login cookie, so a tab sends the id of the user it
signed in as (X-DX-User). After someone else signs in in another tab, the old
tab's calls are refused (401, code OTHER_USER) instead of quietly running as the
new person, and its Sign out no longer ends the new person's login."""
import pytest

from app.extensions import db
from app.models.user import User

PASSWORD = "pw-tab-user-1"
URL = "/api/v1/stores"
_seq = {"n": 0}


@pytest.fixture()
def client(app):
    return app.test_client()


def _user():
    _seq["n"] += 1
    u = User(username=f"tabuser{_seq['n']}", role="ADMIN", is_active=True)
    u.set_password(PASSWORD)
    db.session.add(u)
    db.session.commit()
    return u


def _login(client, user):
    assert client.post("/api/v1/auth/login", json={"username": user.username, "password": PASSWORD}).status_code == 200


def _as(user):
    return {"X-DX-User": str(user.id)}


def test_a_tab_of_the_user_signed_in_works(client):
    a = _user()
    _login(client, a)
    assert client.get(URL, headers=_as(a)).status_code == 200
    assert client.get(URL).status_code == 200                     # no header (images, older screens): as before


def test_a_tab_left_from_an_earlier_user_is_refused(client):
    a, b = _user(), _user()
    _login(client, a)                                              # tab 1
    _login(client, b)                                              # tab 2, same browser: the cookie is now B's
    r = client.get(URL, headers=_as(a))                            # tab 1 again
    assert r.status_code == 401
    assert r.get_json()["errors"] == {"code": "OTHER_USER"}
    assert client.get(URL, headers=_as(b)).status_code == 200      # B carries on


def test_signing_out_in_the_old_tab_leaves_the_new_login(client):
    a, b = _user(), _user()
    _login(client, a)
    _login(client, b)
    assert client.post("/api/v1/auth/logout", headers=_as(a)).status_code == 200
    assert client.get(URL, headers=_as(b)).status_code == 200      # B still signed in
    assert client.post("/api/v1/auth/logout", headers=_as(b)).status_code == 200
    assert client.get(URL, headers=_as(b)).status_code == 401      # B's own sign-out ends it


def test_sign_out_without_the_header_ends_the_login_as_before(client):
    a = _user()
    _login(client, a)
    assert client.post("/api/v1/auth/logout").status_code == 200
    assert client.get(URL).status_code == 401
