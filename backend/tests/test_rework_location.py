"""A part's two bins — fresh and rework — in the bin-scan checks.

Store rule (14 Oct 2026): a part such as CNTR3200 has a FRESH location (new
material, Part.location) and a REWORK location (material back from rework,
Part.rework_location). Stock stays one number; the Part Requisition issue and
the Put-away record accept a scan of EITHER bin — a bare bin QR at bin level, a
slot "(n)" only that exact slot, as the screens do — store the bin actually
scanned, and say which bin it was. A part without a rework location behaves
exactly as before.
"""
import pytest

from app.extensions import db
from app.models.part import Part
from app.models.part_request import PartRequest
from app.models.put_away_log import PutAwayLog
from app.models.spare_stock import SpareStock
from app.models.user import User, UserStoreAccess
from app.services.part_request_service import PartRequestService
from app.services.spare_stock_service import SpareStockService
from app.utils.bin_location import bins_text, match_bin, part_bins
from app.utils.exceptions import BadRequestError

FRESH, REWORK = "R3-S6-B31(1)", "R2-S6-B35(1)"
_seq = {"n": 0}


def _next():
    _seq["n"] += 1
    return _seq["n"]


def _part(location=FRESH, rework_location=REWORK, qty=10):
    n = _next()
    p = Part(part_no=f"RWL-{n}", part_name=f"Rework Loc Part {n}", uom="NO", part_type="OTHER",
             store_code="MAINTENANCE", location=location, rework_location=rework_location)
    db.session.add(p)
    db.session.commit()
    if qty is not None:
        SpareStockService().set_quantity(p.id, float(qty), txn_type="OPENING")
    return p


def _on_hand(part_id):
    row = SpareStock.query.filter_by(part_id=part_id).first()
    return float(row.qty_on_hand) if row else 0.0


def _request(part, qty=2):
    return PartRequestService().create(
        "MAINTENANCE", {"part_id": part.id, "requested_qty": qty, "department": "Store"})


# ---- the shared match ------------------------------------------------------------------

def test_match_bin_either_location_at_bin_level():
    bins = part_bins(FRESH, REWORK)
    assert bins == [("fresh", FRESH), ("rework", REWORK)]
    assert match_bin("R3-S6-B31(1)", bins) == ("fresh", FRESH)
    assert match_bin("r3-s6-b31", bins) == ("fresh", FRESH)            # bare bin, any case
    assert match_bin("R2-S6-B35(1)", bins) == ("rework", REWORK)
    assert match_bin(" R2-S6-B35 ", bins) == ("rework", REWORK)
    assert match_bin("R1-S1-B1", bins) is None
    assert match_bin("", bins) is None
    # A slot scanned must be that exact slot — the neighbour slot of either bin
    # is WRONG (as on the screens), and a slot never matches a bare location.
    assert match_bin("r2-s6-b35 (1)", bins) == ("rework", REWORK)
    assert match_bin("R2-S6-B35(2)", bins) is None
    assert match_bin("R3-S6-B31(9)", bins) is None
    assert match_bin("R3-S6-B31(1)", part_bins("R3-S6-B31")) is None
    assert match_bin("R3-S6-B31", part_bins("R3-S6-B31")) == ("fresh", "R3-S6-B31")
    assert bins_text(bins) == "R3-S6-B31(1) (new) or R2-S6-B35(1) (rework)"


def test_part_bins_single_location_and_same_bin_slots():
    assert part_bins(FRESH, None) == [("fresh", FRESH)]
    assert part_bins(FRESH, " r3-s6-b31(1) ") == [("fresh", FRESH)]    # same as fresh: one bin
    assert part_bins(None, None) == []
    assert bins_text(part_bins(FRESH)) == FRESH
    # Both bins in one rack bin, different slots: the exact slot decides.
    bins = part_bins("R1-S1-B1(1)", "R1-S1-B1(2)")
    assert match_bin("R1-S1-B1(2)", bins) == ("rework", "R1-S1-B1(2)")
    assert match_bin("R1-S1-B1(1)", bins) == ("fresh", "R1-S1-B1(1)")


# ---- Part Requisition issue ---------------------------------------------------------------

@pytest.mark.parametrize("scan", ["R3-S6-B31(1)", "R3-S6-B31", "R2-S6-B35(1)", "R2-S6-B35"])
def test_request_issue_accepts_fresh_or_rework_bin(scan):
    svc = PartRequestService()
    p = _part()
    r = _request(p)
    assert r["assigned_location"] == FRESH and r["rework_location"] == REWORK
    out = svc.issue(r["id"], scan, 2, user="sup1")
    assert out["status"] == "ISSUED" and out["issued_qty"] == 2.0
    assert out["scanned_location"] == scan                 # the bin actually scanned
    assert _on_hand(p.id) == 8.0


def test_request_issue_wrong_bin_names_both_bins():
    svc = PartRequestService()
    p = _part()
    r = _request(p)
    with pytest.raises(BadRequestError) as e:
        svc.issue(r["id"], "R1-S1-B1", 2, user="sup1")
    assert e.value.message == f"Wrong location — {p.part_no} is at R3-S6-B31(1) (new) or R2-S6-B35(1) (rework)"
    assert _on_hand(p.id) == 10.0
    req = db.session.get(PartRequest, r["id"])
    assert req.status == "PENDING" and req.scanned_location is None


def test_request_issue_rejects_the_neighbour_slot():
    svc = PartRequestService()
    p = _part()
    r = _request(p)
    with pytest.raises(BadRequestError) as e:
        svc.issue(r["id"], "R2-S6-B35(2)", 2, user="sup1")
    assert e.value.message.startswith(f"Wrong location — {p.part_no} is at ")
    assert _on_hand(p.id) == 10.0


def test_request_without_rework_location_unchanged():
    svc = PartRequestService()
    p = _part(rework_location=None)
    r = _request(p)
    assert r["rework_location"] is None
    with pytest.raises(BadRequestError) as e:
        svc.issue(r["id"], "R2-S6-B35(1)", 2, user="sup1")
    assert e.value.message == f"Wrong location — {p.part_no} is at {FRESH}"
    out = svc.issue(r["id"], "R3-S6-B31", 2, user="sup1")
    assert out["status"] == "ISSUED" and out["scanned_location"] == "R3-S6-B31"


def test_request_list_carries_rework_location():
    p = _part()
    plain = _part(rework_location=None)
    a, b = _request(p), _request(plain)
    rows = {r["id"]: r for r in PartRequestService().list("MAINTENANCE", status=["PENDING"])}
    assert rows[a["id"]]["rework_location"] == REWORK
    assert rows[b["id"]]["rework_location"] is None


# ---- Put-away record -------------------------------------------------------------------------

@pytest.mark.parametrize("scan, kind, assigned", [
    ("R3-S6-B31(1)", "fresh", FRESH), ("R3-S6-B31", "fresh", FRESH),
    ("R2-S6-B35(1)", "rework", REWORK), ("R2-S6-B35", "rework", REWORK),
])
def test_put_away_accepts_either_bin_and_records_it(scan, kind, assigned):
    p = _part()
    rec = SpareStockService().record_put_away(p, scan, user="putter")
    assert (rec["location"], rec["location_kind"], rec["scanned_location"]) == (assigned, kind, scan)
    log = db.session.get(PutAwayLog, rec["id"])
    assert (log.assigned_location, log.scanned_location, log.put_by) == (assigned, scan, "putter")
    assert _on_hand(p.id) == 10.0                         # a put-away never moves stock


def test_put_away_wrong_bin_names_both_bins():
    p = _part()
    with pytest.raises(BadRequestError) as e:
        SpareStockService().record_put_away(p, "R1-S1-B1", user="putter")
    assert e.value.message == \
        "Scanned location is neither of the part's bins — R3-S6-B31(1) (new) or R2-S6-B35(1) (rework)"
    assert PutAwayLog.query.filter_by(part_id=p.id).count() == 0


def test_put_away_rejects_the_neighbour_slot():
    p = _part()
    with pytest.raises(BadRequestError):
        SpareStockService().record_put_away(p, "R2-S6-B35(2)", user="putter")
    assert PutAwayLog.query.filter_by(part_id=p.id).count() == 0


def test_put_away_without_rework_location_unchanged():
    p = _part(rework_location=None)
    with pytest.raises(BadRequestError) as e:
        SpareStockService().record_put_away(p, "R2-S6-B35(1)", user="putter")
    assert e.value.message == "Scanned location does not match the part's assigned location"
    rec = SpareStockService().record_put_away(p, "R3-S6-B31", user="putter")
    assert (rec["location"], rec["location_kind"], rec["scanned_location"]) == (FRESH, None, "R3-S6-B31")


# ---- routes ------------------------------------------------------------------------------------

@pytest.fixture()
def client(app):
    return app.test_client()


def _login(client, perms):
    u = User(username=f"rwluser{_next()}", role="STORE_USER", is_active=True)
    u.set_password("pw")
    u.set_permissions(perms)
    db.session.add(u)
    db.session.flush()
    db.session.add(UserStoreAccess(user_id=u.id, store_code="MAINTENANCE"))
    db.session.commit()
    with client.session_transaction() as s:
        s["user_id"] = u.id
    return u


def test_routes_accept_the_rework_bin(client):
    user = _login(client, {"scan_part": {"view": True, "edit": True}, "store_stock": {"edit": True}})
    p = _part()
    r = _request(p)
    got = client.get(f"/api/v1/part-requests/{r['id']}")
    assert got.status_code == 200 and got.get_json()["data"]["rework_location"] == REWORK
    bad = client.post(f"/api/v1/part-requests/{r['id']}/issue",
                      json={"scanned_location": "R1-S1-B1", "issued_qty": 2})
    assert bad.status_code == 400 and "(rework)" in bad.get_json()["message"]
    ok = client.post(f"/api/v1/part-requests/{r['id']}/issue",
                     json={"scanned_location": "R2-S6-B35(1)", "issued_qty": 2})
    assert ok.status_code == 200, ok.get_json()
    assert ok.get_json()["data"]["scanned_location"] == "R2-S6-B35(1)"

    put = client.post("/api/v1/spare-stock/put-away/record",
                      json={"part_id": p.id, "scanned_location": "R2-S6-B35"})
    assert put.status_code == 201, put.get_json()
    body = put.get_json()["data"]
    assert (body["location"], body["location_kind"], body["put_by"]) == (REWORK, "rework", user.username)
    slot = client.post("/api/v1/spare-stock/put-away/record",
                       json={"part_id": p.id, "scanned_location": "R2-S6-B35(2)"})
    assert slot.status_code == 400 and "(rework)" in slot.get_json()["message"]


def test_part_requests_report_reads_a_rework_bin_scan_as_right():
    """The Part Requests report checks the scanned bin against both of the
    part's bins, as the issue screen does."""
    from types import SimpleNamespace
    from app.services.spare_report_service import _location_check
    part = SimpleNamespace(location="R3-S6-B31(1)", rework_location="R2-S6-B35(1)")

    def req(scanned):
        return SimpleNamespace(scanned_location=scanned, assigned_location="R3-S6-B31(1)", part=part)

    assert _location_check(req("R3-S6-B31(1)")) == "Right"
    assert _location_check(req("R2-S6-B35(1)")) == "Right - rework bin"
    assert _location_check(req("R1-S1-B1")) == (
        "Wrong - scanned R1-S1-B1, assigned R3-S6-B31(1) (new) or R2-S6-B35(1) (rework)")
