"""Every part's QR Code (13 Nov 2026): a new part gets its Part No. as its QR
Code at once ("koi naya part add ho to uska qr ban jaaye"), and the Part
Master's QR list comes as a PDF to view or download ("qr list dekh sake download
ka sake pdf file")."""
import io

from app.extensions import db
from app.models.part import Part
from app.models.user import User, UserStoreAccess

STORE = "MAINTENANCE"
_n = {"n": 0}


def _part(**kw):
    _n["n"] += 1
    p = Part(part_no=kw.pop("part_no", f"QRT-{_n['n']}"), part_name=kw.pop("part_name", "PROXIMITY SENSOR M12"),
             uom="NOS", part_type="OTHER", store_code=STORE, **kw)
    db.session.add(p)
    db.session.commit()
    return p


def _login(client, perms):
    _n["n"] += 1
    u = User(username=f"qrt{_n['n']}", role="STORE_USER", is_active=True)
    u.set_password("pw")
    u.set_permissions(perms)
    db.session.add(u)
    db.session.flush()
    db.session.add(UserStoreAccess(user_id=u.id, store_code=STORE))
    db.session.commit()
    with client.session_transaction() as s:
        s["user_id"] = u.id


def test_a_new_part_gets_its_part_no_as_its_qr_code():
    p = _part(part_no=" QRT-NEW-1 ")
    assert p.barcode == "QRT-NEW-1"
    q = _part(barcode="SUPPLIER-XYZ")
    assert q.barcode == "SUPPLIER-XYZ"                        # one given is kept


def test_the_qr_list_pdf_shows_the_part_masters_parts(app):
    tag = f"QRL{_n['n']}"
    for i in range(23):                                       # more than one page (21 a page)
        _part(part_no=f"{tag}-{i:02d}", specification=f"MODEL-{i}", location="R4-S1-B1")
    c = app.test_client()
    _login(c, {"part_master": {"view": True}})
    r = c.get("/api/v1/parts/qr-list.pdf", query_string={"store_code": STORE, "keyword": tag})
    assert r.status_code == 200 and r.mimetype == "application/pdf" and r.data[:4] == b"%PDF"
    assert "attachment" not in r.headers.get("Content-Disposition", "")            # shown, not saved
    assert r.data.count(b"/Type /Page\n") + r.data.count(b"/Type /Page ") >= 2 or b"/Count 2" in r.data
    r = c.get("/api/v1/parts/qr-list.pdf", query_string={"store_code": STORE, "keyword": tag, "download": "1"})
    assert "attachment" in r.headers["Content-Disposition"] and "Part QR List" in r.headers["Content-Disposition"]
    _login(c, {"scan_part": {"view": True}})
    assert c.get("/api/v1/parts/qr-list.pdf", query_string={"store_code": STORE}).status_code == 403
