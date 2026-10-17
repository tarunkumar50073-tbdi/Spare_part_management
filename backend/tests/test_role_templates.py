"""Role templates for User Management (store's request of 17 Oct 2026:
"template bana de" — one pick of a type and all its rights fall into place).

The six types — Store Staff, Store Supervisor, Line User, Kiosk device, Manager,
Live Board — are defined once, in frontend/src/lib/roleTemplates.json, which the
User Management screen imports. This test reads the SAME file, so a template
cannot drift away from what is proven here:

* every right is a real module, edit carries view, and every template is a
  Store User of the Spare Parts Store; the narrow ones hold their one screen's
  right and nothing else (no scan_part / store_stock on the line user or the
  kiosk), and the manager and the board hold no edit anywhere;
* the screens each one opens — App.jsx's RequirePermission routes, judged the
  way the SPA's can() does — are the ones it is meant for, and none of them
  turns it away inside the page (an administrators-only check of its own, as
  Scan Audit had); the only store menu item gated by no right at all is the
  read-only alert list (Notification Center), on purpose;
* a login created through the admin API exactly as the form sends it carries the
  template's rights and store, and, signed in as it, the endpoints its screens
  call answer while those of screens it must not use are refused (403).

"== 403" pins a refusal. An allowed write is either done for real on this file's
own part (issue, count, put-away, kiosk request, install confirm) or — for a
master-data write — sent with an empty body, where anything but 401 / 403 (a 422 /
400 for the missing fields) shows the right let it through without writing a thing.
All of it runs on conftest's throwaway DB; the parts, people, requests and users
made here are switched off afterwards.
"""
import json
import pathlib
import re
import uuid

import pytest

from app.extensions import db
from app.models.employee import Employee
from app.models.part import Part
from app.models.part_request import PartRequest
from app.models.spare_stock import SpareStockLedger
from app.models.user import PERMISSION_MODULES, ROLES, User
from app.services.part_request_service import PartRequestService
from app.services.spare_stock_service import SpareStockService

_ROOT = pathlib.Path(__file__).resolve().parents[2]
_TEMPLATES_FILE = _ROOT / "frontend" / "src" / "lib" / "roleTemplates.json"
_SRC = _ROOT / "frontend" / "src"
_APP_JSX = _SRC / "App.jsx"
_SIDEBAR = _SRC / "components" / "Sidebar.jsx"

TEMPLATES = {t["key"]: t for t in json.loads(_TEMPLATES_FILE.read_text(encoding="utf-8"))["templates"]}
KEYS = list(TEMPLATES)
STORE = "MAINTENANCE"
DEPT = "Maintenance"           # a Department master name the issue accepts
_TAG = uuid.uuid4().hex[:6].upper()
_seq = {"n": 0}


def _n():
    _seq["n"] += 1
    return _seq["n"]


def _can(perms, mod, action="view"):
    """The SPA's can() (utils/permissions.js) for a store user: edit implies view."""
    p = perms.get(mod) or {}
    return bool(p.get("edit")) if action == "edit" else bool(p.get("view") or p.get("edit"))


# ---- the definitions themselves ----------------------------------------------------------

def test_the_six_templates_the_store_approved():
    assert KEYS == ["store_staff", "store_supervisor", "line_user", "kiosk", "manager", "live_board"]
    for t in TEMPLATES.values():
        assert t["label"] and t["short"] and t["description"], t["key"]


@pytest.mark.parametrize("key", KEYS)
def test_template_is_well_formed(key):
    t = TEMPLATES[key]
    modules = {m["key"] for m in PERMISSION_MODULES}
    assert t["role"] == "STORE_USER" and t["role"] in ROLES
    assert t["stores"] == [STORE]
    assert t["permissions"], "a template grants something"
    for mod, p in t["permissions"].items():
        assert mod in modules, f"{key}: unknown module {mod}"
        assert set(p) == {"view", "edit"} and all(isinstance(v, bool) for v in p.values())
        assert p["view"], f"{key}.{mod}: edit without view, or a right that grants nothing"
        assert mod in t["why"], f"{key}.{mod}: say which screen needs it"
    assert set(t["why"]) == set(t["permissions"])
    # Nobody made from a template is an administrator in disguise.
    assert "admin" not in t["permissions"]


def test_narrow_templates_hold_only_their_one_screen():
    assert set(TEMPLATES["line_user"]["permissions"]) == {"install_confirm"}
    assert set(TEMPLATES["kiosk"]["permissions"]) == {"kiosk"}
    assert set(TEMPLATES["live_board"]["permissions"]) == {"live_dashboard"}
    for key in ("line_user", "kiosk", "live_board"):
        perms = TEMPLATES[key]["permissions"]
        assert not _can(perms, "scan_part") and not _can(perms, "store_stock"), key


@pytest.mark.parametrize("key", ["manager", "live_board"])
def test_view_only_templates_change_nothing(key):
    assert not any(p["edit"] for p in TEMPLATES[key]["permissions"].values())


def test_supervisor_has_everything_staff_has():
    staff = TEMPLATES["store_staff"]["permissions"]
    sup = TEMPLATES["store_supervisor"]["permissions"]
    for mod, p in staff.items():
        for action in ("view", "edit"):
            if p[action]:
                assert _can(sup, mod, action), (mod, action)


# ---- the screens each template opens (App.jsx) -------------------------------------------

_ROUTE = re.compile(r'<Route path="([^"]+)" element=\{<RequirePermission mod="(\w+)"(?: action="(\w+)")?>')


def _gated_routes():
    routes = _ROUTE.findall(_APP_JSX.read_text(encoding="utf-8"))
    assert len(routes) > 20, "App.jsx route pattern not found — update _ROUTE"
    return routes


def _opens(key):
    perms = TEMPLATES[key]["permissions"]
    return {path for path, mod, action in _gated_routes() if _can(perms, mod, action or "view")}


WRITE_SCREENS = {"/scan-part", "/part-requests", "/work-queue", "/confirm-installation", "/kiosk",
                 "/parts", "/data-quality", "/departments"}


def test_line_user_kiosk_and_board_open_only_their_screen():
    assert _opens("line_user") == {"/confirm-installation"}
    assert _opens("kiosk") == {"/kiosk"}
    assert _opens("live_board") == {"/live-dashboard"}


def test_staff_screens():
    opens = _opens("store_staff")
    assert {"/store/MAINTENANCE", "/scan-part", "/part-requests", "/work-queue", "/store-stock-spare",
            "/put-away-check", "/inventory-control", "/spare-part-history", "/reports", "/employees",
            "/equipment", "/receiving", "/consumption", "/action-tracker"} <= opens
    assert not opens & {"/parts", "/data-quality", "/departments", "/scan-audit", "/audit-trail",
                        "/spare-erp-gap", "/erp-control", "/kiosk", "/confirm-installation",
                        "/live-dashboard"}


def test_supervisor_screens():
    opens = _opens("store_supervisor")
    assert _opens("store_staff") | {"/parts", "/data-quality", "/departments", "/scan-audit",
                                    "/audit-trail", "/spare-erp-gap", "/erp-control"} == opens
    assert not opens & {"/kiosk", "/confirm-installation", "/live-dashboard"}


def test_manager_sees_the_store_but_no_work_screen():
    opens = _opens("manager")
    assert {"/store/MAINTENANCE", "/store-stock-spare", "/inventory-control", "/spare-part-history",
            "/spare-erp-gap", "/erp-control", "/reports", "/audit-trail", "/live-dashboard",
            "/receiving", "/consumption", "/action-tracker"} <= opens
    assert not opens & WRITE_SCREENS


# A route that lets the right in can still refuse inside the page: Scan Audit
# answered "an administrator view" to everyone but an admin, so the supervisor's
# right opened the menu item and nothing more. No page a template opens may check
# for an administrator on its own (Admin, Rights Matrix, Settings and the mail
# engine's screens do, and no template opens those).
_LAZY = re.compile(r'const (\w+) = React\.lazy\(\(\) => import\("\./([^"]+)"\)\);')
_ROUTE_ELEMENT = re.compile(
    r'<Route path="([^"]+)" element=\{<RequirePermission mod="\w+"(?: action="\w+")?><(\w+) />')
_ADMIN_GATE = re.compile(r"if \(!\s*(?:user\?\.is_admin|isAdmin)\)|<AdminOnly\b")


def _page_files(path):
    """The page file(s) behind a gated route — through a small wrapper of
    App.jsx's own (PutAwayCheckRoute) to the lazy page it renders."""
    app = _APP_JSX.read_text(encoding="utf-8")
    lazy = dict(_LAZY.findall(app))
    files = []
    for route, comp in _ROUTE_ELEMENT.findall(app):
        if route != path:
            continue
        if comp in lazy:
            files.append(lazy[comp])
        else:
            body = re.search(rf"function {comp}\(\)[\s\S]*?\n\}}", app).group(0)
            files += [lazy[tag] for tag in re.findall(r"<(\w+)\b", body) if tag in lazy]
    return files


@pytest.mark.parametrize("key", KEYS)
def test_no_screen_a_template_opens_refuses_it_inside(key):
    for path in _opens(key):
        files = _page_files(path)
        assert files, f"{path}: page file not found in App.jsx"
        for rel in files:
            src = (_SRC / rel).read_text(encoding="utf-8")
            assert not _ADMIN_GATE.search(src), f"{key}: {path} ({rel}) is administrators only inside the page"


def test_the_only_ungated_store_menu_item_is_the_alert_list():
    """Every Spare Parts Store menu item and every Email & Notifications item
    names a right or is administrators only — except Notification Center, which
    every store login sees (the Line User too): the store's live alerts, read
    only, the same list the top-bar bell shows, each "open" button offered only
    when the login may open that screen (canOpenAction)."""
    side = _SIDEBAR.read_text(encoding="utf-8")
    block = (side[side.index("  MAINTENANCE: ["):side.index("const SYSTEM_GROUP")]
             + side[side.index("const EMAIL_GROUP"):side.index("const navFor")])
    items = re.findall(r'\{ to: "([^"]+)",([^}]*)\}', block)
    assert len(items) > 20, "Sidebar.jsx item pattern not found — update the test"
    ungated = {to for to, rest in items if "mod:" not in rest and "admin: true" not in rest}
    assert ungated == {"/notifications"}
    page = (_SRC / "pages" / "spare" / "NotificationCenter.jsx").read_text(encoding="utf-8")
    assert "canOpen={canOpenAction(user, a.action)}" in page


# ---- signed in as each template --------------------------------------------------------

@pytest.fixture()
def client(app):
    return app.test_client()


def _as(client, user_id):
    with client.session_transaction() as sess:
        sess["user_id"] = user_id
    return client


@pytest.fixture()
def world():
    """This test's own part (with stock and a bin), a person on the Employee
    master, one issue of that part waiting for its line / machine, and an admin
    to create the logins. Switched off afterwards."""
    n = _n()
    part = Part(part_no=f"RT-{_TAG}-{n}", part_name=f"Role Template {n}", uom="NO", part_type="OTHER",
                store_code=STORE, location=f"RT{n}-S1-B1")
    person = Employee(mobile=f"6{uuid.uuid4().int % 10 ** 9:09d}", name=f"RT Person {n}",
                      employee_code=f"E-RT-{_TAG}-{n}", department=DEPT)
    admin = User(username=f"rt_admin_{_TAG}_{n}", role="ADMIN", is_active=True)
    admin.set_password("pw-admin")
    db.session.add_all([part, person, admin])
    db.session.commit()
    stock = SpareStockService()
    stock.set_quantity(part.id, 10.0, txn_type="OPENING")
    stock.issue(part.id, 1, DEPT, employee_id=person.id)
    issue = (SpareStockLedger.query.filter_by(part_id=part.id, txn_type="ISSUE")
             .order_by(SpareStockLedger.id.desc()).first())
    made = {"users": [admin.id]}
    yield {"part": part.id, "location": part.location, "person": person.id, "mobile": person.mobile,
           "issue": issue.id, "admin": admin.id, "made": made}

    for r in PartRequest.query.filter_by(part_id=part.id, status="PENDING").all():
        r.status = "CANCELLED"
    db.session.get(Part, part.id).is_active = False
    db.session.get(Employee, person.id).is_active = False
    for uid in made["users"]:
        db.session.get(User, uid).is_active = False
    db.session.commit()


def _login_from_template(client, world, key):
    """Create the login through the admin API with exactly what the form sends
    after a template is picked, then sign in as it."""
    t = TEMPLATES[key]
    _as(client, world["admin"])
    resp = client.post("/api/v1/admin/users", json={
        "username": f"rt_{key}_{_TAG}_{_n()}", "full_name": t["label"], "role": t["role"],
        "is_active": True, "password": "pw-1234", "stores": t["stores"], "permissions": t["permissions"],
    })
    assert resp.status_code == 200, resp.get_json()
    saved = resp.get_json()["data"]
    world["made"]["users"].append(saved["id"])
    assert saved["role"] == "STORE_USER" and saved["stores"] == [STORE]
    assert saved["permissions"] == t["permissions"]
    return _as(client, saved["id"])


def _call(c, method, url, body=None):
    fn = getattr(c, method)
    return fn(url, json=body) if body is not None else fn(url)


def _check(c, allowed, refused):
    for method, url, body, expect in allowed:
        resp = _call(c, method, url, body)
        if expect == "ok":
            assert resp.status_code in (200, 201), (method, url, resp.status_code, resp.get_json())
        else:   # "passes": the right let it through; the empty body (422 / 400) stopped it
            assert resp.status_code not in (401, 403), (method, url, resp.status_code, resp.get_json())
    for method, url, body in refused:
        resp = _call(c, method, url, body)
        assert resp.status_code == 403, (method, url, resp.status_code, resp.get_json())


def _q(path):
    return f"{path}{'&' if '?' in path else '?'}store_code={STORE}"


# Reads every template that opens the Spare Parts Store dashboard needs.
DASHBOARD = [
    ("get", _q("/api/v1/dashboard/spare/overview"), None, "ok"),
    ("get", _q("/api/v1/dashboard/spare/management"), None, "ok"),
]
ADMIN_ONLY = [
    ("get", "/api/v1/admin/users", None),
    ("post", "/api/v1/admin/users", {}),
    ("put", "/api/v1/dashboard/spare/action-tracker/critical", {"store_code": STORE}),
    ("put", "/api/v1/erp-grn/settings", {}),
]


def _staff_allowed(w):
    return DASHBOARD + [
        ("get", _q("/api/v1/receiving-monitor"), None, "ok"),
        ("get", _q("/api/v1/consumption-analytics"), None, "ok"),
        # Scan Part / Part Requisition / Work Queue
        ("get", _q("/api/v1/part-requests"), None, "ok"),
        ("get", f"/api/v1/spare-flow/parts/{w['part']}/scan-result", None, "ok"),
        ("get", f"/api/v1/employees/lookup?mobile={w['mobile']}", None, "ok"),
        ("get", "/api/v1/equipment?kind=LINE&active=1", None, "ok"),
        ("post", f"/api/v1/spare-stock/parts/{w['part']}/issue",
         {"qty": 1, "department": DEPT, "employee_id": w["person"]}, "ok"),
        # Store Stock count, Put-away Check, Critical · Reorder · Excess
        ("put", f"/api/v1/spare-stock/parts/{w['part']}", {"qty_on_hand": 12, "txn_type": "ADJUSTMENT"}, "ok"),
        ("post", "/api/v1/spare-stock/put-away/record",
         {"part_id": w["part"], "scanned_location": w["location"]}, "ok"),
        ("get", _q("/api/v1/inventory-control"), None, "ok"),
        # Employee / Line-Machine-Die masters (read), Reports
        ("get", "/api/v1/employees?active=1", None, "ok"),
        ("get", _q("/api/v1/reports/catalog"), None, "ok"),
    ]


SUPERVISOR_EXTRA = [
    ("post", "/api/v1/parts", {}),                 # Part Master
    ("get", _q("/api/v1/data-quality"), None),     # Data Quality
    ("post", "/api/v1/barcode/mapping", {}),       # supplier barcode mapping (Scan Part)
    ("post", "/api/v1/departments", {}),           # Department Emails
    ("get", "/api/v1/departments/reorder-mail/status", None),
    ("get", "/api/v1/barcode/scan-audit", None),   # Scan Audit
    ("get", "/api/v1/audit-logs", None),           # Audit Trail
    ("get", _q("/api/v1/erp-control/status"), None),   # ERP Control Center
    ("put", "/api/v1/employees/{person}", {"designation": "Fitter"}),   # Employee Master edit
    ("post", "/api/v1/equipment/import", None),    # Line / Machine / Die master import (no file)
]


def _supervisor_extra(w, allowed):
    out = []
    for method, url, body in SUPERVISOR_EXTRA:
        url = url.format(person=w["person"])
        if not allowed:
            out.append((method, url, body))
        elif method == "get" or url.startswith("/api/v1/employees/"):
            out.append((method, url, body, "ok"))
        else:
            out.append((method, url, body, "passes"))
    return out


def test_store_staff_reaches_its_screens(client, world):
    c = _login_from_template(client, world, "store_staff")
    assert [s["code"] for s in c.get("/api/v1/stores").get_json()["data"]] == [STORE]
    # A kiosk request waiting in Part Requisition, for the staff to issue.
    req = PartRequestService().create(STORE, {"part_id": world["part"], "requested_qty": 1, "department": DEPT})
    _check(c, _staff_allowed(world) + [
        # Scan Part: a return against the issue; Receive & Label's gate-entry
        # labels (listed; a print with an empty body passes the right, stops at 422)
        ("post", f"/api/v1/spare-stock/issues/{world['issue']}/return", {"qty": 1, "reason": "Not used"}, "ok"),
        ("get", _q("/api/v1/gate-labels"), None, "ok"),
        ("post", "/api/v1/gate-labels/print", {"store_code": STORE}, "passes"),
        # Part Requisition: issue the kiosk's request from its bin
        ("post", f"/api/v1/part-requests/{req['id']}/issue",
         {"scanned_location": world["location"], "issued_qty": 1}, "ok"),
    ], _supervisor_extra(world, allowed=False) + ADMIN_ONLY + [
        ("post", "/api/v1/part-requests", {"store_code": STORE, "part_id": world["part"],
                                           "requested_qty": 1, "department": DEPT}),   # the kiosk's
    ])
    row = db.session.get(PartRequest, req["id"])
    db.session.refresh(row)
    assert row.status == "ISSUED"
    # Scan Part's people list (the issue / return forms) still reads the whole
    # master — only a kiosk-only login is held to a number's first digits.
    people = c.get("/api/v1/employees?active=1").get_json()["data"]
    assert any(p["id"] == world["person"] for p in people)


def test_store_supervisor_reaches_its_screens(client, world):
    c = _login_from_template(client, world, "store_supervisor")
    _check(c, _staff_allowed(world) + _supervisor_extra(world, allowed=True) + [
        ("get", _q("/api/v1/barcode/scan-audit"), None, "ok"),        # as the Scan Audit page asks
    ], ADMIN_ONLY + [
        ("post", "/api/v1/part-requests", {"store_code": STORE, "part_id": world["part"],
                                           "requested_qty": 1, "department": DEPT}),
        ("get", "/api/v1/barcode/scan-audit?store_code=CHILD_PART", None),   # not one of its stores
    ])


def test_line_user_only_confirms_installation(client, world):
    c = _login_from_template(client, world, "line_user")
    assert [s["code"] for s in c.get("/api/v1/stores").get_json()["data"]] == [STORE]
    _check(c, [
        ("get", _q("/api/v1/spare-stock/pending-confirmations"), None, "ok"),
        ("get", _q("/api/v1/spare-stock/installations"), None, "ok"),
        ("get", f"/api/v1/spare-flow/parts/{world['part']}/scan-result", None, "ok"),
        ("get", "/api/v1/equipment?kind=MACHINE&active=1", None, "ok"),     # the pick-lists
        ("post", f"/api/v1/spare-stock/issues/{world['issue']}/confirm",
         {"line_name": "Seat Track", "line_no": "L2", "machine": "MC-9"}, "ok"),
    ], [
        ("get", _q("/api/v1/part-requests"), None),                          # Part Requisition
        ("post", f"/api/v1/spare-stock/parts/{world['part']}/issue", {"qty": 1, "department": DEPT}),
        ("post", f"/api/v1/spare-stock/issues/{world['issue']}/return", {}),
        ("put", f"/api/v1/spare-stock/parts/{world['part']}", {"qty_on_hand": 1}),   # stock count
        ("get", _q("/api/v1/inventory-control"), None),
        *[(m, u, b) for m, u, b, _ in DASHBOARD],
        ("get", f"/api/v1/employees/lookup?mobile={world['mobile']}", None),
        ("post", "/api/v1/equipment", {"kind": "MACHINE", "name": "New one"}),
        ("get", _q("/api/v1/reports/catalog"), None),
        *ADMIN_ONLY,
    ])
    row = db.session.get(SpareStockLedger, world["issue"])
    db.session.refresh(row)
    assert row.machine == "MC-9" and row.confirmed_at is not None


def test_kiosk_only_sends_a_request(client, world):
    c = _login_from_template(client, world, "kiosk")
    _check(c, [
        ("get", _q("/api/v1/spare-stock"), None, "ok"),                       # the part search
        ("get", "/api/v1/departments", None, "ok"),
        ("get", f"/api/v1/employees/lookup?mobile={world['mobile']}", None, "ok"),
        ("get", f"/api/v1/employees?q={world['mobile'][:4]}&active=1&limit=50", None, "ok"),
        ("post", "/api/v1/part-requests", {"store_code": STORE, "part_id": world["part"], "requested_qty": 2,
                                           "employee_id": world["person"], "department": DEPT}, "ok"),
    ], [
        ("get", _q("/api/v1/part-requests"), None),                           # the supervisor's queue
        ("post", "/api/v1/employees", {"mobile": "6000000001", "name": "X", "department": DEPT}),
        ("get", "/api/v1/employees/export", None),                           # Employee Master's Excel
        ("post", f"/api/v1/spare-stock/parts/{world['part']}/issue", {"qty": 1, "department": DEPT}),
        ("put", f"/api/v1/spare-stock/parts/{world['part']}", {"qty_on_hand": 1}),
        ("get", _q("/api/v1/inventory-control"), None),
        *[(m, u, b) for m, u, b, _ in DASHBOARD],
        *ADMIN_ONLY,
    ])
    req = PartRequest.query.filter_by(part_id=world["part"]).one()
    assert req.status == "PENDING" and float(req.requested_qty) == 2.0
    assert _call(c, "post", f"/api/v1/part-requests/{req.id}/issue", {}).status_code == 403

    # The person list answers the kiosk's type-ahead and no more: active people
    # whose number STARTS with the digits typed, at most 20 — no digits, no one,
    # so the device cannot read the Employee Master in one call.
    def people(query):
        resp = c.get(f"/api/v1/employees{query}")
        assert resp.status_code == 200, resp.get_json()
        return resp.get_json()["data"]

    prefix = world["mobile"][:4]
    found = people(f"?q={prefix}&active=1&limit=50")
    assert any(p["id"] == world["person"] for p in found)
    assert len(found) <= 20 and all(p["mobile"].startswith(prefix) and p["is_active"] for p in found)
    assert people("?active=1") == [] and people("?q=&limit=500") == [] and people("?q=RT%20Person") == []
    assert len(people("?q=6&limit=500")) <= 20


def test_manager_sees_everything_and_changes_nothing(client, world):
    c = _login_from_template(client, world, "manager")
    _check(c, DASHBOARD + [
        ("get", _q("/api/v1/receiving-monitor"), None, "ok"),
        ("get", _q("/api/v1/consumption-analytics"), None, "ok"),
        ("get", _q("/api/v1/inventory-control"), None, "ok"),
        ("get", _q("/api/v1/spare-stock"), None, "ok"),
        ("get", f"/api/v1/spare-stock/parts/{world['part']}/history", None, "ok"),   # Part Ledger
        ("get", _q("/api/v1/erp-control/status"), None, "ok"),
        ("get", _q("/api/v1/spare-stock/erp-gap"), None, "ok"),
        ("get", _q("/api/v1/reports/catalog"), None, "ok"),
        ("get", "/api/v1/audit-logs", None, "ok"),
    ], [
        ("put", f"/api/v1/spare-stock/parts/{world['part']}", {"qty_on_hand": 1}),
        ("post", "/api/v1/spare-stock/put-away/record", {"part_id": world["part"],
                                                         "scanned_location": world["location"]}),
        ("post", _q("/api/v1/spare-stock/erp-sync"), None),
        ("post", _q("/api/v1/spare-stock/import"), None),
        ("post", _q("/api/v1/erp-grn/post"), None),
        ("post", f"/api/v1/spare-stock/parts/{world['part']}/issue", {"qty": 1, "department": DEPT}),
        ("get", _q("/api/v1/part-requests"), None),
        ("post", f"/api/v1/spare-stock/issues/{world['issue']}/confirm", {"machine": "MC-1"}),
        ("post", "/api/v1/parts", {}),
        ("post", "/api/v1/departments", {}),
        ("put", f"/api/v1/employees/{world['person']}", {"designation": "X"}),
        *ADMIN_ONLY,
    ])


def test_live_board_sees_only_the_board(client, world):
    c = _login_from_template(client, world, "live_board")
    _check(c, DASHBOARD + [
        ("get", _q("/api/v1/spare-stock"), None, "ok"),
        ("get", _q("/api/v1/spare-stock/today"), None, "ok"),
        ("get", _q("/api/v1/spare-stock/flow"), None, "ok"),
        ("get", _q("/api/v1/spare-stock/activity"), None, "ok"),
        ("get", _q("/api/v1/spare-flow/queues"), None, "ok"),
    ], [
        ("get", _q("/api/v1/receiving-monitor"), None),
        ("get", _q("/api/v1/consumption-analytics"), None),
        ("get", _q("/api/v1/inventory-control"), None),
        ("get", _q("/api/v1/reports/catalog"), None),
        ("get", "/api/v1/audit-logs", None),
        ("get", _q("/api/v1/erp-control/status"), None),
        ("put", f"/api/v1/spare-stock/parts/{world['part']}", {"qty_on_hand": 1}),
        ("post", f"/api/v1/spare-stock/parts/{world['part']}/issue", {"qty": 1, "department": DEPT}),
        *ADMIN_ONLY,
    ])
