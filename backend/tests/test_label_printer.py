"""Label printer (spec 8) — admin config, honest status, and who may print.

The status is never a guessed Online / Offline: BROWSER printing reads
NOT_DETECTABLE without touching the network, and a NETWORK printer is REACHABLE
only when a real TCP connect to it succeeds — checked here against a socket the
test itself listens on, and a port nothing listens on.

The DB is shared by the whole session, so every test that saves the printer puts
the previous setting back (the `saved_printer` fixture).
"""
import socket
import threading
import time

import pytest

from app import db
from app.models.app_setting import AppSetting
from app.models.part import Part
from app.models.user import User, UserStoreAccess
from app.services import barcode_service
from app.services.barcode_service import PRINTER_SETTING_KEY

_seq = {"n": 0}

DEFAULT_NAME = "Spare Parts Store Label Printer"
BROWSER_DETAIL = "Status can't be detected — printing uses the browser print dialog"


def _next():
    _seq["n"] += 1
    return _seq["n"]


@pytest.fixture()
def client(app):
    return app.test_client()


@pytest.fixture()
def saved_printer():
    """Snapshot the label_printer setting and restore it after the test."""
    before = AppSetting.get_value(PRINTER_SETTING_KEY)
    yield
    row = AppSetting.query.filter_by(key=PRINTER_SETTING_KEY).first()
    if before is None:
        if row is not None:
            db.session.delete(row)
            db.session.commit()
    else:
        AppSetting.set_value(PRINTER_SETTING_KEY, before)


def _login(client, user):
    with client.session_transaction() as sess:
        sess["user_id"] = user.id
    return user


def _user(role="STORE_USER", perms=None, stores=("MAINTENANCE",)):
    u = User(username=f"lp{_next()}", role=role, is_active=True)
    u.set_password("pw")
    if perms:
        u.set_permissions(perms)
    db.session.add(u)
    db.session.flush()
    for code in stores:
        db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
    db.session.commit()
    return u


def _part():
    p = Part(part_no=f"LP-{_next():04d}", part_name="Proximity Sensor", uom="NO",
             part_type="OTHER", store_code="MAINTENANCE", location="A1-03")
    db.session.add(p)
    db.session.commit()
    return p


def _put(client, **body):
    return client.put("/api/v1/admin/label-printer", json=body)


def _status(client):
    r = client.get("/api/v1/barcode/printer-status")
    assert r.status_code == 200, r.get_json()
    return r.get_json()["data"]


def _free_port():
    """A local port nothing listens on (bound, then released)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# ---- config (admin) ----

def test_default_printer_is_the_browser_dialog(client, saved_printer):
    _login(client, _user("ADMIN"))
    AppSetting.query.filter_by(key=PRINTER_SETTING_KEY).delete()
    db.session.commit()
    cfg = client.get("/api/v1/admin/label-printer").get_json()["data"]
    assert cfg == {"name": DEFAULT_NAME, "connection": "BROWSER", "host": None, "port": 9100}


def test_admin_saves_a_network_printer(client, saved_printer):
    _login(client, _user("ADMIN"))
    r = _put(client, name="  Store Zebra  ", connection="NETWORK", host=" 10.20.30.40 ", port=9100)
    assert r.status_code == 200, r.get_json()
    assert r.get_json()["data"] == {"name": "Store Zebra", "connection": "NETWORK",
                                    "host": "10.20.30.40", "port": 9100}
    assert AppSetting.get_value(PRINTER_SETTING_KEY)["host"] == "10.20.30.40"
    # A partial update keeps the rest; a blank name falls back to the default.
    r = _put(client, port=6101, name="   ")
    assert r.get_json()["data"] == {"name": DEFAULT_NAME, "connection": "NETWORK",
                                    "host": "10.20.30.40", "port": 6101}


@pytest.mark.parametrize("host", ["zebra-store01.plant.local", "PRINTER1", "::1", "192.168.0.10"])
def test_host_accepts_ip_or_hostname(client, saved_printer, host):
    _login(client, _user("ADMIN"))
    r = _put(client, connection="NETWORK", host=host, port=9100)
    assert r.status_code == 200, r.get_json()
    assert r.get_json()["data"]["host"] == host


@pytest.mark.parametrize("body", [
    {"host": "http://10.0.0.5"},             # a URL, not an address
    {"host": "10.0.0.5:9100"},               # port belongs in its own field
    {"host": "10.0.0.300"},                  # not a valid IPv4
    {"host": "-bad-.local"},                 # label may not start/end with '-'
    {"host": "printer room"},                # spaces
    {"port": 0},
    {"port": 65536},
    {"connection": "USB"},
    {"name": "x" * 81},
    {"colour": "red"},                       # unknown field
])
def test_invalid_printer_config_is_rejected(client, saved_printer, body):
    _login(client, _user("ADMIN"))
    assert _put(client, **body).status_code == 422


def test_network_printer_needs_an_address(client, saved_printer):
    _login(client, _user("ADMIN"))
    AppSetting.query.filter_by(key=PRINTER_SETTING_KEY).delete()
    db.session.commit()
    r = _put(client, connection="NETWORK")
    assert r.status_code == 422
    assert "host" in r.get_json()["errors"]
    assert _put(client, connection="NETWORK", host="").status_code == 422
    # BROWSER needs none.
    assert _put(client, connection="BROWSER", host=None).status_code == 200


def test_printer_config_is_admin_only(client, saved_printer):
    _login(client, _user(perms={"scan_part": {"edit": True}, "store_stock": {"edit": True},
                                "part_master": {"edit": True}}))
    assert client.get("/api/v1/admin/label-printer").status_code == 403
    assert _put(client, connection="NETWORK", host="10.0.0.5").status_code == 403


# ---- status ----

def test_browser_printer_status_is_not_detectable_and_checks_nothing(client, saved_printer, monkeypatch):
    _login(client, _user("ADMIN"))
    # A host is saved but the connection is BROWSER: nothing may be probed.
    assert _put(client, name=DEFAULT_NAME, connection="BROWSER", host="10.0.0.5").status_code == 200

    def no_network(*a, **kw):
        raise AssertionError("BROWSER printing must not probe the network")

    # Any probe starts with a name lookup; neither it nor a connect may run.
    monkeypatch.setattr(socket, "getaddrinfo", no_network)
    monkeypatch.setattr(socket, "create_connection", no_network)
    _login(client, _user())                      # any signed-in user may read it
    data = _status(client)
    assert data == {"name": DEFAULT_NAME, "connection": "BROWSER", "status": "NOT_DETECTABLE",
                    "checked_at": None, "detail": BROWSER_DETAIL}


def test_network_printer_unreachable_on_a_closed_port(client, saved_printer):
    _login(client, _user("ADMIN"))
    port = _free_port()
    assert _put(client, connection="NETWORK", host="127.0.0.1", port=port).status_code == 200
    data = _status(client)
    assert data["connection"] == "NETWORK"
    assert data["status"] == "UNREACHABLE"
    assert data["checked_at"] is not None
    # The address stays admin-only; the status never echoes it.
    assert "127.0.0.1" not in data["detail"]


def test_network_printer_reachable_when_something_listens(client, saved_printer):
    _login(client, _user("ADMIN"))
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    try:
        port = listener.getsockname()[1]
        assert _put(client, name="Store Zebra", connection="NETWORK",
                    host="127.0.0.1", port=port).status_code == 200
        data = _status(client)
        assert (data["name"], data["connection"], data["status"]) == ("Store Zebra", "NETWORK", "REACHABLE")
        assert data["checked_at"] is not None
    finally:
        listener.close()


def test_a_hanging_name_lookup_is_bounded(client, saved_printer, monkeypatch):
    """getaddrinfo is not covered by a socket timeout (on a domain network an
    unknown name can hang for seconds in LLMNR / NetBIOS fallback), so the
    whole check has its own deadline and reads UNREACHABLE when it passes —
    never REACHABLE, and never holding the request past the deadline."""
    _login(client, _user("ADMIN"))
    assert _put(client, connection="NETWORK", host="zebra-store01.plant.local", port=9100).status_code == 200
    monkeypatch.setattr(barcode_service, "PRINTER_CHECK_DEADLINE_S", 0.3)
    release = threading.Event()

    def hanging_lookup(*a, **kw):
        release.wait(10)
        raise socket.gaierror("name lookup gave up")

    monkeypatch.setattr(socket, "getaddrinfo", hanging_lookup)
    try:
        started = time.monotonic()
        data = _status(client)
        elapsed = time.monotonic() - started
    finally:
        release.set()                         # let the abandoned worker finish
    assert elapsed < 2
    assert data["status"] == "UNREACHABLE"
    assert data["checked_at"] is not None
    assert "no answer within 2 s" in data["detail"]


def test_every_resolved_address_is_tried_within_the_deadline(client, saved_printer, monkeypatch):
    """A name can resolve to several addresses (IPv6 + IPv4); a printer that
    answers on the second one is reachable. The name is looked up once."""
    _login(client, _user("ADMIN"))
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    lookups = []
    closed = ("127.0.0.1", _free_port())
    open_ = listener.getsockname()

    def two_addresses(host, port, *a, **kw):
        lookups.append((host, port))
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", addr)
                for addr in (closed, open_)]

    assert _put(client, connection="NETWORK", host="zebra-store01.plant.local", port=9100).status_code == 200
    # Wide enough for a refused local connect, which Windows retries for ~1 s.
    monkeypatch.setattr(barcode_service, "PRINTER_CHECK_DEADLINE_S", 5)
    monkeypatch.setattr(socket, "getaddrinfo", two_addresses)
    try:
        assert _status(client)["status"] == "REACHABLE"
        assert lookups == [("zebra-store01.plant.local", 9100)]
    finally:
        listener.close()


def test_an_unknown_host_name_reads_not_found(client, saved_printer, monkeypatch):
    _login(client, _user("ADMIN"))
    assert _put(client, connection="NETWORK", host="no-such-printer.plant.local", port=9100).status_code == 200

    def not_found(*a, **kw):
        raise socket.gaierror(11001, "getaddrinfo failed")

    monkeypatch.setattr(socket, "getaddrinfo", not_found)
    data = _status(client)
    assert data["status"] == "UNREACHABLE"
    assert "host name not found" in data["detail"]
    assert "no-such-printer" not in data["detail"]


def test_printer_status_needs_sign_in(client):
    assert client.get("/api/v1/barcode/printer-status").status_code == 401


# ---- who may print ----

def test_print_needs_an_edit_right(client):
    part = _part()
    _login(client, _user())                                            # no module rights
    assert client.post("/api/v1/barcode/print", json={"part_id": part.id}).status_code == 403
    assert client.post("/api/v1/barcode/print-bulk", json={"part_ids": [part.id]}).status_code == 403
    _login(client, _user(perms={"scan_part": {"view": True}}))         # view is not enough
    assert client.post("/api/v1/barcode/print", json={"part_id": part.id}).status_code == 403


@pytest.mark.parametrize("module", ["scan_part", "store_stock", "part_master"])
def test_any_print_screen_edit_right_may_print(client, module):
    part = _part()
    _login(client, _user(perms={module: {"edit": True}}))
    r = client.post("/api/v1/barcode/print", json={"part_id": part.id, "source": "ERP_SEARCH",
                                                   "printer_name": DEFAULT_NAME})
    assert r.status_code == 201, r.get_json()
    assert r.get_json()["data"]["printer_name"] == DEFAULT_NAME
    bulk = client.post("/api/v1/barcode/print-bulk", json={"part_ids": [_part().id]})
    assert bulk.status_code == 201, bulk.get_json()
    assert bulk.get_json()["data"]["printed"][0]["source"] == "STORE_STOCK"


def test_print_right_does_not_cross_stores(client):
    part = _part()
    _login(client, _user(perms={"scan_part": {"edit": True}}, stores=("CHILD_PART",)))
    assert client.post("/api/v1/barcode/print", json={"part_id": part.id}).status_code == 403
