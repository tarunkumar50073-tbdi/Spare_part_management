"""The Part Search kiosk link (17 Nov 2026: "kiosk bina id password k chalega"):
no login, behind a secret key the admin turns on, copies or replaces."""
from app.extensions import db
from app.models.part import Part
from app.models.user import User

STORE = "MAINTENANCE"


def _admin(app):
    u = User.query.filter_by(username="kioskadmin").first()
    if u is None:
        u = User(username="kioskadmin", role="ADMIN", is_active=True)
        u.set_password("pw-kiosk-admin-1")
        db.session.add(u)
        db.session.commit()
    c = app.test_client()
    with c.session_transaction() as s:
        s["user_id"] = u.id
    return c


def test_link_needs_admin_then_opens_without_login(app):
    db.session.add(Part(part_no="KIOSK-LNK-1", part_name="HEX BOLT FOR KIOSK", uom="NOS", part_type="OTHER",
                        store_code=STORE, location="R1"))
    db.session.commit()
    anon = app.test_client()
    assert anon.get("/api/v1/part-kiosk/link").status_code == 401
    admin = _admin(app)
    on = admin.post("/api/v1/part-kiosk/link", json={"enabled": True}).get_json()["data"]
    assert on["enabled"] and len(on["key"]) >= 24
    r = anon.get(f"/api/v1/kiosk-link/{on['key']}/parts", query_string={"q": "KIOSK-LNK"})
    assert r.status_code == 200 and r.get_json()["data"]["rows"][0]["part_no"] == "KIOSK-LNK-1"
    assert anon.get("/api/v1/kiosk-link/wrong-key/parts", query_string={"q": "KIOSK"}).status_code == 404
    # A new link: the old address stops at once.
    new = admin.post("/api/v1/part-kiosk/link", json={"new": True}).get_json()["data"]
    assert new["key"] != on["key"]
    assert anon.get(f"/api/v1/kiosk-link/{on['key']}/parts", query_string={"q": "KIOSK"}).status_code == 404
    assert anon.get(f"/api/v1/kiosk-link/{new['key']}/parts", query_string={"q": "KIOSK"}).status_code == 200
    # Off: nothing opens.
    admin.post("/api/v1/part-kiosk/link", json={"enabled": False})
    assert anon.get(f"/api/v1/kiosk-link/{new['key']}/parts", query_string={"q": "KIOSK"}).status_code == 404
    # The link reads nothing else: the normal kiosk route still wants a login.
    assert anon.get("/api/v1/part-kiosk/parts", query_string={"store_code": STORE, "q": "KIOSK"}).status_code == 401
