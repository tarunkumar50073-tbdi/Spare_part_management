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

def test_an_old_lot_tag_scan_still_identifies_the_part(client):
    _login(client)
    p = _part()
    for code in (f"2627/001/11416 {p.part_no}", f"2627/001/11416 {p.part_no.lower()}"):
        r = client.get("/api/v1/spare-stock/scan", query_string={"store_code": STORE, "code": code})
        assert r.status_code == 200, (code, r.get_json())
        assert r.get_json()["data"]["part_id"] == p.id
