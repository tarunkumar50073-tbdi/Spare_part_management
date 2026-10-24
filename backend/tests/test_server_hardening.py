"""The live server's hardening (24 Oct 2026, the app went on the internet): the
page route never reads a path outside the frontend build, and the interactive
debugger is never mounted by run.py."""
import os

import pytest

from app.spa import _dist_dir

HAS_BUILD = os.path.isfile(os.path.join(_dist_dir(), "index.html"))


@pytest.mark.skipif(not HAS_BUILD, reason="no frontend build: the page route is not mounted")
def test_a_path_outside_the_build_is_never_looked_at(app, tmp_path):
    """An absolute path used to reach the disk before any check: an existing
    file answered 404 and a missing one the app page — a free "does this file
    exist" for anyone. Now both get the app page."""
    client = app.test_client()
    real = tmp_path / "secret.txt"
    real.write_text("x")
    there = client.get("/" + str(real).replace("\\", "/"))
    missing = client.get("/" + str(tmp_path / "no-such-file.txt").replace("\\", "/"))
    assert there.status_code == missing.status_code == 200
    assert there.data == missing.data and b"<div id=\"root\">" in there.data
    for probe in ("/..%2f..%2fbackend%2fconfig.py", "/%5C%5Cserver%5Cshare%5Cx"):
        r = client.get(probe)
        assert r.status_code == 200 and b"<div id=\"root\">" in r.data


@pytest.mark.skipif(not HAS_BUILD, reason="no frontend build: the page route is not mounted")
def test_a_file_of_the_build_is_still_served(app):
    r = app.test_client().get("/favicon.svg")
    assert r.status_code == 200 and b"<svg" in r.data


def test_run_py_never_mounts_the_interactive_debugger():
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "run.py")
    src = open(path, encoding="utf-8").read()
    assert "use_debugger=False" in src


# ---- the live server's settings, done by the app itself -----------------------------------------

def _cookie(resp):
    return "; ".join(v for k, v in resp.headers.items() if k.lower() == "set-cookie")


def test_the_sign_in_cookie_is_secure_on_https_only(app):
    c = app.test_client()
    plain = _cookie(c.get("/api/v1/auth/captcha"))
    https = _cookie(c.get("/api/v1/auth/captcha", base_url="https://localhost"))
    assert "session=" in plain and "Secure" not in plain        # the plant LAN's plain HTTP
    assert "session=" in https and "Secure" in https


def test_a_proxy_on_the_private_network_is_believed_and_the_internet_is_not(app):
    c = app.test_client()
    url = "/api/v1/auth/captcha"
    via_proxy = c.get(url, headers={"X-Forwarded-Proto": "https"}, environ_base={"REMOTE_ADDR": "127.0.0.1"})
    assert "Secure" in _cookie(via_proxy)
    lan_proxy = c.get(url, headers={"X-Forwarded-Proto": "https"}, environ_base={"REMOTE_ADDR": "10.1.2.3"})
    assert "Secure" in _cookie(lan_proxy)
    forged = c.get(url, headers={"X-Forwarded-Proto": "https"}, environ_base={"REMOTE_ADDR": "8.8.8.8"})
    assert "Secure" not in _cookie(forged)


def test_a_weak_or_missing_secret_key_is_replaced_by_one_the_app_keeps(tmp_path):
    from flask import Flask

    from app import SECRET_KEY_FILE, _ensure_secret_key

    def fresh(key):
        a = Flask("keytest", instance_path=str(tmp_path / "instance"))
        a.config["SECRET_KEY"] = key
        _ensure_secret_key(a)
        return a.config["SECRET_KEY"]

    first = fresh("dev-secret")
    assert len(first) >= 32 and first != "dev-secret"
    kept = tmp_path / "instance" / SECRET_KEY_FILE
    assert kept.read_text(encoding="utf-8").strip() == first
    assert fresh(None) == first == fresh("short") == fresh("change-me-in-production")   # one key, every restart
    strong = "x" * 20 + "-strong-key-from-the-env-file"
    assert fresh(strong) == strong                                                      # a good .env key is used as is
