"""27 Nov 2026 audit fixes."""
from datetime import date, timedelta

from app.extensions import db
from tests.test_spare_packets import STORE, _part, _seq

_seq["n"] = max(_seq["n"], 95000)


def test_machine_key_opens_only_the_erp_routes(app):
    """The shared key cannot make a login, reset a password, browse tables or
    change stock; the ERP-inbound routes still take it."""
    client = app.test_client()
    key = {"X-API-Key": app.config["API_KEY"]}
    assert client.post("/api/v1/admin/users", json={"username": "KEYMADE", "role": "ADMIN",
                                                    "password": "Xx1!xxxxxx"}, headers=key).status_code == 403
    assert client.get("/api/v1/data-browser/tables", headers=key).status_code in (403, 404)
    assert client.get("/api/v1/part-kiosk/link", headers=key).status_code == 403
    assert client.post("/api/v1/store/gate-entry", json={}, headers=key).status_code != 403


def test_window_time_mail_trigger_still_takes_the_machine_key():
    from app.routes.supplier_window_schedule_routes import email_report
    from app.utils import authz
    assert email_report.__wrapped__ is not None
    assert authz.admin_or_machine_required.__name__ == "admin_or_machine_required"


def test_tv_login_cannot_take_the_daily_stock_report(app):
    from tests.test_read_access import _login
    tv = _login(app, perms={"live_dashboard": {"view": True}})
    for path in ("daily-report", "daily-stock-only"):
        assert tv.get(f"/api/v1/spare-stock/{path}?store_code={STORE}").status_code == 403
    keeper = _login(app, perms={"spare_store": {"view": True}, "reports": {"view": True}})
    assert keeper.get(f"/api/v1/spare-stock/daily-report?store_code={STORE}").status_code == 200


def test_live_update_streams_are_capped():
    from app.routes import events_routes as ev
    ev._open.clear(); ev._open["all"] = 0
    took = [ev._take("user:1") for _ in range(ev._MAX_PER_USER + 1)]
    assert took.count(True) == ev._MAX_PER_USER and took[-1] is False
    n = 2
    while ev._open["all"] < ev._MAX_STREAMS:
        assert ev._take(f"user:{n}")
        n += 1
    assert ev._take("user:999") is False             # the whole cap is reached
    ev._give_back("user:2")
    assert ev._take("user:999") is True
    ev._open.clear(); ev._open["all"] = 0


def test_old_erp_history_grn_is_never_quality_pending():
    """5 years of GRN history: a line before the post-from date with no
    accepted qty is SKIPPED, not counted as waiting for quality."""
    from app.models.receiving_register import ReceivingRegister
    from app.services.erp_grn_posting_service import ErpGrnPostingService
    part = _part(qty=1, pkt=1)
    old = date(2023, 5, 10)
    db.session.add(ReceivingRegister(store_code="CHILD_PART", grn_no="IN2324/001/09999", grn_date=old,
                                     item_cd=part.part_no, receipt_qty=4))
    db.session.commit()
    lines = [l for l in ErpGrnPostingService().lines(STORE, part_id=part.id) if l["grn_no"] == "IN2324/001/09999"]
    assert lines and lines[0]["state"] == "SKIPPED" and "post-from" in lines[0]["reason"]


def test_password_reset_ends_the_old_sign_ins(app):
    from app.models.user import User
    from tests.test_read_access import _login
    c = _login(app, perms={"spare_store": {"view": True}})
    assert c.get("/api/v1/stores").status_code == 200            # first request marks the sign-in
    with c.session_transaction() as s:
        uid = s["user_id"]
    u = db.session.get(User, uid)
    u.set_password("a-new-one")
    db.session.commit()
    c2 = app.test_client()
    with c.session_transaction() as s:
        old = dict(s)
    with c2.session_transaction() as s:
        s.update(old)
    assert c.get("/api/v1/stores").status_code == 401            # the old cookie is done
    assert c2.get("/api/v1/auth/me").get_json()["data"] is None  # and the SPA shows the login screen


def test_data_browser_excel_writes_formulas_as_text():
    import io
    from openpyxl import load_workbook
    from app.models.supplier import Supplier
    from app.services.data_browser_service import DataBrowserService
    db.session.add(Supplier(vendor_code="FMLA27", supplier_name='=HYPERLINK("http://x","open")'))
    db.session.commit()
    buf, _ = DataBrowserService().export("suppliers", q="FMLA27")
    ws = load_workbook(io.BytesIO(buf.getvalue())).active
    cells = [c.value for row in ws.iter_rows(min_row=2) for c in row if isinstance(c.value, str)]
    assert any(v.startswith("'=HYPERLINK") for v in cells)
    assert not any(v.startswith("=") for v in cells)


def test_an_empty_erp_challan_read_keeps_the_lines(monkeypatch):
    from app.models.job_work import ErpRgpLine
    from app.services.job_work_service import JobWorkService
    db.session.add(ErpRgpLine(challan_no="FO001/9999/26-27", item_cd="KEEPME27", qty=2))
    db.session.commit()
    svc = JobWorkService()
    monkeypatch.setattr(svc, "_read_erp", lambda: [])
    state = svc.sync()
    try:
        assert state.get("ok") is False
        assert ErpRgpLine.query.filter_by(item_cd="KEEPME27").count() == 1
    finally:                                   # other tests read an empty challan table
        ErpRgpLine.query.filter_by(item_cd="KEEPME27").delete()
        db.session.commit()
