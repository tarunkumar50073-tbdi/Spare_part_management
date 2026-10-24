"""The gate-entry lot tags are gone (store, 17 Oct 2026: "lot tag bhi kah rhe h ki
paper wastage h use hta do" — management says they waste paper). The bin
location sheets and a part's own QR label stay, and so does Put-away Check:
the part is typed / searched, the bin sheet QR is scanned, and the lot qty comes
from the part's LATEST ERP gate entry (editable).

What is proven here:

* /api/v1/gate-labels (list + print) and the old lot-tag qty lookup
  /api/v1/spare-stock/lot-qty answer 404, for an administrator too;
* the label print history stays — a GATE_ENTRY row is still in the table and
  still named on the part's timeline — and a single part's label still prints
  (but cannot claim the GATE_ENTRY source);
* the label template has no lot-tag size any more, even when a saved template
  still holds one; no screen, service, route, role template or catalogue entry
  offers a lot tag, and the deleted files are not on disk;
* Put-away: the latest gate entry (date, then time) and its qty summed for the
  part; nothing when ERP has no gate entry; the record keeps the gate entry no.
  with the latest entry's qty or a typed-over qty, and records NO gate entry
  where the screen sends none — an emptied Lot Qty, or a put-away into the
  rework bin (material back from rework) unless the storeman takes the entry;
  the screen chooses that way; a bad qty is refused; an older screen's body
  (gate entry no., no qty) still gets the qty looked up; the lookup is
  store-scoped;
* an old lot tag that is still on material identifies its part when scanned.

All of it on conftest's throwaway DB.
"""
import json
import pathlib
import re
import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import inspect

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.gate_entry import GateEntry
from app.models.label_print_audit import LabelPrintAudit
from app.models.part import Part
from app.models.put_away_log import PutAwayLog
from app.models.user import User, UserStoreAccess
from app.services.barcode_service import LABEL_DEFAULTS, LABEL_SETTING_KEY, BarcodeService
from app.services.scan_result_service import ScanResultService
from app.services.service_catalog import SERVICES
from app.services.spare_stock_service import SpareStockService

STORE = "MAINTENANCE"
_TAG = uuid.uuid4().hex[:6].upper()
_ROOT = pathlib.Path(__file__).resolve().parents[2]
_SRC = _ROOT / "frontend" / "src"
_APP = _ROOT / "backend" / "app"
TODAY = date.today()
_seq = {"n": 0}


def _n():
    _seq["n"] += 1
    return _seq["n"]


@pytest.fixture()
def client(app):
    return app.test_client()


def _login(client, role="ADMIN", permissions=None, stores=(STORE,)):
    u = User(username=f"nolot_{_TAG}_{_n()}", role=role, is_active=True)
    u.set_password("pw-1234")
    if permissions is not None:
        u.set_permissions(permissions)
    db.session.add(u)
    db.session.flush()
    for code in stores:
        db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
    db.session.commit()
    with client.session_transaction() as sess:
        sess["user_id"] = u.id
    return u


def _part(location="R7-S1-B1(1)", store=STORE):
    n = _n()
    p = Part(part_no=f"NL{_TAG}{n:03d}", part_name=f"No Lot Tag {n}", uom="NOS", part_type="OTHER",
             store_code=store, location=location)
    db.session.add(p)
    db.session.commit()
    return p


def _gate(no, item_code, qty, days_ago=2, time="10:15"):
    """One ERP gate-entry line (the mirror carries CHILD_PART on every row)."""
    db.session.add(GateEntry(store_code="CHILD_PART", gate_entry_no=no,
                             gate_entry_dt=TODAY - timedelta(days=days_ago), gate_entry_time=time,
                             ven_cd="VG-1", ven_name="ABC Engineering", item_code=item_code,
                             item_desc="as ERP describes it", qty=qty))
    db.session.commit()


def _latest(client, part):
    r = client.get(f"/api/v1/spare-stock/parts/{part.id}/latest-lot")
    assert r.status_code == 200, r.get_json()
    return r.get_json()["data"]


def _put_away(client, part, **body):
    return client.post("/api/v1/spare-stock/put-away/record",
                       json={"part_id": part.id, "scanned_location": part.location, **body})


def _log(rec_id):
    return db.session.get(PutAwayLog, rec_id)


# ---- the endpoints -----------------------------------------------------------------------

def test_the_lot_tag_endpoints_are_gone(client, app):
    _login(client)
    p = _part()
    _gate(f"GE{_TAG}-0", p.part_no, 4)
    for method, url, body in (
        ("get", f"/api/v1/gate-labels?store_code={STORE}", None),
        ("get", f"/api/v1/gate-labels?store_code={STORE}&days=90&q={p.part_no}", None),
        ("post", "/api/v1/gate-labels/print", {"store_code": STORE, "gate_entry_no": f"GE{_TAG}-0",
                                               "items": [{"part_id": p.id, "copies": 1}]}),
        ("get", f"/api/v1/spare-stock/lot-qty?store_code={STORE}&gate_entry_no=GE{_TAG}-0&part_no={p.part_no}",
         None),
    ):
        resp = getattr(client, method)(url, json=body) if body is not None else getattr(client, method)(url)
        # No such endpoint: 404 — or, for a POST, 405 when a frontend build is
        # present and only its GET-only catch-all (app/spa.py) matches the path.
        assert resp.status_code in ((404,) if method == "get" else (404, 405)), (method, url, resp.status_code)
    assert not [r.rule for r in app.url_map.iter_rules() if "gate-label" in r.rule or "lot-qty" in r.rule]
    # Nothing was printed for it.
    assert not LabelPrintAudit.query.filter_by(part_id=p.id).count()


def test_the_print_history_stays_and_still_reads():
    p = _part()
    no = f"GE{_TAG}-H"
    db.session.add(LabelPrintAudit(part_id=p.id, barcode_value=p.part_no, copies=3, printed_by="old",
                                   is_reprint=False, source="GATE_ENTRY", reference=no))
    db.session.commit()
    assert inspect(db.engine).has_table(LabelPrintAudit.__tablename__)
    assert LabelPrintAudit.query.filter_by(part_id=p.id, source="GATE_ENTRY").one().reference == no
    rows = [r for r in ScanResultService().timeline(p.id)["rows"] if r["kind"] == "LABEL_PRINT"]
    assert [r["title"] for r in rows] == [f"Label printed – 3 (gate entry {no})"]
    assert rows[0]["detail"].startswith("Gate Entry")


def test_a_single_part_label_still_prints_but_not_as_a_gate_entry(client):
    _login(client)
    p = _part()
    r = client.post("/api/v1/barcode/print", json={"part_id": p.id, "source": "QR_SCAN", "copies": 2})
    assert r.status_code == 201, r.get_json()
    assert LabelPrintAudit.query.filter_by(part_id=p.id).one().source == "QR_SCAN"
    r = client.post("/api/v1/barcode/print", json={"part_id": p.id, "source": "GATE_ENTRY"})
    assert r.status_code == 422
    r = client.post("/api/v1/barcode/print-bulk", json={"part_ids": [p.id], "source": "GATE_ENTRY"})
    assert r.status_code == 422


def test_the_label_template_has_no_lot_tag_size():
    assert not [k for k in LABEL_DEFAULTS if k.startswith("lot_")]
    old = AppSetting.get_value(LABEL_SETTING_KEY)
    try:
        # A template saved while the lot tag existed still holds its size.
        AppSetting.set_value(LABEL_SETTING_KEY, {"width_mm": 100, "lot_width_mm": 150, "lot_height_mm": 100})
        cfg = BarcodeService().label_config()
        assert "lot_width_mm" not in cfg and "lot_height_mm" not in cfg
        assert (cfg["width_mm"], cfg["bin_width_mm"], cfg["bin_height_mm"]) == (100, 130, 90)   # bin sheet stays
    finally:
        AppSetting.set_value(LABEL_SETTING_KEY, old if old is not None else {})


# ---- nothing offers a lot tag --------------------------------------------------------------

def _read(rel):
    return (_SRC / rel).read_text(encoding="utf-8")


def test_no_screen_service_route_or_template_offers_a_lot_tag():
    for rel in ("components/label/GateEntryLabels.jsx",):
        assert not (_SRC / rel).exists(), rel
    for rel in ("routes/gate_label_routes.py", "services/gate_label_service.py", "schemas/gate_label_schema.py"):
        assert not (_APP / rel).exists(), rel

    scan_status = _read("lib/scanStatus.js")
    modes = scan_status[scan_status.index("export const SCAN_MODE"):]
    modes = modes[:modes.index("};")]
    assert "LABEL" not in modes and "Lot Tag" not in modes and '"label"' not in modes
    assert "GATE_PRINT_STATE" not in scan_status and "normGateNo" not in scan_status

    scan_part = _read("pages/ScanPart.jsx")
    assert "GateEntryLabels" not in scan_part and "labelMode" not in scan_part

    render = _read("utils/barcodeRender.js")
    assert "buildLotTagsHtml" not in render and "lotTagMarkup" not in render
    assert not re.search(r'class="lt-', render) and "lot_width_mm" not in render
    assert 'kind === "lot"' not in render and 'kind === "lot"' not in _read("components/BarcodeLabel.jsx")

    assert not re.search(r'api\.\w+\(\s*"/gate-labels', _read("services/barcodeService.js"))
    assert not re.search(r'api\.\w+\(\s*"/spare-stock/lot-qty', _read("services/spareStockService.js"))
    for rel in ("pages/GateEntry.jsx", "App.jsx"):
        assert "mode=label" not in _read(rel), rel
    leftover = [p.name for p in _SRC.rglob("*.js*") if re.search(r"GateEntryLabels|printGateLabels|gateLabels\(",
                                                                   p.read_text(encoding="utf-8"))]
    assert leftover == []

    templates = json.loads(_read("lib/roleTemplates.json"))["templates"]
    text = json.dumps(templates).lower()
    assert "lot tag" not in text and "gate-labels" not in text
    assert not [s for s in SERVICES if "lot tag" in json.dumps(s).lower()]


# ---- Put-away: the latest gate entry's lot qty ---------------------------------------------

def test_latest_lot_is_the_newest_gate_entry_summed_for_the_part(client):
    _login(client)
    p = _part()
    other = _part()
    _gate(f"GE{_TAG}-OLD", p.part_no, 9, days_ago=10)
    _gate(f"GE{_TAG}-EARLY", p.part_no, 5, days_ago=1, time="08:00")
    _gate(f"GE{_TAG}-LATE", p.part_no, 3, days_ago=1, time="16:30")
    _gate(f"GE{_TAG}-LATE", p.part_no.lower(), 2, days_ago=1, time="16:30")   # same entry, case-blind
    _gate(f"GE{_TAG}-LATE", other.part_no, 50, days_ago=1, time="16:30")     # another part on it
    lot = _latest(client, p)
    assert lot == {"gate_entry_no": f"GE{_TAG}-LATE", "gate_entry_dt": (TODAY - timedelta(days=1)).isoformat(),
                   "gate_entry_time": "16:30", "qty": 5.0, "uom": "NOS"}
    assert SpareStockService().latest_lot(p) == lot


def test_latest_lot_is_empty_without_a_gate_entry(client):
    _login(client)
    p = _part()
    assert _latest(client, p) == {"gate_entry_no": None, "gate_entry_dt": None, "gate_entry_time": None,
                                  "qty": None, "uom": "NOS"}


def test_latest_lot_is_store_scoped(client):
    p = _part()
    _login(client, role="STORE_USER", permissions={"store_stock": {"view": True, "edit": True}},
           stores=("CHILD_PART",))
    assert client.get(f"/api/v1/spare-stock/parts/{p.id}/latest-lot").status_code == 403
    _login(client)
    assert client.get("/api/v1/spare-stock/parts/999999999/latest-lot").status_code == 404


def test_put_away_records_the_latest_gate_entrys_lot_qty(client):
    _login(client)
    p = _part()
    _gate(f"GE{_TAG}-A", p.part_no, 7, days_ago=3)
    _gate(f"GE{_TAG}-B", p.part_no, 12, days_ago=1)
    lot = _latest(client, p)
    # What the screen sends when the storeman leaves the qty as filled.
    r = _put_away(client, p, gate_entry_no=lot["gate_entry_no"], qty=lot["qty"])
    assert r.status_code == 201, r.get_json()
    rec = r.get_json()["data"]
    assert (rec["gate_entry_no"], rec["qty"], rec["uom"]) == (f"GE{_TAG}-B", 12.0, "NOS")
    row = _log(rec["id"])
    assert (row.gate_entry_no, float(row.qty), row.scanned_location) == (f"GE{_TAG}-B", 12.0, p.location)


def test_put_away_records_a_typed_over_qty(client):
    _login(client)
    p = _part()
    _gate(f"GE{_TAG}-C", p.part_no, 12, days_ago=1)
    r = _put_away(client, p, gate_entry_no=f"GE{_TAG}-C", qty=10.5)
    assert r.status_code == 201, r.get_json()
    rec = r.get_json()["data"]
    assert (rec["gate_entry_no"], rec["qty"]) == (f"GE{_TAG}-C", 10.5)
    assert (_log(rec["id"]).gate_entry_no, float(_log(rec["id"]).qty)) == (f"GE{_TAG}-C", 10.5)


def test_put_away_without_a_gate_entry_takes_a_typed_qty_or_none(client):
    _login(client)
    p = _part()
    typed = _put_away(client, p, gate_entry_no=None, qty=4)
    assert typed.status_code == 201, typed.get_json()
    assert (typed.get_json()["data"]["gate_entry_no"], typed.get_json()["data"]["qty"]) == (None, 4.0)
    empty = _put_away(client, p, gate_entry_no=None, qty=None)
    assert empty.status_code == 201, empty.get_json()
    row = _log(empty.get_json()["data"]["id"])
    assert (row.gate_entry_no, row.qty) == (None, None)


def test_an_explicit_empty_qty_is_not_looked_up(client):
    """A body that names the gate entry with qty null is recorded as sent — the
    qty is not looked up. (The screen sends that only for a gate entry ERP gave
    no qty; when the storeman empties Lot Qty it sends no gate entry — below.)"""
    _login(client)
    p = _part()
    _gate(f"GE{_TAG}-D", p.part_no, 6, days_ago=1)
    r = _put_away(client, p, gate_entry_no=f"GE{_TAG}-D", qty=None)
    assert r.status_code == 201, r.get_json()
    row = _log(r.get_json()["data"]["id"])
    assert (row.gate_entry_no, row.qty) == (f"GE{_TAG}-D", None)


def test_an_emptied_lot_qty_records_no_gate_entry(client):
    """The storeman emptied Lot Qty: the screen sends neither — and the server
    does not fill in the part's latest gate entry for it."""
    _login(client)
    p = _part()
    _gate(f"GE{_TAG}-F", p.part_no, 6, days_ago=1)
    r = _put_away(client, p, gate_entry_no=None, qty=None)
    assert r.status_code == 201, r.get_json()
    assert (r.get_json()["data"]["gate_entry_no"], r.get_json()["data"]["qty"]) == (None, None)
    row = _log(r.get_json()["data"]["id"])
    assert (row.gate_entry_no, row.qty) == (None, None)


def test_a_rework_bin_put_away_records_no_gate_entry_unless_taken(client):
    """The rework bin holds material back from rework (store rule, 14 Oct 2026);
    the part's latest gate entry may be new material, so the screen sends none
    there — the row records none, against the rework bin — unless the storeman
    says the material came on it ("Use this gate entry")."""
    _login(client)
    p = _part(location="R7-S3-B3(1)")
    p.rework_location = "R7-S4-B4(1)"
    db.session.commit()
    _gate(f"GE{_TAG}-R", p.part_no, 12, days_ago=1)
    assert _latest(client, p)["gate_entry_no"] == f"GE{_TAG}-R"   # what the screen is shown
    url = "/api/v1/spare-stock/put-away/record"
    r = client.post(url, json={"part_id": p.id, "scanned_location": p.rework_location,
                               "gate_entry_no": None, "qty": 3})
    assert r.status_code == 201, r.get_json()
    rec = r.get_json()["data"]
    assert (rec["location_kind"], rec["location"], rec["gate_entry_no"], rec["qty"]) == (
        "rework", "R7-S4-B4(1)", None, 3.0)
    row = _log(rec["id"])
    assert (row.assigned_location, row.gate_entry_no, float(row.qty)) == ("R7-S4-B4(1)", None, 3.0)
    # Taken: recorded with its qty, still against the rework bin.
    r = client.post(url, json={"part_id": p.id, "scanned_location": p.rework_location,
                               "gate_entry_no": f"GE{_TAG}-R", "qty": 12})
    assert r.status_code == 201, r.get_json()
    rec = r.get_json()["data"]
    assert (rec["location_kind"], rec["gate_entry_no"], rec["qty"]) == ("rework", f"GE{_TAG}-R", 12.0)


def test_the_screen_sends_the_gate_entry_only_where_it_holds():
    """Put-away Check chooses the gate entry it sends (the server records what
    it is sent): not the latest one regardless, but gateEntryFor — none on the
    rework bin unless taken, none once Lot Qty is emptied — and Lot Qty is held
    to the 2 decimals the server keeps."""
    src = _read("pages/spare/PutAwayCheck.jsx")
    assert "gate_entry_no: gateEntryFor(qty)" in src
    assert "gate_entry_no: lot?.gate_entry_no" not in src
    assert 'result.bin?.kind === "rework"' in src and "lotOnRework" in src
    assert r"\.\d{0,2}" in src


@pytest.mark.parametrize("qty", [0, -2, "abc", 2_000_000_000])
def test_a_bad_lot_qty_is_refused_and_nothing_is_written(client, qty):
    _login(client)
    p = _part()
    r = _put_away(client, p, qty=qty)
    assert r.status_code == 422, (qty, r.get_json())
    assert not PutAwayLog.query.filter_by(part_id=p.id).count()


def test_an_older_screens_body_still_gets_the_gate_entrys_qty(client):
    """A screen open since before 17 Oct 2026 sends the scanned tag's gate entry
    no. and no qty — the qty is looked up for it, as before."""
    _login(client)
    p = _part()
    _gate(f"GE{_TAG}-E", p.part_no, 8, days_ago=4)
    r = _put_away(client, p, gate_entry_no=f"  GE{_TAG}-E ")
    assert r.status_code == 201, r.get_json()
    assert (r.get_json()["data"]["gate_entry_no"], r.get_json()["data"]["qty"]) == (f"GE{_TAG}-E", 8.0)
    # And with neither, nothing is invented.
    r = _put_away(client, p)
    assert (r.get_json()["data"]["gate_entry_no"], r.get_json()["data"]["qty"]) == (None, None)


def test_a_wrong_bin_is_still_refused_with_a_qty(client):
    _login(client)
    p = _part(location="R7-S2-B2(1)")
    r = client.post("/api/v1/spare-stock/put-away/record",
                    json={"part_id": p.id, "scanned_location": "R9-S9-B9(1)", "qty": 3})
    assert r.status_code == 400
    assert not PutAwayLog.query.filter_by(part_id=p.id).count()


# ---- an old lot tag still on material -------------------------------------------------------

def test_an_old_lot_tag_scan_still_identifies_the_part(client):
    _login(client)
    p = _part()
    for code in (f"2627/001/11416 {p.part_no}", f"2627/001/11416 {p.part_no.lower()}"):
        r = client.get("/api/v1/spare-stock/scan", query_string={"store_code": STORE, "code": code})
        assert r.status_code == 200, (code, r.get_json())
        assert r.get_json()["data"]["part_id"] == p.id
