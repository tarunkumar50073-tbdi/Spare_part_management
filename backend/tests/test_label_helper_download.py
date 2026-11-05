"""The DX label helper download (Settings -> Label printer): an admin gets
the helper's files as one zip, with Windows line ends; nobody else gets it."""
import io
import zipfile

from app.extensions import db
from app.models.user import User

_n = {"n": 0}


def _user(role):
    _n["n"] += 1
    u = User(username=f"helperdl{_n['n']}", role=role, is_active=True)
    u.set_password("pw")
    db.session.add(u)
    db.session.commit()
    return u


def _login(client, user):
    with client.session_transaction() as sess:
        sess["user_id"] = user.id


def test_an_admin_downloads_the_label_helper_zip(app):
    client = app.test_client()
    _login(client, _user("ADMIN"))
    resp = client.get("/api/v1/admin/label-helper.zip")
    assert resp.status_code == 200 and resp.mimetype == "application/zip"
    z = zipfile.ZipFile(io.BytesIO(resp.data))
    names = set(z.namelist())
    for f in ("dx-label-helper.ps1", "install-autostart.bat", "remove-autostart.bat",
              "start-label-helper-hidden.vbs", "start-label-helper.bat", "README.md"):
        assert f"DX Label Helper/{f}" in names
    bat = z.read("DX Label Helper/install-autostart.bat")
    assert b"\r\n" in bat and b"\n" not in bat.replace(b"\r\n", b"")     # Windows line ends only


def test_the_label_helper_zip_is_admin_only(app):
    client = app.test_client()
    assert client.get("/api/v1/admin/label-helper.zip").status_code == 401
    _login(client, _user("STORE_USER"))
    assert client.get("/api/v1/admin/label-helper.zip").status_code == 403
