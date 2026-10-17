"""QR labels from ERP gate entries — /api/v1/gate-labels (GateLabelService).

The gate mirror holds the whole plant's items, and the test DB is shared by the
whole session (no per-test rollback), so every test tags its own gate entry
nos. and Part Nos. with a unique marker and reads the list back with q=<tag>.
"""
import json
import queue
from datetime import date, timedelta

import pytest

from app.extensions import db
from app.models.gate_entry import GateEntry
from app.models.label_print_audit import LabelPrintAudit
from app.models.part import Part
from app.models.part_barcode import PartBarcode
from app.models.spare_flow import SpareReceipt
from app.models.spare_stock import SpareStockLedger
from app.models.user import User, UserStoreAccess
from app.services.barcode_service import BarcodeService
from app.services.gate_label_service import GateLabelService, default_copies
from app.services.scan_result_service import ScanResultService
from app.utils import event_bus
from app.utils.exceptions import BadRequestError

URL = "/api/v1/gate-labels"
TODAY = date.today()

_seq = {"n": 0}


def _n():
    _seq["n"] += 1
    return _seq["n"]


def _tag():
    return f"GLT{_n():04d}X"


@pytest.fixture()
def client(app):
    return app.test_client()


@pytest.fixture()
def bus():
    q = event_bus.subscribe()
    yield q
    event_bus.unsubscribe(q)


def _events(q):
    out = []
    while True:
        try:
            out.append(json.loads(q.get_nowait()))
        except queue.Empty:
            return out


def _login(client, user_id):
    with client.session_transaction() as sess:
        sess["user_id"] = user_id


def _admin():
    u = User(username=f"gladm{_n()}", full_name="Admin", role="ADMIN", is_active=True)
    u.set_password("pw")
    db.session.add(u)
    db.session.commit()
    return u


def _store_user(perms, stores=("MAINTENANCE",)):
    u = User(username=f"glsu{_n()}", full_name="Store User", role="STORE_USER", is_active=True)
    u.set_password("pw")
    u.set_permissions(perms)
    db.session.add(u)
    db.session.flush()
    for code in stores:
        db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
    db.session.commit()
    return u


def _part(tag, suffix, store="MAINTENANCE", active=True, location="R1-S1-B1"):
    p = Part(part_no=f"{tag}-{suffix}", part_name=f"Proximity Sensor {suffix}", uom="NO",
             part_type="OTHER", store_code=store, is_active=active, location=location)
    db.session.add(p)
    db.session.commit()
    return p


def _gate(no, item_code, qty, days_ago=2, time="10:15", ven_cd="VG-1", ven_name="ABC Engineering",
          bill_no="B-1", po_no="PO-1"):
    """One ERP gate-entry line (the mirror carries CHILD_PART on every row)."""
    db.session.add(GateEntry(store_code="CHILD_PART", gate_entry_no=no,
                             gate_entry_dt=TODAY - timedelta(days=days_ago), gate_entry_time=time,
                             ven_cd=ven_cd, ven_name=ven_name, bill_no=bill_no, po_no=po_no,
                             item_code=item_code, item_desc="as ERP describes it", qty=qty))
    db.session.commit()


def _list(client, q, days=None):
    params = {"store_code": "MAINTENANCE", "q": q}
    if days is not None:
        params["days"] = days
    r = client.get(URL, query_string=params)
    assert r.status_code == 200, r.get_json()
    return r.get_json()["data"]


def _print(client, no, items, **extra):
    return client.post(f"{URL}/print", json={"store_code": "MAINTENANCE", "gate_entry_no": no,
                                             "items": items, **extra})


# ---- listing ----

def test_lines_group_per_gate_entry_and_part(client):
    _login(client, _admin().id)
    tag = _tag()
    a, b = _part(tag, "A"), _part(tag, "B", location=None)
    no = f"{tag}-GE1"
    _gate(no, a.part_no, 2)
    _gate(no, f"  {a.part_no.lower()} ", 3)       # same part, ERP spelling: summed
    _gate(no, b.part_no, 1)
    _gate(no, "CHILD-ONLY-ITEM", 50)               # a child part: not a spare item

    data = _list(client, tag)
    assert [e["gate_entry_no"] for e in data["entries"]] == [no]
    e = data["entries"][0]
    assert e["gate_entry_dt"] == (TODAY - timedelta(days=2)).isoformat()
    assert e["gate_entry_time"] == "10:15"
    assert (e["ven_cd"], e["ven_name"], e["bill_no"], e["po_no"]) == ("VG-1", "ABC Engineering", "B-1", "PO-1")
    assert e["spare_items"] == 2 and e["labels_total"] == 6
    assert e["printed_state"] == "NOT_PRINTED"
    ia, ib = e["items"]
    assert ia == {"part_id": a.id, "part_no": a.part_no, "part_name": a.part_name,
                  "location": "R1-S1-B1", "uom": "NO", "specification": None, "qty": 5.0,
                  "default_copies": 5, "copies_capped": False, "printed_copies": 0, "is_active": True}
    assert ib["part_id"] == b.id and ib["qty"] == 1.0 and ib["location"] is None


def test_only_the_stores_active_parts_count(client):
    _login(client, _admin().id)
    tag = _tag()
    spare = _part(tag, "SP")
    inactive = _part(tag, "IN", active=False)
    child = _part(tag, "CH", store="CHILD_PART")
    _gate(f"{tag}-MIX", spare.part_no, 1)
    _gate(f"{tag}-MIX", inactive.part_no, 1)
    _gate(f"{tag}-MIX", child.part_no, 1)
    _gate(f"{tag}-NONE", child.part_no, 4)           # no spare item at all: not listed
    _gate(f"{tag}-NONE", inactive.part_no, 4)

    entries = _list(client, tag)["entries"]
    assert [e["gate_entry_no"] for e in entries] == [f"{tag}-MIX"]
    assert [i["part_id"] for i in entries[0]["items"]] == [spare.id]


def test_newest_first_by_date_then_time_then_no(client):
    _login(client, _admin().id)
    tag = _tag()
    p = _part(tag, "P")
    _gate(f"{tag}-A", p.part_no, 1, days_ago=3, time="23:00")
    _gate(f"{tag}-B", p.part_no, 1, days_ago=1, time="08:00")
    _gate(f"{tag}-C", p.part_no, 1, days_ago=1, time="16:30")
    _gate(f"{tag}-D", p.part_no, 1, days_ago=1, time="16:30")
    assert [e["gate_entry_no"] for e in _list(client, tag)["entries"]] == [
        f"{tag}-D", f"{tag}-C", f"{tag}-B", f"{tag}-A"]


def test_days_window_counts_back_from_today(client):
    _login(client, _admin().id)
    tag = _tag()
    p = _part(tag, "P")
    _gate(f"{tag}-D7", p.part_no, 1, days_ago=7)
    _gate(f"{tag}-D30", p.part_no, 1, days_ago=30)
    _gate(f"{tag}-D31", p.part_no, 1, days_ago=31)
    _gate(f"{tag}-D80", p.part_no, 1, days_ago=80)

    def nos(days):
        return {e["gate_entry_no"] for e in _list(client, tag, days)["entries"]}

    assert nos(7) == {f"{tag}-D7"}
    assert nos(None) == {f"{tag}-D7", f"{tag}-D30"}          # default 30 days
    assert nos(90) == {f"{tag}-D7", f"{tag}-D30", f"{tag}-D31", f"{tag}-D80"}
    window = _list(client, tag, 7)["window"]
    assert window == {"days": 7, "from": (TODAY - timedelta(days=7)).isoformat(), "to": TODAY.isoformat()}
    for bad in ("0", "366", "abc"):
        r = client.get(URL, query_string={"store_code": "MAINTENANCE", "days": bad})
        assert r.status_code == 400


def test_q_matches_gate_no_vendor_and_part_no_case_blind(client):
    _login(client, _admin().id)
    tag = _tag()
    p1, p2, p3 = _part(tag, "ONE"), _part(tag, "TWO"), _part(tag, "THREE")
    _gate(f"{tag}-GE-ALPHA", p1.part_no, 1, ven_cd=f"{tag}VC", ven_name="Plain Vendor")
    _gate(f"{tag}-GE-BETA", p2.part_no, 1, ven_cd="VB-2", ven_name=f"{tag} Special Tools")
    _gate(f"{tag}-GE-GAMMA", p3.part_no, 1, ven_cd="VC-3", ven_name="Other Vendor")
    _gate(f"{tag}-GE-GAMMA", p1.part_no, 2, ven_cd="VC-3", ven_name="Other Vendor")

    def nos(q):
        return sorted(e["gate_entry_no"] for e in _list(client, q)["entries"])

    assert nos(f"{tag}-ge-alpha".lower()) == [f"{tag}-GE-ALPHA"]          # gate entry no.
    assert nos(f"{tag.lower()} special") == [f"{tag}-GE-BETA"]            # vendor name
    assert nos(f"{tag}vc".lower()) == [f"{tag}-GE-ALPHA"]                 # vendor code
    assert nos(f"{tag}-three".lower()) == [f"{tag}-GE-GAMMA"]             # part no.
    # A match by one part still lists the entry's other store items.
    gamma = _list(client, f"{tag}-THREE")["entries"][0]
    assert {i["part_no"] for i in gamma["items"]} == {p1.part_no, p3.part_no}
    assert nos(f"{tag}-nothing-like-this") == []


def test_default_copies_follow_the_gate_qty_with_a_cap():
    assert default_copies(4) == (4, False)
    assert default_copies(250) == (100, True)
    assert default_copies(2.5) == (3, True)
    assert default_copies(0.2) == (1, True)
    assert default_copies(None) == (1, True)
    assert default_copies(0) == (1, True)
    assert default_copies(100) == (100, False)


def test_listed_copies_are_capped_and_flagged(client):
    _login(client, _admin().id)
    tag = _tag()
    big, half, whole = _part(tag, "BIG"), _part(tag, "HALF"), _part(tag, "WHOLE")
    no = f"{tag}-GE"
    _gate(no, big.part_no, 250)
    _gate(no, half.part_no, 2.5)
    _gate(no, whole.part_no, 7)
    items = {i["part_id"]: i for i in _list(client, tag)["entries"][0]["items"]}
    assert (items[big.id]["default_copies"], items[big.id]["copies_capped"]) == (100, True)
    assert (items[half.id]["default_copies"], items[half.id]["copies_capped"]) == (3, True)
    assert (items[whole.id]["default_copies"], items[whole.id]["copies_capped"]) == (7, False)
    assert _list(client, tag)["entries"][0]["labels_total"] == 110


def test_freshness_block_reads_the_gate_mirror(client):
    _login(client, _admin().id)
    tag = _tag()
    p = _part(tag, "P")
    _gate(f"{tag}-GE", p.part_no, 1)
    newest, last_write = db.session.query(db.func.max(GateEntry.gate_entry_dt),
                                          db.func.max(GateEntry.created_at)).one()
    erp = _list(client, tag)["erp"]
    assert erp == {"synced_at": last_write.isoformat(), "newest_gate_date": newest.isoformat()}


# ---- printing ----

def test_print_records_one_audit_row_per_part_and_the_internal_barcode(client):
    user = _admin()
    _login(client, user.id)
    tag = _tag()
    a, b = _part(tag, "A"), _part(tag, "B", location=None)
    no = f"{tag}-GE"
    _gate(no, a.part_no, 3)
    _gate(no, b.part_no, 1)

    r = _print(client, no, [{"part_id": a.id, "copies": 3}, {"part_id": b.id, "copies": 2}],
               printer_name="  Store Zebra  ")
    assert r.status_code == 201, r.get_json()
    data = r.get_json()["data"]
    assert data["gate_entry_no"] == no and data["labels_total"] == 5
    assert [(p["part_id"], p["copies"], p["is_reprint"]) for p in data["printed"]] == [
        (a.id, 3, False), (b.id, 2, False)]

    rows = {r.part_id: r for r in LabelPrintAudit.query.filter_by(reference=no).all()}
    symbology = BarcodeService().label_config()["symbology"]
    ra = rows[a.id]
    assert (ra.source, ra.reference, ra.copies, ra.printer_name, ra.printed_by) == (
        "GATE_ENTRY", no, 3, "Store Zebra", user.username)
    assert (ra.barcode_value, ra.symbology, ra.location_printed, ra.is_reprint, ra.reason) == (
        a.part_no, symbology, "R1-S1-B1", False, None)
    assert rows[b.id].location_printed is None and rows[b.id].copies == 2
    for part in (a, b):
        internal = PartBarcode.query.filter_by(part_id=part.id, source="INTERNAL", is_primary=True).one()
        assert internal.code == part.part_no and internal.symbology == symbology
    # A label adds no stock and records no receipt (spec 9).
    assert SpareStockLedger.query.filter(SpareStockLedger.part_id.in_([a.id, b.id])).count() == 0
    assert SpareReceipt.query.filter(SpareReceipt.part_id.in_([a.id, b.id])).count() == 0


def test_printed_state_and_copies_follow_the_prints(client):
    _login(client, _admin().id)
    tag = _tag()
    a, b = _part(tag, "A"), _part(tag, "B")
    no = f"{tag}-GE"
    _gate(no, a.part_no, 2)
    _gate(no, b.part_no, 2)
    assert _print(client, no, [{"part_id": a.id, "copies": 2}]).status_code == 201
    e = _list(client, tag)["entries"][0]
    assert e["printed_state"] == "PARTLY"
    assert {i["part_id"]: i["printed_copies"] for i in e["items"]} == {a.id: 2, b.id: 0}

    assert _print(client, no, [{"part_id": b.id, "copies": 1}]).status_code == 201
    e = _list(client, tag)["entries"][0]
    assert e["printed_state"] == "PRINTED"
    # A label for the same part from elsewhere (no gate entry) is not counted.
    assert client.post("/api/v1/barcode/print", json={"part_id": b.id, "copies": 4,
                                                      "source": "QR_SCAN"}).status_code == 201
    e = _list(client, tag)["entries"][0]
    assert {i["part_id"]: i["printed_copies"] for i in e["items"]} == {a.id: 2, b.id: 1}


def test_a_second_print_for_the_same_gate_entry_is_a_reprint_that_needs_a_reason(client):
    _login(client, _admin().id)
    tag = _tag()
    a, b = _part(tag, "A"), _part(tag, "B")
    no, other = f"{tag}-GE", f"{tag}-GE2"
    _gate(no, a.part_no, 1)
    _gate(no, b.part_no, 1)
    _gate(other, a.part_no, 1)
    assert _print(client, no, [{"part_id": a.id, "copies": 1}]).status_code == 201

    r = _print(client, no, [{"part_id": a.id, "copies": 1}, {"part_id": b.id, "copies": 1}])
    assert r.status_code == 400 and a.part_no in r.get_json()["message"]
    assert LabelPrintAudit.query.filter_by(reference=no).count() == 1          # nothing written

    r = _print(client, no, [{"part_id": a.id, "copies": 1}, {"part_id": b.id, "copies": 1}],
               reason="Label torn")
    assert r.status_code == 201
    assert {p["part_id"]: p["is_reprint"] for p in r.get_json()["data"]["printed"]} == {a.id: True, b.id: False}
    reprint = LabelPrintAudit.query.filter_by(reference=no, part_id=a.id, is_reprint=True).one()
    first_b = LabelPrintAudit.query.filter_by(reference=no, part_id=b.id).one()
    assert reprint.reason == "Label torn" and first_b.reason is None
    # New material of the same part on another gate entry is not a reprint.
    assert _print(client, other, [{"part_id": a.id, "copies": 1}]).status_code == 201


def test_print_refuses_parts_not_on_the_entry_inactive_or_other_store(client):
    _login(client, _admin().id)
    tag = _tag()
    on, off = _part(tag, "ON"), _part(tag, "OFF")
    later_inactive = _part(tag, "LATER")
    child = _part(tag, "CH", store="CHILD_PART")
    no = f"{tag}-GE"
    _gate(no, on.part_no, 1)
    _gate(no, later_inactive.part_no, 1)
    _gate(no, child.part_no, 1)
    later_inactive.is_active = False
    db.session.commit()

    r = _print(client, no, [{"part_id": on.id, "copies": 1}, {"part_id": off.id, "copies": 1}])
    assert r.status_code == 400 and off.part_no in r.get_json()["message"]
    r = _print(client, no, [{"part_id": later_inactive.id, "copies": 1}])
    assert r.status_code == 400 and "inactive" in r.get_json()["message"]
    r = _print(client, no, [{"part_id": child.id, "copies": 1}])
    assert r.status_code == 400 and child.part_no not in r.get_json()["message"]
    r = _print(client, no, [{"part_id": 987654, "copies": 1}])
    assert r.status_code == 400
    assert _print(client, f"{tag}-NO-SUCH-ENTRY", [{"part_id": on.id, "copies": 1}]).status_code == 404
    assert LabelPrintAudit.query.filter(LabelPrintAudit.reference.like(f"{tag}%")).count() == 0


def test_print_copy_limits_and_totals(client):
    _login(client, _admin().id)
    tag = _tag()
    parts = [_part(tag, f"P{i}") for i in range(6)]
    no = f"{tag}-GE"
    for p in parts:
        _gate(no, p.part_no, 100)
    # Per part 1..100 and a well-formed body: the schema answers 422.
    assert _print(client, no, [{"part_id": parts[0].id, "copies": 0}]).status_code == 422
    assert _print(client, no, [{"part_id": parts[0].id, "copies": 101}]).status_code == 422
    assert _print(client, no, []).status_code == 422
    assert client.post(f"{URL}/print", json={"store_code": "MAINTENANCE",
                                             "items": [{"part_id": parts[0].id, "copies": 1}]}).status_code == 422
    # Six parts x 100 = 600 labels: over the 500 a print may hold.
    r = _print(client, no, [{"part_id": p.id, "copies": 100} for p in parts])
    assert r.status_code == 400 and "500" in r.get_json()["message"]
    r = _print(client, no, [{"part_id": parts[0].id, "copies": 1}, {"part_id": parts[0].id, "copies": 2}])
    assert r.status_code == 400
    assert LabelPrintAudit.query.filter_by(reference=no).count() == 0
    # Exactly 500 is allowed.
    r = _print(client, no, [{"part_id": p.id, "copies": 100} for p in parts[:5]])
    assert r.status_code == 201 and r.get_json()["data"]["labels_total"] == 500


def test_service_rules_hold_without_the_route():
    tag = _tag()
    p = _part(tag, "P")
    no = f"{tag}-GE"
    _gate(no, p.part_no, 1)
    svc = GateLabelService()
    for items in ([], [{"part_id": p.id, "copies": 0}], [{"part_id": p.id, "copies": 101}],
                  [{"part_id": p.id}], [{"part_id": p.id, "copies": 1}] * 2):
        with pytest.raises(BadRequestError):
            svc.record_print("MAINTENANCE", no, items)
    with pytest.raises(BadRequestError):
        svc.record_print("MAINTENANCE", "   ", [{"part_id": p.id, "copies": 1}])
    # The part belongs to MAINTENANCE: another store's list may not print it.
    with pytest.raises(BadRequestError):
        svc.record_print("CHILD_PART", no, [{"part_id": p.id, "copies": 1}])
    out = svc.record_print("MAINTENANCE", f"  {no} ", [{"part_id": p.id, "copies": 1}], user="svc")
    assert out["gate_entry_no"] == no and out["printed"][0]["is_reprint"] is False


def test_print_pushes_a_stock_event_and_a_refused_one_does_not(client, bus):
    _login(client, _admin().id)
    tag = _tag()
    p = _part(tag, "P")
    no = f"{tag}-GE"
    _gate(no, p.part_no, 1)
    assert _print(client, no, [{"part_id": p.id, "copies": 1}]).status_code == 201
    assert _events(bus) == [{"event": "stock", "data": {"part_ids": [p.id], "gate_entry_no": no,
                                                          "action": "label_print"}}]
    assert _print(client, no, [{"part_id": p.id, "copies": 1}]).status_code == 400   # reprint, no reason
    assert _events(bus) == []


def test_timeline_names_the_gate_entry(client):
    _login(client, _admin().id)
    tag = _tag()
    p = _part(tag, "P")
    no = f"{tag}-GE"
    _gate(no, p.part_no, 3)
    assert _print(client, no, [{"part_id": p.id, "copies": 3}]).status_code == 201
    assert _print(client, no, [{"part_id": p.id, "copies": 1}], reason="Faded").status_code == 201
    rows = [r for r in ScanResultService().timeline(p.id)["rows"] if r["kind"] == "LABEL_PRINT"]
    assert [r["title"] for r in rows] == [f"Label reprinted – 1 (gate entry {no})",
                                          f"Label printed – 3 (gate entry {no})"]
    assert rows[1]["detail"].startswith("Gate Entry")


def test_single_part_print_cannot_claim_the_gate_entry_source(client):
    _login(client, _admin().id)
    p = _part(_tag(), "P")
    r = client.post("/api/v1/barcode/print", json={"part_id": p.id, "source": "GATE_ENTRY"})
    assert r.status_code == 422
    r = client.post("/api/v1/barcode/print-bulk", json={"part_ids": [p.id], "source": "GATE_ENTRY"})
    assert r.status_code == 422


# ---- rights ----

def test_rights_view_to_list_edit_to_print_and_store_access(client):
    tag = _tag()
    p = _part(tag, "P")
    no = f"{tag}-GE"
    _gate(no, p.part_no, 1)
    body = [{"part_id": p.id, "copies": 1}]

    _login(client, _store_user({}).id)                                    # no rights
    assert client.get(URL, query_string={"store_code": "MAINTENANCE"}).status_code == 403
    assert _print(client, no, body).status_code == 403

    for module in ("scan_part", "store_stock", "part_master"):
        _login(client, _store_user({module: {"view": True}}).id)          # view only
        assert _list(client, tag)["entries"][0]["gate_entry_no"] == no
        assert _print(client, no, body).status_code == 403

    _login(client, _store_user({"scan_part": {"view": True, "edit": True}}, stores=("CHILD_PART",)).id)
    assert client.get(URL, query_string={"store_code": "MAINTENANCE"}).status_code == 403
    assert _print(client, no, body).status_code == 403

    _login(client, _store_user({"store_stock": {"view": True, "edit": True}}).id)
    assert client.get(URL).status_code == 400                             # store_code required
    assert _print(client, no, body).status_code == 201
