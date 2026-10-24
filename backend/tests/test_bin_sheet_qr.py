"""The bin sheet QR's description — only the text before " | " is ever matched.

Store request (17 Oct 2026): the bin location sheet QR, which read "PART_NO
LOCATION" (e.g. "CNTR2238 R6-S6-B36(1)"), also carries the part's description at
the END after " | " — "CNTR2238 R6-S6-B36(1) | BENDING INSERT" — so a scan also
says what the part is. Every parser reads only the text before " | ": the part
no. and the location resolve exactly as before, a sheet already on the racks (no
" | ") scans unchanged, and no word of a description can find a part. The
screens use the same rule (frontend utils/binLocation.stripScanDescription).
"""
import pytest

from app.extensions import db
from app.models.part import Part
from app.models.scan_audit import ScanAudit
from app.models.user import User, UserStoreAccess
from app.repositories.part_repository import PartRepository
from app.services.spare_stock_service import SpareStockService
from app.utils.bin_location import match_bin, part_bins, strip_scan_description

_seq = {"n": 0}


def _next():
    _seq["n"] += 1
    return _seq["n"]


def _part(part_no=None, name="BENDING INSERT", location="R6-S6-B36(1)"):
    p = Part(part_no=part_no or f"QRD{_next():05d}", part_name=name, uom="NO",
             store_code="MAINTENANCE", is_active=True, location=location)
    db.session.add(p)
    db.session.commit()
    return p


def _user(role="STORE_USER"):
    u = User(username=f"qrd{_next()}", full_name="QR Desc", role=role, is_active=True)
    u.set_password("pw")
    db.session.add(u)
    db.session.flush()
    db.session.add(UserStoreAccess(user_id=u.id, store_code="MAINTENANCE"))
    db.session.commit()
    return u


@pytest.fixture()
def client(app):
    return app.test_client()


def _login(client, user):
    with client.session_transaction() as sess:
        sess["user_id"] = user.id


def _resolve(client, code):
    return client.post("/api/v1/barcode/resolve", json={
        "code": code, "store_code": "MAINTENANCE", "scan_source": "USB_SCANNER", "scan_mode": "LOOKUP"})


# ---- the rule ------------------------------------------------------------------------

@pytest.mark.parametrize("scanned, matched", [
    ("CNTR2238 R6-S6-B36(1) | BENDING INSERT", "CNTR2238 R6-S6-B36(1)"),   # new sheet
    ("CNTR2238 R6-S6-B36(1)", "CNTR2238 R6-S6-B36(1)"),                    # sheet on the racks
    ("  cntr2238  ", "cntr2238"),                                          # typed part no.
    ("2627/001/11416 CNTR2238", "2627/001/11416 CNTR2238"),                # lot tag
    ("CNTR2238 R6-S6-B36(1) |BENDING", "CNTR2238 R6-S6-B36(1)"),
    ("CNTR2238 R6-S6-B36(1)\t| BENDING", "CNTR2238 R6-S6-B36(1)"),
    ("CNTR2238 | PIN | BUSH", "CNTR2238"),                                 # first separator; no location
    ("VQR00001|LOT=L2609|QTY=1|", "VQR00001|LOT=L2609|QTY=1|"),            # supplier QR: bare "|" is data
    ("", ""),
    (None, ""),
])
def test_strip_scan_description(scanned, matched):
    assert strip_scan_description(scanned) == matched


def test_match_bin_ignores_the_description():
    bins = part_bins("R6-S6-B36(1)", "R2-S6-B35(1)")
    assert match_bin("R6-S6-B36(1) | BENDING INSERT", bins) == ("fresh", "R6-S6-B36(1)")
    assert match_bin("R6-S6-B36(1)", bins) == ("fresh", "R6-S6-B36(1)")             # old read
    assert match_bin("R2-S6-B35(1) | BENDING INSERT", bins) == ("rework", "R2-S6-B35(1)")
    # A slot-looking text in the description does not decide: the bare bin before
    # " | " matches at bin level, a wrong bin stays wrong.
    assert match_bin("R6-S6-B36 | INSERT R2-S6-B35(2) M6-20", bins) == ("fresh", "R6-S6-B36(1)")
    assert match_bin("R9-S1-B1(1) | FITS R6-S6-B36(1)", bins) is None
    assert match_bin("R6-S6-B36(2) | BENDING INSERT", bins) is None


def test_match_bin_old_reads_unchanged():
    """The bin-scan rule of 14 Oct 2026, untouched by the description cut."""
    fresh, rework = "R3-S6-B31(1)", "R2-S6-B35(1)"
    bins = part_bins(fresh, rework)
    assert match_bin("R3-S6-B31(1)", bins) == ("fresh", fresh)
    assert match_bin("r3-s6-b31", bins) == ("fresh", fresh)
    assert match_bin(" R2-S6-B35 ", bins) == ("rework", rework)
    assert match_bin("r2-s6-b35 (1)", bins) == ("rework", rework)
    assert match_bin("R2-S6-B35(2)", bins) is None
    assert match_bin("R1-S1-B1", bins) is None
    assert match_bin("", bins) is None
    assert match_bin(None, bins) is None
    assert match_bin("R3-S6-B31(1)", part_bins("R3-S6-B31")) is None
    assert match_bin("R3-S6-B31", part_bins("R3-S6-B31")) == ("fresh", "R3-S6-B31")


# ---- resolving the part (every scan screen: PartRepository.get_by_scan_code) ----------

def test_new_and_old_sheet_reads_resolve_the_same_part():
    p = _part()
    repo = PartRepository()
    for code in (f"{p.part_no} R6-S6-B36(1) | BENDING INSERT",          # new sheet
                 f"{p.part_no} R6-S6-B36(1)",                           # sheet on the racks
                 p.part_no, p.part_no.lower(),                          # typed
                 f"2627/001/11416 {p.part_no}",                         # lot tag
                 f"{p.part_no} | BENDING INSERT",                       # part with no location
                 # description with spaces, digits, a location- and a part-no-looking word
                 f"{p.part_no} R6-S6-B36(1) | PIPE 1/2 INCH R2-S6-B35(1) QRD99999 2024"):
        hit = repo.get_by_scan_code(code)
        assert hit is not None and hit.id == p.id, code


def test_a_description_word_never_resolves_another_part():
    other = _part(name="PIN")
    repo = PartRepository()
    # A sheet whose own part no. is not (or no longer) a part, its description
    # naming another part's no.: nothing resolves — not the part in the text.
    code = f"GONE{_next():05d} R1-S1-B1(1) | SPARE FOR {other.part_no}"
    assert repo.get_by_scan_code(code) is None
    # (The same words with no separator are still tried token by token, as a
    # lot tag is — only the description is off limits.)
    assert repo.get_by_scan_code(code.replace(" | ", " ")).id == other.id


def test_put_away_resolver_reads_the_new_sheet():
    p = _part()
    row = SpareStockService().resolve_scan("MAINTENANCE", f"{p.part_no} R6-S6-B36(1) | BENDING INSERT")
    assert row["part_id"] == p.id


# ---- Scan Part (/barcode/resolve) ----------------------------------------------------

def test_scan_part_resolves_a_new_sheet_and_audits_the_part_of_it_that_was_read(client):
    user = _user()
    _login(client, user)
    p = _part()
    r = _resolve(client, f"{p.part_no} R6-S6-B36(1) | BENDING INSERT")
    assert r.status_code == 200
    data = r.get_json()["data"]
    assert (data["part_id"], data["resolved_by"]) == (p.id, "PART_NO")
    assert data["scanned_code"] == f"{p.part_no} R6-S6-B36(1)"
    row = ScanAudit.query.filter_by(user=user.username).one()
    assert (row.scanned_code, row.result, row.part_id) == (f"{p.part_no} R6-S6-B36(1)", "SUCCESS", p.id)


def test_scan_part_long_sheet_payload_is_not_too_long(client):
    """A long part no. + location + a 40-character description passes 80
    characters; it is the text before " | " that must fit, not the whole read."""
    _login(client, _user())
    p = _part(part_no=f"QRDLONG{_next():05d}", location="ABS PIPE RACK SECTION-12 BAY 4(1)",
              name="HYDRAULIC CYLINDER SEAL KIT 50MM NBR SET")
    code = f"{p.part_no} {p.location} | {p.part_name}"
    assert len(code) > 80
    r = _resolve(client, code)
    assert r.status_code == 200
    assert r.get_json()["data"]["part_id"] == p.id


def test_scan_part_supplier_code_holding_the_separator_is_used_whole(client):
    """A mapped supplier code is used exactly as scanned, even one with " | " in
    it — the cut applies only when the whole read is not a mapped code."""
    admin = _user(role="ADMIN")
    _login(client, admin)
    target = _part()
    code = f"SUPQRD{_next():05d} | LOT 7"     # cut at " | " it would name nothing
    assert client.post("/api/v1/barcode/mapping", json={"part_id": target.id, "code": code}).status_code == 201
    r = _resolve(client, code)
    assert r.status_code == 200
    data = r.get_json()["data"]
    assert (data["part_id"], data["resolved_by"], data["scanned_code"]) == (target.id, "SUPPLIER", code)
