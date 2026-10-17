"""Endpoints that used to be open to every signed-in user now check a right.

Reports and the audit trail are read-gated; the Child Parts Store write screens
(put-away, holding transfer, daily count, rack-alert resolve) need the
`child_store` right while that store is switched off; the spare ERP push needs
Store Stock edit. "== 403" checks a denial and "!= 403" an allow, so the test
pins the authorization decision, not the downstream payload validation.

The second half is the routes the machine key (X-API-Key) must not drive at
all: the mail server settings, the test mail, the two recipient masters, the
department master (who is ticked for the reorder mail, and under which name)
and the reorder mail's "Send now" need a signed-in person. The window-time
trigger a scheduled job may call still takes the key. No case there can send a
real mail — `mailer.send_email` is replaced by a recorder.
"""
import pytest

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.department import Department
from app.models.department_recipient import DepartmentRecipient
from app.models.email_engine import EmailMessage
from app.models.mail_send_log import MailSendLog
from app.models.report_recipient import ReportRecipient
from app.models.user import User, UserStoreAccess
from app.repositories.department_repository import DepartmentRepository
from app.services.reorder_mail_service import ReorderMailService
from app.services.settings_service import SMTP_SETTING_KEY
from app.utils import mailer

_seq = {"n": 0}
_ABSENT = object()


@pytest.fixture()
def client(app):
    return app.test_client()


def _user(role="STORE_USER", perms=None, stores=("MAINTENANCE",)):
    _seq["n"] += 1
    u = User(username=f"gateuser{_seq['n']}", role=role, is_active=True)
    u.set_password("pw")
    if perms:
        u.set_permissions(perms)
    db.session.add(u)
    db.session.flush()
    for code in stores:
        db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
    db.session.commit()
    return u


def _as(client, user):
    with client.session_transaction() as sess:
        sess["user_id"] = user.id
    return client


GATED = [
    ("get", "/api/v1/reports/srv/excel", None),
    ("get", "/api/v1/reports/srv/csv", None),
    ("get", "/api/v1/audit-logs", None),
    ("post", "/api/v1/notifications/999999/resolve", None),
    ("post", "/api/v1/holding/999999/transfer", {}),
    ("post", "/api/v1/store/srvs/999999/put-away/confirm", {}),
    ("post", "/api/v1/stock-count/submit", {}),
    ("post", "/api/v1/stock-count/import", None),
    ("post", "/api/v1/spare-stock/erp-sync?store_code=MAINTENANCE", None),
]


@pytest.mark.parametrize("method,url,body", GATED)
def test_plain_user_is_refused(client, method, url, body):
    c = _as(client, _user())
    resp = getattr(c, method)(url, json=body) if body is not None else getattr(c, method)(url)
    assert resp.status_code == 403, (url, resp.status_code, resp.get_json())


@pytest.mark.parametrize("method,url,body", GATED)
def test_admin_passes_the_gate(client, method, url, body):
    c = _as(client, _user(role="ADMIN", stores=()))
    resp = getattr(c, method)(url, json=body) if body is not None else getattr(c, method)(url)
    assert resp.status_code != 403, (url, resp.status_code, resp.get_json())


def test_granted_rights_open_exactly_their_endpoints(client):
    c = _as(client, _user(perms={"reports": {"view": True}, "audit_trail": {"view": True}}))
    assert c.get("/api/v1/reports/srv/csv").status_code != 403
    assert c.get("/api/v1/audit-logs").status_code != 403
    # ...but not the Child store's writes.
    assert c.post("/api/v1/stock-count/submit", json={}).status_code == 403


# ---- a signed-in person, never the machine key: mail settings and recipient masters ----

_MACHINE_REFUSED = "Sign in to do this — the machine key (X-API-Key) is not accepted for this action"


@pytest.fixture()
def machine(app):
    """The scheduled-job caller: no session, the shared key on every request."""
    c = app.test_client()
    c.environ_base["HTTP_X_API_KEY"] = app.config["API_KEY"]
    return c


@pytest.fixture()
def outbox(monkeypatch):
    """Replace mailer.send_email with a recorder that reports success; returns
    the list of what it was asked to send."""
    sent = []

    def record(**kw):
        sent.append(kw)
        return {"ok": True, "to": kw["to"], "cc": kw["cc"], "bcc": kw["bcc"]}

    monkeypatch.setattr(mailer, "send_email", record)
    return sent


@pytest.fixture()
def smtp_setting():
    """Put the saved mail-server setting back after a case that may write it."""
    saved = AppSetting.get_value(SMTP_SETTING_KEY, _ABSENT)
    yield
    db.session.rollback()
    if saved is _ABSENT:
        AppSetting.query.filter_by(key=SMTP_SETTING_KEY).delete()
        db.session.commit()
    else:
        AppSetting.set_value(SMTP_SETTING_KEY, saved)


def test_machine_key_cannot_change_the_mail_server_or_send_a_test_mail(machine, outbox, smtp_setting):
    before = AppSetting.get_value(SMTP_SETTING_KEY, _ABSENT)
    resp = machine.put("/api/v1/admin/smtp-config", json={"from_display": "Machine"})
    assert resp.status_code == 403 and resp.get_json()["message"] == _MACHINE_REFUSED
    assert AppSetting.get_value(SMTP_SETTING_KEY, _ABSENT) == before

    resp = machine.post("/api/v1/admin/smtp-test", json={"to": "anyone@example.com"})
    assert resp.status_code == 403 and resp.get_json()["message"] == _MACHINE_REFUSED
    assert outbox == []
    # Reading the settings stays open to the key.
    assert machine.get("/api/v1/admin/smtp-config").status_code == 200


def test_signed_in_admin_still_manages_the_mail_server(app, client, outbox, smtp_setting):
    # Signed in is not enough — a store user is refused exactly as before.
    plain = _as(app.test_client(), _user(perms={"departments": {"edit": True}}))
    assert plain.put("/api/v1/admin/smtp-config", json={"from_display": "Plain"}).status_code == 403
    assert plain.post("/api/v1/admin/smtp-test", json={"to": "probe@example.com"}).status_code == 403
    assert outbox == []

    admin = _as(client, _user(role="ADMIN", stores=()))
    resp = admin.put("/api/v1/admin/smtp-config", json={"from_display": "Gate Test"})
    assert resp.status_code == 200 and resp.get_json()["data"]["from_display"] == "Gate Test"
    resp = admin.post("/api/v1/admin/smtp-test", json={"to": "probe@example.com"})
    assert resp.status_code == 200 and resp.get_json()["message"] == "Test mail sent"
    assert [mail["to"] for mail in outbox] == [["probe@example.com"]]


def test_report_recipients_are_edited_by_a_signed_in_admin_not_the_machine_key(app, client, machine):
    # Its own report key, so the window-time mail tests never see these rows.
    report_key = "gate_test"
    row = ReportRecipient(report_key=report_key, name="Asha", email="asha@example.com", role="TO")
    db.session.add(row)
    db.session.commit()
    rid = row.id
    listing = f"/api/v1/report-recipients?report_key={report_key}"
    try:
        resp = machine.post("/api/v1/report-recipients",
                            json={"report_key": report_key, "name": "Intruder", "email": "intruder@example.com"})
        assert resp.status_code == 403 and resp.get_json()["message"] == _MACHINE_REFUSED
        resp = machine.put(f"/api/v1/report-recipients/{rid}", json={"email": "intruder@example.com"})
        assert resp.status_code == 403 and resp.get_json()["message"] == _MACHINE_REFUSED
        # The key still reads the master, and finds it untouched.
        resp = machine.get(listing)
        assert resp.status_code == 200
        assert [r["email"] for r in resp.get_json()["data"]] == ["asha@example.com"]

        plain = _as(app.test_client(), _user())
        assert plain.post("/api/v1/report-recipients",
                          json={"report_key": report_key, "name": "Plain"}).status_code == 403
        assert plain.put(f"/api/v1/report-recipients/{rid}", json={"name": "Plain"}).status_code == 403

        admin = _as(client, _user(role="ADMIN", stores=()))
        resp = admin.post("/api/v1/report-recipients",
                          json={"report_key": report_key, "name": "Ravi", "email": "ravi@example.com", "role": "CC"})
        assert resp.status_code == 201 and resp.get_json()["data"]["email"] == "ravi@example.com"
        resp = admin.put(f"/api/v1/report-recipients/{rid}", json={"email": "asha.new@example.com"})
        assert resp.status_code == 200 and resp.get_json()["data"]["email"] == "asha.new@example.com"
        assert {r["email"] for r in admin.get(listing).get_json()["data"]} == {
            "asha.new@example.com", "ravi@example.com"}
    finally:
        db.session.rollback()
        ReportRecipient.query.filter_by(report_key=report_key).delete()
        db.session.commit()


def test_department_recipients_keep_their_right_but_refuse_the_machine_key(app, client, machine):
    _seq["n"] += 1
    dept = Department(name=f"Gate Dept {_seq['n']}", is_active=True)
    db.session.add(dept)
    db.session.flush()
    rec = DepartmentRecipient(department_id=dept.id, name="Asha", email="asha@example.com", role="TO")
    db.session.add(rec)
    db.session.commit()
    dept_id, rec_id = dept.id, rec.id
    add_url = f"/api/v1/departments/{dept_id}/recipients"
    rec_url = f"/api/v1/departments/recipients/{rec_id}"
    try:
        for resp in (machine.post(add_url, json={"name": "Intruder", "email": "intruder@example.com"}),
                     machine.put(rec_url, json={"email": "intruder@example.com"}),
                     machine.delete(rec_url)):
            assert resp.status_code == 403 and resp.get_json()["message"] == _MACHINE_REFUSED
        rows = DepartmentRecipient.query.filter_by(department_id=dept_id).all()
        assert [(r.id, r.name, r.email) for r in rows] == [(rec_id, "Asha", "asha@example.com")]
        # The key still reads the master.
        assert machine.get("/api/v1/departments").status_code == 200

        # A signed-in user without the edit right is refused as before...
        viewer = _as(app.test_client(), _user(perms={"departments": {"view": True}}))
        assert viewer.post(add_url, json={"name": "Viewer"}).status_code == 403
        assert viewer.delete(rec_url).status_code == 403

        # ...and one holding departments:edit, no administrator, does all three.
        editor = _as(client, _user(perms={"departments": {"edit": True}}))
        resp = editor.post(add_url, json={"name": "Ravi", "email": "ravi@example.com", "role": "CC"})
        assert resp.status_code == 201 and resp.get_json()["data"]["role"] == "CC"
        resp = editor.put(rec_url, json={"email": "asha.new@example.com"})
        assert resp.status_code == 200 and resp.get_json()["data"]["email"] == "asha.new@example.com"
        assert editor.delete(rec_url).status_code == 200
        left = DepartmentRecipient.query.filter_by(department_id=dept_id).all()
        assert [(r.name, r.email) for r in left] == [("Ravi", "ravi@example.com")]
    finally:
        db.session.rollback()
        DepartmentRecipient.query.filter_by(department_id=dept_id).delete()
        Department.query.filter_by(id=dept_id).delete()
        db.session.commit()


def test_the_department_master_is_edited_by_a_signed_in_person_not_the_machine_key(app, client, machine):
    """The tick decides who gets the reorder and the excess mails, and the
    department's name decides which parts it is sent — both are a person's call."""
    _seq["n"] += 1
    dept = Department(name=f"Gate Master {_seq['n']}", is_active=True, notify_reorder=False)
    db.session.add(dept)
    db.session.commit()
    dept_id, name, made = dept.id, dept.name, f"Gate Made {_seq['n']}"
    url = f"/api/v1/departments/{dept_id}"
    try:
        for body in ({"notify_reorder": True}, {"name": f"{name} renamed"}, {"is_active": False}):
            resp = machine.put(url, json=body)
            assert resp.status_code == 403 and resp.get_json()["message"] == _MACHINE_REFUSED, body
        resp = machine.post("/api/v1/departments", json={"name": made, "notify_reorder": True})
        assert resp.status_code == 403 and resp.get_json()["message"] == _MACHINE_REFUSED
        db.session.expire_all()
        row = db.session.get(Department, dept_id)
        assert (row.name, row.notify_reorder, row.is_active) == (name, False, True)
        assert Department.query.filter_by(name=made).first() is None
        # The key still reads the master.
        assert machine.get("/api/v1/departments").status_code == 200

        # A signed-in user without the edit right is refused as before...
        viewer = _as(app.test_client(), _user(perms={"departments": {"view": True}}))
        assert viewer.put(url, json={"notify_reorder": True}).status_code == 403
        assert viewer.post("/api/v1/departments", json={"name": made}).status_code == 403

        # ...and one holding departments:edit, no administrator, ticks and creates.
        editor = _as(client, _user(perms={"departments": {"edit": True}}))
        resp = editor.put(url, json={"notify_reorder": True})
        assert resp.status_code == 200 and resp.get_json()["data"]["notify_reorder"] is True
        resp = editor.post("/api/v1/departments", json={"name": made})
        assert resp.status_code == 201 and resp.get_json()["data"]["name"] == made
    finally:
        db.session.rollback()
        Department.query.filter(Department.name.in_([name, made])).delete(synchronize_session=False)
        db.session.commit()


def test_reorder_send_now_needs_a_signed_in_person_not_the_machine_key(app, client, machine, outbox, monkeypatch):
    """ "Send now" is always forced: with the key alone every POST would mail
    every ticked department again, past the once-a-day guard."""
    _seq["n"] += 1
    dept = Department(name=f"Gate Send {_seq['n']}", is_active=True, notify_reorder=True)
    db.session.add(dept)
    db.session.flush()
    db.session.add(DepartmentRecipient(department_id=dept.id, name="Asha", email="asha@example.com", role="TO"))
    db.session.commit()
    dept_id = dept.id
    rows = [{"part_no": "P-1", "part_name": "Bearing", "status": "Reorder", "qty_on_hand": 1,
             "min_stock_level": 2, "reorder_level": 3, "max_stock_level": 9, "location": "R1-S1-B1"}]
    monkeypatch.setattr(mailer, "smtp_is_configured", lambda: True)
    monkeypatch.setattr(DepartmentRepository, "list_all", lambda self, active_only=True: [dept])
    monkeypatch.setattr(ReorderMailService, "_reorder_rows", lambda self, section_ids: rows)
    url = "/api/v1/departments/reorder-mail/send"
    try:
        for _ in range(2):
            resp = machine.post(url, json={})
            assert resp.status_code == 403 and resp.get_json()["message"] == _MACHINE_REFUSED
        assert outbox == []
        # What a send would do stays readable with the key.
        assert machine.get("/api/v1/departments/reorder-mail/status").status_code == 200

        viewer = _as(app.test_client(), _user(perms={"departments": {"view": True}}))
        assert viewer.post(url).status_code == 403 and outbox == []
        editor = _as(client, _user(perms={"departments": {"edit": True}}))
        resp = editor.post(url)
        assert resp.status_code == 200 and resp.get_json()["data"]["total_sent"] == 1
        assert [mail["to"] for mail in outbox] == [["asha@example.com"]]
    finally:
        db.session.rollback()
        EmailMessage.query.filter(EmailMessage.dedup_key.like(f"reorder\\_{dept_id}:%", escape="\\")).delete(
            synchronize_session=False)
        MailSendLog.query.filter_by(report_key=f"reorder_{dept_id}").delete()
        DepartmentRecipient.query.filter_by(department_id=dept_id).delete()
        Department.query.filter_by(id=dept_id).delete()
        db.session.commit()


def test_window_time_trigger_still_accepts_the_machine_key(machine, outbox, monkeypatch):
    """A scheduled job may POST this one with the shared key and no session.
    With no mail server set up it answers its usual skip — reached, not refused."""
    monkeypatch.setattr(mailer, "smtp_is_configured", lambda: False)
    resp = machine.post("/api/v1/supplier-window-schedules/email-report", json={})
    assert resp.status_code == 200, (resp.status_code, resp.get_json())
    data = resp.get_json()["data"]
    assert (data["status"], data["reason"]) == ("skipped", "smtp_not_configured")
    assert outbox == []


def test_mail_engine_guard_kept_its_wording_when_it_moved_to_authz(machine):
    resp = machine.put("/api/v1/mail-engine/settings", json={})
    assert resp.status_code == 403
    assert resp.get_json()["message"] == "Sign in as an administrator to change the mail engine"
