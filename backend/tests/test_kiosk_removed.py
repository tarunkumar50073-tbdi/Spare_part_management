"""The kiosk and the Part Requisition queue are gone (store, 17 Oct 2026:
"management k according manual detail fill karke issuance karna time waste h").
Parts are issued on Scan Part -> Issue, which stays.

What is proven here:

* the /api/v1/part-requests endpoints answer 404, for an administrator too;
* the part_requests table and its rows stay — an open request in it reaches no
  tracker line, scan figure, alert, report or catalogue;
* no right, role template, route, menu, quick-jump, launcher entry or tracker
  line names the kiosk or Part Requisition any more, and the deleted screens
  are not on disk;
* a login that still has the old "kiosk" right stored opens nothing with it,
  and the right drops off when that login's rights are saved;
* owners an administrator saved on the removed tracker line do not block the
  next save of the reminder settings.

All of it on conftest's throwaway DB.
"""
import json
import pathlib
import re
import uuid

import pytest
from sqlalchemy import inspect

from app.extensions import db
from app.models.part import Part
from app.models.part_request import PartRequest
from app.models.user import PERMISSION_MODULES, User, UserStoreAccess
from app.services import email_rules
from app.services.service_catalog import SERVICES
from app.services.spare_management_service import TRACKER_ITEMS, SpareManagementService
from app.services.spare_report_service import SpareReportService
from app.utils.exceptions import BadRequestError, NotFoundError

STORE = "MAINTENANCE"
_TAG = uuid.uuid4().hex[:6].upper()
_ROOT = pathlib.Path(__file__).resolve().parents[2]
_SRC = _ROOT / "frontend" / "src"
# Words of the removed feature as a screen, payload or catalogue would show them.
_GONE = ("kiosk_open", "/part-requests", "part_requests", "/kiosk", "kiosk part request",
         "part requisition", "part request (kiosk)")
_seq = {"n": 0}


def _n():
    _seq["n"] += 1
    return _seq["n"]


@pytest.fixture()
def client(app):
    return app.test_client()


def _login(client, role="ADMIN", permissions=None):
    """A login; `permissions` is written as stored JSON, the way an old login
    still holds it (set_permissions would drop a key it no longer knows)."""
    u = User(username=f"nokiosk_{_TAG}_{_n()}", role=role, is_active=True)
    u.set_password("pw-1234")
    db.session.add(u)
    db.session.flush()
    if permissions is not None:
        u.permissions = json.dumps(permissions)
    db.session.add(UserStoreAccess(user_id=u.id, store_code=STORE))
    db.session.commit()
    with client.session_transaction() as sess:
        sess["user_id"] = u.id
    return u


@pytest.fixture()
def open_request():
    """An old kiosk request still open in the table, as the live data has them."""
    n = _n()
    part = Part(part_no=f"NK-{_TAG}-{n}", part_name=f"No Kiosk {n}", uom="NO", part_type="OTHER",
                store_code=STORE, location=f"NK{n}-S1-B1")
    db.session.add(part)
    db.session.flush()
    row = PartRequest(reference_no=f"REQ-NK-{_TAG}-{n}", store_code=STORE, part_id=part.id,
                      part_no=part.part_no, part_name=part.part_name, requested_qty=2, issued_qty=0,
                      status="PENDING", department="Store")
    db.session.add(row)
    db.session.commit()
    yield row
    db.session.get(Part, part.id).is_active = False
    db.session.commit()


def _clean(payload):
    text = json.dumps(payload, ensure_ascii=False).lower()
    return [word for word in _GONE if word in text]


# ---- the endpoints -----------------------------------------------------------------------

def test_the_part_request_endpoints_are_gone(client, app, open_request):
    _login(client)
    rid = open_request.id
    for method, url, body in (
        ("get", f"/api/v1/part-requests?store_code={STORE}", None),
        ("post", "/api/v1/part-requests", {"store_code": STORE, "part_id": open_request.part_id,
                                           "requested_qty": 1, "department": "Store"}),
        ("get", f"/api/v1/part-requests/{rid}", None),
        ("post", f"/api/v1/part-requests/{rid}/issue", {"scanned_location": "NK-S1-B1", "issued_qty": 1}),
        ("post", f"/api/v1/part-requests/{rid}/cancel", {}),
    ):
        resp = getattr(client, method)(url, json=body) if body is not None else getattr(client, method)(url)
        # No such endpoint: 404 — or, for a POST, 405 when a frontend build is
        # present and only its GET-only catch-all (app/spa.py) matches the path.
        assert resp.status_code in ((404,) if method == "get" else (404, 405)), (method, url, resp.status_code)
    assert not [r.rule for r in app.url_map.iter_rules() if "part-request" in r.rule]
    # Nothing was written: the request is exactly as it was.
    db.session.refresh(open_request)
    assert (open_request.status, float(open_request.issued_qty), open_request.scanned_location) == (
        "PENDING", 0.0, None)


def test_the_table_and_its_rows_stay(open_request):
    assert PartRequest.__tablename__ == "part_requests"
    assert inspect(db.engine).has_table("part_requests")
    assert PartRequest.query.filter_by(reference_no=open_request.reference_no).one().status == "PENDING"


# ---- nothing shows them -------------------------------------------------------------------

def test_an_open_request_reaches_no_tracker_scan_alert_or_report(client, open_request):
    m = SpareManagementService().management(STORE)
    assert "kiosk_open" not in {it["key"] for it in m["tracker"]["items"]}
    assert "kiosk" not in m["scan"]
    _login(client)
    for url in (f"/api/v1/dashboard/spare/management?store_code={STORE}",
                f"/api/v1/dashboard/spare/overview?store_code={STORE}",
                f"/api/v1/spare-alerts?store_code={STORE}",
                f"/api/v1/reports/catalog?store_code={STORE}",
                "/api/v1/assistant/services"):
        resp = client.get(url)
        assert resp.status_code == 200, (url, resp.get_json())
        assert _clean(resp.get_json()["data"]) == [], url
    assert client.get(f"/api/v1/reports/part_requests/excel?store_code={STORE}").status_code == 404
    with pytest.raises(NotFoundError):
        SpareReportService().build(STORE, "part_requests")


def test_no_right_template_route_menu_or_tracker_line_names_them():
    assert "kiosk" not in {m["key"] for m in PERMISSION_MODULES}
    assert not [s for s in SERVICES if _clean(s)]
    assert not [spec for spec in TRACKER_ITEMS if _clean(spec)]

    templates = json.loads((_SRC / "lib" / "roleTemplates.json").read_text(encoding="utf-8"))["templates"]
    assert "kiosk" not in {t["key"] for t in templates}
    assert not [t["key"] for t in templates if "kiosk" in t["permissions"] or _clean(t)]

    app_jsx = (_SRC / "App.jsx").read_text(encoding="utf-8")
    assert not re.search(r'path="/(kiosk|part-requests)"', app_jsx)
    assert "KioskRequest" not in app_jsx and "PartRequests" not in app_jsx
    assert '{ to: "/kiosk"' not in app_jsx                         # the landing list
    for rel in ("components/Sidebar.jsx", "components/CommandPalette.jsx",
                "components/AttentionPopup.jsx", "pages/TvDashboard.jsx", "pages/Admin.jsx"):
        src = (_SRC / rel).read_text(encoding="utf-8")
        assert not re.search(r'to: "/(kiosk|part-requests)"', src), rel
        assert "kiosk_open" not in src and 'mod: "kiosk"' not in src and "kiosk: " not in src, rel
    for rel in ("pages/spare/KioskRequest.jsx", "pages/spare/PartRequests.jsx",
                "services/partRequestService.js"):
        assert not (_SRC / rel).exists(), rel
    leftover = [p.name for p in _SRC.rglob("*.js*") if "partRequestService" in p.read_text(encoding="utf-8")]
    assert leftover == []


# ---- an old kiosk login ------------------------------------------------------------------

def test_an_old_kiosk_login_opens_nothing_with_it(client):
    old = _login(client, role="STORE_USER", permissions={"kiosk": {"view": True, "edit": True}})
    assert client.get("/api/v1/employees/lookup?mobile=9876543210").status_code == 403
    assert client.get("/api/v1/employees?q=98&active=1").status_code == 403
    assert client.get(f"/api/v1/part-requests?store_code={STORE}").status_code == 404
    # Saved again (the admin form, the rights matrix), the unknown right drops off.
    old.set_permissions({"kiosk": {"view": True, "edit": True}, "reports": {"view": True, "edit": False}})
    assert json.loads(old.permissions) == {"reports": {"view": True, "edit": False}}
    db.session.rollback()


# ---- reminder owners saved on the removed line ---------------------------------------------

def test_owners_saved_on_the_removed_line_do_not_block_a_save():
    owner = [{"email": "owner@example.com", "role": "TO"}]
    stale = {"kiosk_open": {"department_ids": [], "emails": owner}}
    # The screen sends the whole map back, the old line included.
    saved = email_rules._owners({**stale, "critical": {"department_ids": [], "emails": owner}}, stale)
    assert saved == {"critical": {"department_ids": [], "emails": owner}}
    # A line that never existed is still refused.
    with pytest.raises(BadRequestError):
        email_rules._owners({"nope": {"department_ids": [], "emails": owner}}, {})
