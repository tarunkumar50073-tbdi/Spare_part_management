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
