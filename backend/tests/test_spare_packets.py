"""Packets, QR labels and FIFO for the Spare Parts Store (the store's spec of 27
Oct 2026): an ERP GRN accepted by quality is stock once and a receipt batch;
the supervisor verifies it, packs it (packet qty chosen, or one label per
unit), prints unique QR labels; packets go out whole, once, oldest receipt
first; and on hand always = loose + what is in available packets.

The store chose: stock comes in when ERP accepts (as before); stock already on
the shelf stays loose and may be made into an opening batch; packet or unit is
picked when the labels are made. The spec's acceptance tests are numbered."""
from datetime import date, datetime, timezone

import pytest

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.base import utcnow
from app.models.label_print_audit import LabelPrintAudit
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.spare_packet import SpareBatch, SparePacket
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.models.user import User, UserStoreAccess
from app.services.barcode_service import BarcodeService
from app.services.erp_grn_posting_service import SETTING_KEY, ErpGrnPostingService
from app.services.spare_packet_service import SparePacketService
from app.services.spare_stock_service import SpareStockService
from app.utils.exceptions import BadRequestError, NotFoundError

STORE = "MAINTENANCE"
DEPT = "Maintenance"
COUNTED_ON = datetime(2026, 9, 1, 4, 0, tzinfo=timezone.utc)
_seq = {"n": 0}
svc = SparePacketService()


@pytest.fixture(autouse=True)
def _grn_settings():
    AppSetting.set_value(SETTING_KEY, {"enabled": True, "from_date": "2026-08-01"})
    yield
    AppSetting.set_value(SETTING_KEY, {"enabled": True, "from_date": "2026-09-26"})


def _part(qty=0, name="HEX BOLT M8X25", pkt=20):
    """A part counted on 1 Sep 2026 at `qty`, packed `pkt` a packet (its Pkt Qty)."""
    _seq["n"] += 1
    p = Part(part_no=f"PKT-{_seq['n']}", part_name=f"{name} {_seq['n']}", uom="NOS",
             part_type="OTHER", store_code=STORE, location=f"R1-S1-B{_seq['n']}", package_standard=pkt)
    db.session.add(p)
    db.session.commit()
    SpareStockService().set_quantity(p.id, qty, txn_type="OPENING")
    row = SpareStock.query.filter_by(part_id=p.id).first()
    row.last_counted_at = COUNTED_ON
    row.created_at = COUNTED_ON
    for led in SpareStockLedger.query.filter_by(part_id=p.id).all():
        led.created_at = COUNTED_ON
    db.session.commit()
    return p


def _receive(part, grn_no, grn_date, qty, gate_entry="GE-1"):
    """An ERP GRN line accepted by quality, posted to stock the app's own way."""
    db.session.add(ReceivingRegister(
        store_code="CHILD_PART", grn_no=grn_no, grn_date=grn_date, ven_cd="V001", ven_name="Bolt Supplier",
        gate_entry_no=gate_entry, gate_entry_dt=grn_date, challan_no="INV-9", item_cd=part.part_no,
        receipt_qty=qty, accept_qty=qty))
    db.session.commit()
    ErpGrnPostingService().post(STORE)
    return SpareBatch.query.filter_by(part_id=part.id, grn_no=grn_no).one()


def _on_hand(part):
    return float(SpareStock.query.filter_by(part_id=part.id).first().qty_on_hand)


def _issue(code, **kw):
    return svc.issue(code, DEPT, user="tester", issued_to="Ravi", **kw)


def _bolts():
    """Spec tests 1-2: 100 bolts on 25 Oct packed 5 x 20; 200 on 27 Oct packed 10 x 20."""
    p = _part()
    a = _receive(p, "GRN-A", date(2026, 10, 25), 100)
    svc.verify(a.id, 100, user="sup")
    pa = svc.pack(a.id, "PACKET", packet_qty=20, user="sup")["packets"]
    b = _receive(p, "GRN-B", date(2026, 10, 27), 200)
    svc.verify(b.id, 200, user="sup")
    pb = svc.pack(b.id, "PACKET", packet_qty=20, user="sup")["packets"]
    return p, a, b, pa, pb


# ---- 1, 2, 3: receipts, packets, unique QR codes, receipt dates ------------------------------

def test_1_2_3_two_receipts_make_fifteen_unique_packets_with_their_dates():
    p, a, b, pa, pb = _bolts()
    assert (len(pa), len(pb)) == (5, 10)
    codes = [x["code"] for x in pa + pb]
    # TB + the receipt's date + Part No. + that part's label no. that day (28 Oct 2026)
    # No label number since 14 Nov 2026: one code a part a day; each packet its own id.
    assert len({x["id"] for x in pa + pb}) == 15
    assert set(codes) == {f"TB20261025{p.part_no.replace('-', '')}", f"TB20261027{p.part_no.replace('-', '')}"}
    assert {x["code"] for x in pa} == {f"TB20261025{p.part_no.replace('-', '')}"}
    assert [x["seq"] for x in pb] == list(range(1, 11))
    assert {x["receipt"]["received_on"] for x in pa} == {"2026-10-25"}
    assert {x["receipt"]["received_on"] for x in pb} == {"2026-10-27"}
    assert all(x["qty"] == 20 and x["status"] == "AVAILABLE" and x["kind"] == "PACKET" for x in pa + pb)
    assert pa[0]["receipt"]["gate_entry_no"] == "GE-1" and pa[0]["location"] == p.location
    # Packing changed no stock: 300 came in with the two GRNs, all of it now in packets.
    assert _on_hand(p) == 300
    assert svc.figures(p.id) == {"on_hand": 300, "packed_available": 300, "loose": 0}


# ---- 4, 5, 10: issue whole packets, oldest receipt first ----------------------------------------

def test_4_5_10_three_oldest_packets_go_whole_and_the_oldest_keeps_priority():
    p, a, b, pa, pb = _bolts()
    for x in pa[:3]:
        out = _issue(str(x["id"]))
        assert out["packet"]["status"] == "ISSUED" and out["issue"]["qty"] == 20     # the whole packet
    assert _on_hand(p) == 240                                                      # 60 deducted
    issues = SpareStockLedger.query.filter_by(part_id=p.id, txn_type="ISSUE").all()
    assert sorted(i.reference for i in issues) == sorted(x["code"] for x in pa[:3])
    fifo = svc.fifo(p.id)
    assert [x["code"] for x in fifo["packets"][:2]] == [x["code"] for x in pa[3:]]  # the 25 Oct ones next
    assert fifo["packets"][0]["issue_first"] and not fifo["packets"][2]["issue_first"]
    # A newer packet while 25 Oct still has two: refused, then allowed with a reason.
    with pytest.raises(BadRequestError, match="Older stock first") as exc:
        _issue(str(pb[0]["id"]))
    assert exc.value.errors["code"] == "FIFO" and exc.value.errors["oldest"]["code"] == pa[3]["code"]
    out = _issue(str(pb[0]["id"]), override_reason="Older packets damaged in transit")
    assert out["packet"]["fifo_override_reason"] == "Older packets damaged in transit"
    assert "FIFO skipped" in SpareStockLedger.query.get(out["issue"]["id"]).remarks
    assert _on_hand(p) == 220


def test_one_person_takes_four_of_the_same_part_at_once():
    """10 Nov 2026: "agar user 1 baar me same part 4 qty. le jaayega to uska bhi
    test karna h". Old stock counted on the shelf, labelled as 11 single
    units (like CNTR1541); one person takes 4: each label is scanned and
    issued in turn — no FIFO question between units of the same day, stock
    down by exactly 4, one ledger line per label, and no label goes twice."""
    p = _part(qty=11)
    units = svc.old_stock_pack(p.id, 11, "UNIT", user="sup")["packets"]
    assert len(units) == 11 and _on_hand(p) == 11
    taken = [units[0], units[5], units[2], units[9]]           # whichever four come to hand
    for u in taken:
        scan = BarcodeService().resolve(STORE, f"{u['code']} SPEC", user="tester")["packet"]
        assert scan["fifo"]["ok"] is True                         # the same day: no FIFO warning
        out = _issue(str(u["id"]))                                   # no reason asked
        assert out["packet"]["status"] == "ISSUED" and out["issue"]["qty"] == 1
    assert _on_hand(p) == 7                                       # 11 - 4
    lines = SpareStockLedger.query.filter_by(part_id=p.id, txn_type="ISSUE").all()
    assert sorted(x.reference for x in lines) == sorted(u["code"] for u in taken)
    assert all(x.department == DEPT and float(x.qty_delta) == -1 for x in lines)
    assert sorted(float(x.balance_after) for x in lines) == [7, 8, 9, 10]   # 11 → 7, one at a time
    assert svc.figures(p.id)["packed_available"] == 7
    with pytest.raises(BadRequestError, match="already issued"):
        _issue(str(taken[0]["id"]))                                  # the same label scanned again
    assert _on_hand(p) == 7


def test_packets_that_came_in_the_same_day_are_the_same_age():
    """10 Nov 2026: three CNTR1543 packets, all old stock counted 05 Nov but
    packed from two receipts, warned "received 05 Nov should go before this
    one (received 05 Nov)". Same day = same age: no FIFO warning between
    them; an older day still warns."""
    p = _part()
    first = _receive(p, "GRN-S1", date(2026, 10, 25), 40)
    svc.verify(first.id, 40, user="sup")
    p1 = svc.pack(first.id, "PACKET", packet_qty=20, user="sup")["packets"]
    second = _receive(p, "GRN-S2", date(2026, 10, 25), 40)          # another receipt, the same day
    svc.verify(second.id, 40, user="sup")
    p2 = svc.pack(second.id, "PACKET", packet_qty=20, user="sup")["packets"]
    later = _receive(p, "GRN-S3", date(2026, 10, 27), 20)
    svc.verify(later.id, 20, user="sup")
    p3 = svc.pack(later.id, "PACKET", packet_qty=20, user="sup")["packets"]
    scan = BarcodeService().resolve(STORE, p2[0]["code"], user="tester")["packet"]
    assert scan["fifo"]["ok"] is True                                   # no warning on the same day
    out = _issue(str(p2[0]["id"]))                                         # and no reason asked
    assert out["packet"]["status"] == "ISSUED" and not out["packet"]["fifo_override_reason"]
    fifo = svc.fifo(p.id)["packets"]
    assert [x["issue_first"] for x in fifo] == [True, True, True, False]  # both 25 Oct receipts first
    with pytest.raises(BadRequestError, match="Older stock first"):
        _issue(str(p3[0]["id"]))                                          # 27 Oct while 25 Oct waits
    assert {x["code"] for x in fifo[:3]} == {p1[0]["code"], p1[1]["code"], p2[1]["code"]}


# ---- 6: never twice ------------------------------------------------------------------------------------

def test_6_the_same_packet_cannot_be_issued_twice(monkeypatch):
    p, a, b, pa, pb = _bolts()
    _issue(str(pa[0]["id"]))
    with pytest.raises(BadRequestError, match="already issued"):
        _issue(str(pa[0]["id"]))
    # Two terminals: this one read the packet as available a moment before the other issued it.
    stale = db.session.get(SparePacket, pa[1]["id"])
    _ = (stale.batch.receipt_no, stale.part.part_no)            # loaded, as the other screen had it
    db.session.expunge(stale)
    SparePacket.query.filter_by(id=stale.id).update({"status": "ISSUED"}, synchronize_session=False)
    db.session.commit()
    stale.status = "AVAILABLE"                                 # what this screen still believes
    monkeypatch.setattr(SparePacketService, "_packet", staticmethod(lambda code, *a, **k: stale))
    monkeypatch.setattr(SparePacketService, "fifo_check", lambda self, packet: None)
    with pytest.raises(BadRequestError, match="just issued from another screen"):
        _issue(str(pa[1]["id"]))
    assert _on_hand(p) == 280                                  # only the first issue took stock


# ---- 7: never more than verified -------------------------------------------------------------------

def test_7_packing_more_than_verified_or_before_verifying_is_refused():
    p = _part()
    r = _receive(p, "GRN-C", date(2026, 10, 25), 100)
    with pytest.raises(BadRequestError, match="Verify the receipt"):
        svc.pack(r.id, "PACKET", packet_qty=20)
    with pytest.raises(BadRequestError, match="say why"):
        svc.verify(r.id, 90)                                   # a mismatch needs a remark
    svc.verify(r.id, 90, remarks="10 short in the box")
    with pytest.raises(BadRequestError, match="Only 4 full packet"):
        svc.pack(r.id, "PACKET", packet_qty=20, count=5)        # 5 x 20 = 100 > 90 counted
    out = svc.pack(r.id, "PACKET", packet_qty=20)
    assert len(out["packets"]) == 4 and out["loose_after"] == 10
    out = svc.pack(r.id, "PACKET", packet_qty=20, last_smaller=True)   # the last 10, only when asked
    assert [x["qty"] for x in out["packets"]] == [10]
    with pytest.raises(BadRequestError, match="already packed"):
        svc.pack(r.id, "PACKET", packet_qty=1)
    with pytest.raises(BadRequestError, match="cannot be less"):
        svc.verify(r.id, 50, remarks="recount")


# ---- 8: a reprint is audited and creates nothing ----------------------------------------------------

def test_8_printing_and_reprinting_never_add_stock():
    p, a, b, pa, pb = _bolts()
    code, pid = pa[0]["code"], str(pa[0]["id"])
    svc.record_print([pid], user="sup")
    with pytest.raises(BadRequestError, match="printed already — reprint it"):
        svc.record_print([pid], user="sup")                    # a second "first print" is a reprint
    with pytest.raises(BadRequestError, match="Say why"):
        svc.record_print([pid], reprint=True)
    svc.record_print([pid], reprint=True, reason="Label torn", user="sup")
    rows = LabelPrintAudit.query.filter_by(barcode_value=code).order_by(LabelPrintAudit.id).all()
    assert [(r.source, r.is_reprint, r.reason) for r in rows] == [("PACKET", False, None),
                                                                 ("PACKET", True, "Label torn")]
    assert rows[0].reference == a.receipt_no
    assert db.session.get(SparePacket, pa[0]["id"]).print_count == 2
    assert _on_hand(p) == 300 and SparePacket.query.filter_by(part_id=p.id).count() == 15


# ---- 9: the same gate entry / GRN read again ------------------------------------------------------

def test_9_the_same_grn_read_again_makes_no_second_receipt_or_stock():
    p = _part()
    _receive(p, "GRN-D", date(2026, 10, 25), 100)
    ErpGrnPostingService().post(STORE)                         # the ERP sync runs again
    svc.sync_receipts(STORE)
    svc.sync_receipts(STORE)
    assert SpareBatch.query.filter_by(part_id=p.id).count() == 1
    assert _on_hand(p) == 100


# ---- 11: everything reconciles ----------------------------------------------------------------------

def test_11_stock_reconciles_with_receipts_packets_and_issues():
    p, a, b, pa, pb = _bolts()
    for x in pa[:3]:
        _issue(str(x["id"]))
    svc.cancel(str(pb[-1]["id"]), "Packed by mistake")            # 20 loose again
    figs = svc.figures(p.id)
    received = sum(float(r.qty) for r in SpareBatch.query.filter_by(part_id=p.id))
    issued = -sum(float(l.qty_delta) for l in SpareStockLedger.query.filter_by(part_id=p.id, txn_type="ISSUE"))
    available = sum(float(x.qty) for x in SparePacket.query.filter_by(part_id=p.id, status="AVAILABLE"))
    assert (received, issued, available) == (300, 60, 220)
    assert figs["on_hand"] == received - issued == 240
    assert figs["on_hand"] == figs["loose"] + figs["packed_available"] and figs["loose"] == 20
    for r in SpareBatch.query.filter_by(part_id=p.id):
        held = sum(float(x.qty) for x in r.packets if x.status != "CANCELLED")
        assert held <= float(r.verified_qty) <= float(r.qty)


# ---- loose stock and packets never mix up -----------------------------------------------------------

def test_loose_quantity_issues_and_counts_never_eat_packed_stock():
    p, a, b, pa, pb = _bolts()                                 # 300 on hand, all in packets
    stock = SpareStockService()
    with pytest.raises(BadRequestError, match="in packets — scan a packet"):
        stock.issue(p.id, 5, DEPT, issued_to="Ravi")
    with pytest.raises(BadRequestError, match="stock cannot go below"):
        stock.set_quantity(p.id, 250, txn_type="ADJUSTMENT")
    svc.cancel(str(pa[0]["id"]), "Re-pack")                        # 20 loose
    stock.issue(p.id, 5, DEPT, issued_to="Ravi")                # by quantity: loose only
    with pytest.raises(BadRequestError, match="Loose on the shelf: 15"):
        stock.issue(p.id, 16, DEPT, issued_to="Ravi")
    assert _on_hand(p) == 295
    with pytest.raises(BadRequestError, match="only an available one"):
        svc.cancel(str(pa[0]["id"]), "again")


def test_stock_already_on_the_shelf_can_be_made_a_batch_and_packed():
    p = _part(qty=50)
    with pytest.raises(BadRequestError, match="Only 50"):
        svc.opening_receipt(p.id, 60)
    r = svc.opening_receipt(p.id, 50, user="sup")
    assert r["source"] == "OPENING" and r["verify_status"] == "VERIFIED" and r["received_on"] == "2026-09-01"
    out = svc.pack(r["id"], "PACKET", packet_qty=20, last_smaller=True, user="sup")
    assert [x["qty"] for x in out["packets"]] == [20, 20, 10] and _on_hand(p) == 50
    # It is the oldest stock: a later receipt's packets come after it.
    later = _receive(p, "GRN-E", date(2026, 10, 25), 20)
    svc.verify(later.id, 20)
    newer = svc.pack(later.id, "UNIT", count=2)["packets"]
    assert [x["qty"] for x in newer] == [1, 1] and all(x["kind"] == "UNIT" for x in newer)
    assert svc.fifo(p.id)["packets"][0]["receipt"]["source"] == "OPENING"
    with pytest.raises(BadRequestError, match="Older stock first"):
        _issue(str(newer[0]["id"]))


def test_a_packet_qr_scan_names_the_packet_and_an_unknown_one_is_not_mappable():
    p, a, b, pa, pb = _bolts()
    out = BarcodeService().resolve(STORE, pa[2]["code"].lower(), scan_source="CAMERA_SCAN", user="tester")
    assert out["resolved_by"] == "PACKET" and out["part_id"] == p.id
    assert out["packet"]["code"] == pa[2]["code"] and out["packet"]["fifo"]["ok"] is True
    newer = BarcodeService().resolve(STORE, pb[0]["code"], user="tester")["packet"]
    assert newer["fifo"]["ok"] is False and newer["fifo"]["oldest"]["code"] == pa[0]["code"]
    with pytest.raises(NotFoundError) as exc:
        BarcodeService().resolve(STORE, "SPK-ZZZZZZZZ", user="tester")
    assert exc.value.errors["result"] == "NO_PACKET"          # its own words on Scan Part, never "Map to Part"


# ---- the API and its rights ------------------------------------------------------------------------------

def _user(perms):
    _seq["n"] += 1
    u = User(username=f"pktuser{_seq['n']}", role="STORE_USER", is_active=True)
    u.set_password("pw-packets-1")
    u.set_permissions(perms)
    db.session.add(u)
    db.session.flush()
    db.session.add(UserStoreAccess(user_id=u.id, store_code=STORE))
    db.session.commit()
    return u


def test_api_rights_and_a_packet_issue_takes_no_quantity(app):
    p, a, b, pa, pb = _bolts()
    viewer = _user({"spare_packets": {"view": True}})
    maker = _user({"spare_packets": {"view": True, "create": True}})
    issuer = _user({"scan_part": {"view": True, "create": True}})
    c = app.test_client()

    def as_(u):
        with c.session_transaction() as s:
            s["user_id"] = u.id

    as_(viewer)
    assert c.get("/api/v1/spare-packets/receipts", query_string={"store_code": STORE}).status_code == 200
    assert c.get(f"/api/v1/spare-packets/parts/{p.id}/fifo").get_json()["data"]["packed_available"] == 300
    assert c.post(f"/api/v1/spare-packets/receipts/{a.id}/verify", json={"counted_qty": 100}).status_code == 403
    assert c.post(f"/api/v1/spare-packets/packets/{pa[0]['code']}/issue", json={"department": DEPT}).status_code == 403
    as_(maker)
    assert c.post("/api/v1/spare-packets/print", json={"codes": [pa[0]["code"]]}).status_code == 200
    assert c.post("/api/v1/spare-packets/print",
                  json={"codes": [pa[0]["code"]], "reprint": True, "reason": "torn"}).status_code == 403
    assert c.post(f"/api/v1/spare-packets/packets/{pa[0]['code']}/cancel", json={"reason": "x"}).status_code == 403
    as_(issuer)
    r = c.post(f"/api/v1/spare-packets/packets/{pa[0]['code']}/issue",
               json={"department": DEPT, "issued_to": "Ravi", "qty": 1})          # a qty sent is ignored
    assert r.status_code == 200 and r.get_json()["data"]["issue"]["qty"] == 20
    assert c.post(f"/api/v1/spare-packets/packets/{r.get_json()['data']['packet']['id']}/issue",
                  json={"department": DEPT, "issued_to": "Ravi"}).status_code == 400      # that packet again
    assert c.post(f"/api/v1/spare-packets/packets/{pa[0]['code']}/issue",
                  json={"department": DEPT, "issued_to": "Ravi"}).status_code == 200      # the code: the next one
    assert _on_hand(p) == 260


# ---- old stock on the shelf, rack by rack (27 Oct 2026) ---------------------------------------------

def _old_part(qty, location, tag):
    p = _part(qty, name=f"OLDSTK {tag}")
    p.location = location
    db.session.commit()
    return p


def test_old_stock_is_listed_rack_by_rack_and_labelled_in_one_step():
    tag = f"T{_seq['n']}"
    far = _old_part(7, "R10-S1-B1", tag)
    near = _old_part(50, "R2-S3-B4", tag)
    out = svc.old_stock(STORE, q=f"OLDSTK {tag}")
    assert [(r["part"]["id"], r["rack"], r["state"], r["to_label"]) for r in out["rows"]] == [
        (near.id, "R2", "TODO", 50), (far.id, "R10", "TODO", 7)]               # R2 before R10
    assert out["summary"] == {"parts": 2, "to_do": 2, "partly": 0, "done": 0, "qty_to_label": 57}
    assert [r["part"]["id"] for r in svc.old_stock(STORE, q=f"OLDSTK {tag}", rack="r10")["rows"]] == [far.id]

    plan = svc.old_stock_plan(near.id, 50, "PACKET", packet_qty=20)
    assert (plan["count"], plan["total"], plan["loose_after"]) == (2, 40, 10)
    made = svc.old_stock_pack(near.id, 50, "PACKET", packet_qty=20, last_smaller=True, user="sup")
    assert [x["qty"] for x in made["packets"]] == [20, 20, 10]
    batch = db.session.get(SpareBatch, made["packets"][0]["receipt"]["id"])
    assert (batch.source, float(batch.qty), batch.verify_status) == ("OPENING", 50, "VERIFIED")
    assert batch.received_on == COUNTED_ON.astimezone().date()                 # the shelf's count date: oldest
    assert made["figures"]["state"] == "DONE" and _on_hand(near) == 50         # labelling moved no stock

    with pytest.raises(BadRequestError, match="Counted 9 but the app has 7"):
        svc.old_stock_pack(far.id, 9, "UNIT", user="sup")
    made = svc.old_stock_pack(far.id, 5, "UNIT", user="sup")                   # the shelf had less
    assert len(made["packets"]) == 5 and made["figures"]["to_label"] == 2
    assert made["figures"]["state"] == "PARTLY"
    done = svc.old_stock(STORE, q=f"OLDSTK {tag}", show="done")["rows"]
    assert [r["part"]["id"] for r in done] == [near.id]
    # The opening batch is exactly what was packed: nothing of it waits "to pack" as a receipt.
    assert svc.receipt_dict(batch)["to_pack"] == 0


def test_a_receipt_waiting_to_be_packed_is_not_old_stock():
    tag = f"T{_seq['n']}"
    p = _old_part(0, "R5-S1-B1", tag)
    _receive(p, "GRN-OLD1", date(2026, 10, 26), 30)
    row = svc.old_stock(STORE, q=f"OLDSTK {tag}", show="all")["rows"][0]
    assert (row["on_hand"], row["waiting_in_receipts"], row["to_label"], row["state"]) == (30, 30, 0, "RECEIPT")
    with pytest.raises(BadRequestError, match="waiting in receipts 30"):
        svc.old_stock_plan(p.id, 30, "PACKET", packet_qty=10)


def test_receipt_rows_from_before_receipts_were_kept_stay_old_stock():
    p = _part()
    a = _receive(p, "GRN-SINCE1", date(2026, 10, 26), 10)
    since = svc.receipts_since()
    ledger = db.session.get(SpareStockLedger, a.ledger_id)
    db.session.delete(a)
    ledger.created_at = datetime(2026, 9, 2, tzinfo=timezone.utc)              # long before
    db.session.commit()
    svc.sync_receipts(STORE)
    assert SpareBatch.query.filter_by(ledger_id=ledger.id).first() is None
    ledger.created_at = max(utcnow(), since)                                   # one the GRN post missed
    db.session.commit()
    svc.sync_receipts(STORE)
    assert SpareBatch.query.filter_by(ledger_id=ledger.id).count() == 1


# ---- the supplier's own label on the box (27 Oct 2026) ----------------------------------------------

def _verified(qty, grn):
    p = _part()
    r = _receive(p, grn, date(2026, 10, 26), qty)
    svc.verify(r.id, qty, user="sup")
    return p, r


def test_boxes_with_their_own_supplier_codes_are_packets_that_scan_as_themselves():
    p, r = _verified(60, "GRN-BOX1")
    boxes = [f"BOLTCO|{p.part_no}X|LOT9|BOX{i}" for i in (1, 2, 3)]
    with pytest.raises(BadRequestError, match="3 boxes, 2 scanned"):
        svc.pack(r.id, "PACKET", packet_qty=20, supplier_codes=boxes[:2])
    with pytest.raises(BadRequestError, match="Box 3 has the same code as box 1") as exc:
        svc.pack(r.id, "PACKET", packet_qty=20, supplier_codes=[boxes[0], boxes[1], boxes[0]])
    assert exc.value.errors["code"] == "SAME_CODE"
    with pytest.raises(BadRequestError, match="own code") as exc:
        svc.pack(r.id, "PACKET", packet_qty=20, supplier_codes=[boxes[0], boxes[1], p.part_no])
    assert exc.value.errors["code"] == "SAME_CODE"
    made = svc.pack(r.id, "PACKET", packet_qty=20, supplier_codes=boxes, user="sup")["packets"]
    assert [x["supplier_code"] for x in made] == boxes and all(x["code"].startswith("TB") for x in made)

    out = BarcodeService().resolve(STORE, f"  {boxes[1]} ", user="tester")
    assert out["resolved_by"] == "PACKET" and out["packet"]["code"] == made[1]["code"]
    assert out["scanned_code"] == boxes[1]
    assert svc.check_box_code(p.id, boxes[1])["ok"] is False                   # on a box on the shelf already
    _issue(str(made[0]["id"]))
    again = BarcodeService().resolve(STORE, boxes[0], user="tester")["packet"]
    assert again["status"] == "ISSUED"                                         # a second scan says so
    assert _on_hand(p) == 40


def test_the_same_code_on_every_box_is_mapped_to_the_part_and_the_receipt_kept_loose():
    p, r = _verified(40, "GRN-SAME1")
    code = f"VENDOR-{p.part_no}-77"
    assert svc.check_box_code(p.id, code) == {"code": code, "ok": True, "message": None, "same": False,
                                             "fields": [code]}
    out = svc.keep_loose(p.id, code, receipt_id=r.id, user="sup")
    assert (out["mapped"], out["already"], out["receipt"]["to_pack"]) == (code, False, 0)
    assert "kept loose" in out["receipt"]["loose_note"]
    with pytest.raises(BadRequestError, match="kept loose"):
        svc.plan(db.session.get(SpareBatch, r.id), "PACKET", packet_qty=10)
    scan = BarcodeService().resolve(STORE, code, user="tester")
    assert (scan["part_id"], scan["resolved_by"], scan.get("packet")) == (p.id, "SUPPLIER", None)
    assert svc.check_box_code(p.id, code)["same"] is True
    assert svc.keep_loose(p.id, code, user="sup")["already"] is True           # nothing more to map
    assert svc.reopen(r.id)["to_pack"] == 40

    # A supplier QR of several fields: its item code is picked, never the whole read.
    q, _ = _verified(10, "GRN-SAME2")
    item = f"ITM{q.part_no}"
    with pytest.raises(BadRequestError, match="Pick the part's item code") as exc:
        svc.keep_loose(q.id, f"{item}|LOT5|10")
    assert exc.value.errors["fields"] == [f"{item}|LOT5|10", item, "LOT5"]
    svc.keep_loose(q.id, f"{item}|LOT5|10", map_code=item, user="sup")
    assert BarcodeService().resolve(STORE, f"{item}|LOT6|25", user="tester")["part_id"] == q.id
    with pytest.raises(BadRequestError, match="belongs to another part"):
        svc.keep_loose(p.id, item)


def test_old_stock_and_supplier_code_api_rights(app):
    tag = f"T{_seq['n']}"
    p = _old_part(12, "R7-S1-B1", tag)
    p.package_standard = 6                  # its Pkt Qty
    db.session.commit()
    viewer = _user({"spare_packets": {"view": True}})
    maker = _user({"spare_packets": {"view": True, "create": True}})
    c = app.test_client()

    def as_(u):
        with c.session_transaction() as s:
            s["user_id"] = u.id

    as_(viewer)
    body = c.get("/api/v1/spare-packets/old-stock",
                 query_string={"store_code": STORE, "q": f"OLDSTK {tag}"}).get_json()["data"]
    assert [r["part"]["id"] for r in body["rows"]] == [p.id] and isinstance(body["sections"], list)
    assert c.post(f"/api/v1/spare-packets/old-stock/{p.id}/plan",
                  json={"counted_qty": 12, "kind": "PACKET", "packet_qty": 6}).get_json()["data"]["count"] == 2
    assert c.post(f"/api/v1/spare-packets/old-stock/{p.id}/pack",
                  json={"counted_qty": 12, "kind": "PACKET", "packet_qty": 6}).status_code == 403
    assert c.post(f"/api/v1/spare-packets/parts/{p.id}/keep-loose", json={"code": "ZZ-1"}).status_code == 403
    as_(maker)
    r = c.post(f"/api/v1/spare-packets/old-stock/{p.id}/pack",
               json={"counted_qty": 12, "kind": "PACKET", "packet_qty": 6, "supplier_codes": [f"B-{tag}-1", f"B-{tag}-2"]})
    assert r.status_code == 201 and "nothing to print" in r.get_json()["message"]
    assert c.post(f"/api/v1/spare-packets/old-stock/{p.id}/pack",
                  json={"counted_qty": 1, "kind": "UNIT", "supplier_codes": "B-3"}).status_code == 400


# ---- undo a verification made by mistake (4 Nov 2026: "haan bna de") ------------------------------

def test_a_verification_is_undone_with_a_reason_and_audited():
    from app.models.audit_log import AuditLog
    p = _part()
    r = _receive(p, f"GRN-UV{_seq['n']}", date(2026, 11, 3), 5)
    svc.verify(r.id, 5, user="sup")
    with pytest.raises(BadRequestError, match="Say why"):
        svc.unverify(r.id, "  ", user="boss")
    out = svc.unverify(r.id, "wrong receipt", user="boss")
    assert (out["verify_status"], out["verified_qty"], out["verified_by"], out["verified_at"]) == ("PENDING", None, None, None)
    log = AuditLog.query.filter_by(action="RECEIPT_UNVERIFIED", entity_id=r.id).one()
    assert "by boss" in log.remarks and "verified 5 by sup" in log.remarks and "wrong receipt" in log.remarks
    assert float(log.quantity) == 5
    with pytest.raises(BadRequestError, match="nothing to undo"):
        svc.unverify(r.id, "again", user="boss")
    # Counted again, it goes on as before; no stock moved either way.
    before = _on_hand(p)
    svc.verify(r.id, 5, user="sup")
    assert svc.receipt_dict(r)["verify_status"] == "VERIFIED" and _on_hand(p) == before


def test_no_undo_while_a_label_of_it_is_live_but_after_cancelling_it():
    p = _part()
    r = _receive(p, f"GRN-UL{_seq['n']}", date(2026, 11, 3), 4)
    svc.verify(r.id, 4, user="sup")
    made = svc.pack(r.id, "UNIT", user="sup")["packets"]
    with pytest.raises(BadRequestError, match="cancel them first"):
        svc.unverify(r.id, "testing", user="boss")
    for m in made:
        svc.cancel(str(m["id"]), "testing", user="boss")
    assert svc.unverify(r.id, "testing", user="boss")["verify_status"] == "PENDING"


def test_undo_needs_the_delete_right(app):
    p = _part()
    r = _receive(p, f"GRN-UR{_seq['n']}", date(2026, 11, 3), 3)
    svc.verify(r.id, 3, user="sup")
    maker = _user({"spare_packets": {"view": True, "create": True, "update": True}})
    boss = _user({"spare_packets": {"view": True, "create": True, "update": True, "delete": True}})
    c = app.test_client()

    def as_(u):
        with c.session_transaction() as s:
            s["user_id"] = u.id

    url = f"/api/v1/spare-packets/receipts/{r.id}/unverify"
    as_(maker)
    assert c.post(url, json={"reason": "wrong receipt"}).status_code == 403
    as_(boss)
    assert c.post(url, json={}).status_code == 400
    resp = c.post(url, json={"reason": "wrong receipt"})
    assert resp.status_code == 200 and resp.get_json()["data"]["verify_status"] == "PENDING"


# ---- several labels of ONE part in one issue (10 Nov 2026) ------------------------------------------
# "1 baar me scan karke 4 nhi jud sakte" … "ek hi part jaise cntr1541 … 4 qty" … "part hi alag
# alaag h to wo to alag alag hi issue hone chahiye" … "tabhi to part ki history banegei".

def _units(n=11):
    p = _part(qty=n)
    return p, svc.old_stock_pack(p.id, n, "UNIT", user="sup")["packets"]


def test_four_labels_of_one_part_go_out_in_one_issue_each_its_own_line():
    p, units = _units()
    # Every unit carries the same code: scanning it four times is four pieces, oldest first.
    code = units[0]["code"]
    codes = [code, code + " PCIMR6-12-1.0", code, code]
    check = svc.issue_check(codes)
    assert check["count"] == 4 and check["qty"] == 4 and check["fifo"]["ok"] is True
    assert [x["id"] for x in check["packets"]] == [units[i]["id"] for i in range(4)]
    # The screen sends back the ids it holds, plus a new scan: the same four, then the next.
    again = svc.issue_check([str(x["id"]) for x in check["packets"]] + [code])
    assert [x["id"] for x in again["packets"]] == [units[i]["id"] for i in range(5)]
    out = svc.issue_many(codes, DEPT, user="tester", issued_to="Ravi", remarks="line 3 jig")
    assert out["count"] == 4 and out["qty"] == 4 and out["part_no"] == p.part_no
    assert [x["seq"] for x in out["packets"]] == [1, 2, 3, 4]                                # oldest first
    assert all(x["status"] == "ISSUED" and x["department"] == DEPT for x in out["packets"])
    assert _on_hand(p) == 7
    lines = SpareStockLedger.query.filter_by(part_id=p.id, txn_type="ISSUE").all()
    assert len(lines) == 4 and {x.reference for x in lines} == {code}
    assert all("line 3 jig" in x.remarks for x in lines)
    with pytest.raises(BadRequestError, match="already issued"):
        svc.issue_check([str(units[2]["id"]), str(units[3]["id"])])      # those went already


def test_a_different_part_or_a_used_label_stops_the_whole_issue():
    p, units = _units(6)
    other, others = _units(3)
    with pytest.raises(BadRequestError, match="different part is issued separately") as exc:
        svc.issue_many([units[0]["code"], others[0]["code"]], DEPT, user="tester", issued_to="Ravi")
    assert exc.value.errors["code"] == "OTHER_PART"
    svc.issue(str(units[2]["id"]), DEPT, user="tester", issued_to="Ravi")
    with pytest.raises(BadRequestError, match="already issued"):
        svc.issue_many([str(units[0]["id"]), str(units[1]["id"]), str(units[2]["id"])], DEPT, user="tester")
    # Six units, one gone: a seventh scan of the code finds no more on the shelf.
    with pytest.raises(BadRequestError, match="No more packets"):
        svc.issue_check([units[0]["code"]] * 6)
    assert _on_hand(p) == 5 and _on_hand(other) == 3                   # nothing of either went out
    assert db.session.get(SparePacket, units[0]["id"]).status == "AVAILABLE"
    with pytest.raises(NotFoundError):
        svc.issue_many([units[0]["code"], "TB20261110NOPART-01"], DEPT, user="tester")
    with pytest.raises(BadRequestError, match="No labels"):
        svc.issue_check([" ", None])


def test_labels_that_skip_an_older_day_need_one_reason_for_all():
    p, a, b, pa, pb = _bolts()                                          # 5 packets of 25 Oct, 10 of 27 Oct
    newer = [pb[0]["code"], pb[1]["code"]]
    assert svc.issue_check(newer)["fifo"]["oldest"]["code"] == pa[0]["code"]
    with pytest.raises(BadRequestError, match="Older stock first") as exc:
        svc.issue_many(newer, DEPT, user="tester", issued_to="Ravi")
    assert exc.value.errors["code"] == "FIFO" and _on_hand(p) == 300
    out = svc.issue_many(newer, DEPT, user="tester", issued_to="Ravi", override_reason="user asked for this lot")
    assert all(x["fifo_override_reason"] == "user asked for this lot" for x in out["packets"])
    # All five 25 Oct packets in one issue skip nothing; with one 27 Oct packet they still skip nothing.
    assert svc.issue_check([x["code"] for x in pa] + [pb[2]["code"]])["fifo"]["ok"] is True
    assert svc.issue_check([x["code"] for x in pa[:4]] + [pb[2]["code"]])["fifo"]["ok"] is False


def test_issue_many_api_takes_the_scan_part_issue_right(app):
    p, units = _units(5)
    viewer = _user({"spare_packets": {"view": True}})
    issuer = _user({"scan_part": {"view": True, "create": True}})
    c = app.test_client()

    def as_(u):
        with c.session_transaction() as s:
            s["user_id"] = u.id

    codes = [units[0]["code"], units[1]["code"], units[2]["code"]]
    as_(viewer)
    assert c.post("/api/v1/spare-packets/packets/issue-check", json={"codes": codes}).status_code == 403
    assert c.post("/api/v1/spare-packets/packets/issue-many", json={"codes": codes, "department": DEPT}).status_code == 403
    as_(issuer)
    r = c.post("/api/v1/spare-packets/packets/issue-check", json={"codes": codes})
    assert r.status_code == 200 and r.get_json()["data"]["qty"] == 3
    assert c.post("/api/v1/spare-packets/packets/issue-many", json={"codes": codes}).status_code == 400   # no department
    assert c.post("/api/v1/spare-packets/packets/issue-many", json={"codes": "x", "department": DEPT}).status_code == 400
    r = c.post("/api/v1/spare-packets/packets/issue-many", json={"codes": codes, "department": DEPT, "issued_to": "Ravi"})
    assert r.status_code == 200 and r.get_json()["data"]["count"] == 3 and "3 labels" in r.get_json()["message"]
    assert _on_hand(p) == 2


# ---- Pkt Qty: only a part with one is packed, that many a packet (13 Nov 2026) ------------------

def test_only_a_part_with_a_pkt_qty_is_packed_and_always_by_it():
    p = _part(pkt=None)
    r = _receive(p, "GRN-PQ1", date(2026, 10, 25), 60)
    svc.verify(r.id, 60, user="sup")
    with pytest.raises(BadRequestError, match="no Pkt Qty in Part Master") as exc:
        svc.pack(r.id, "PACKET", packet_qty=20)
    assert exc.value.errors == {"code": "NO_PKT_QTY"}
    # Individual-part labels need no Pkt Qty.
    assert svc.plan(db.session.get(SpareBatch, r.id), "UNIT")["sizes"][0] == 1
    # Set in Part Master: packed by it - the qty need not be sent, another one is refused.
    p.package_standard = 30
    db.session.commit()
    assert [float(x) for x in svc.plan(db.session.get(SpareBatch, r.id), "PACKET")["sizes"]] == [30, 30]
    with pytest.raises(BadRequestError, match="packed 30 a packet"):
        svc.pack(r.id, "PACKET", packet_qty=20)
    made = svc.pack(r.id, "PACKET", user="sup")["packets"]
    assert [x["qty"] for x in made] == [30, 30]
    assert made[0]["part"]["packet_qty"] == 30


def test_supplier_boxes_keep_their_own_qty_and_old_stock_follows_the_pkt_qty():
    p = _part(pkt=None)
    r = _receive(p, "GRN-PQ2", date(2026, 10, 25), 40)
    svc.verify(r.id, 40, user="sup")
    boxes = [f"SUPBOX-{p.part_no}-{i}" for i in (1, 2, 3, 4)]
    made = svc.pack(r.id, "PACKET", packet_qty=10, supplier_codes=boxes, user="sup")["packets"]
    assert [x["qty"] for x in made] == [10, 10, 10, 10]
    old = _part(25, name="OLDPQ", pkt=10)
    plan = svc.old_stock_plan(old.id, 25, "PACKET", last_smaller=True)
    assert (plan["count"], plan["packet_qty"], plan["last_qty"]) == (3, 10, 5)
    with pytest.raises(BadRequestError, match="no Pkt Qty"):
        svc.old_stock_plan(_part(5, name="OLDNOPQ", pkt=None).id, 5, "PACKET", packet_qty=5)


# ---- a whole rack labelled in one go (14 Nov 2026) --------------------------------------------------

def test_a_rack_is_labelled_in_one_go_packets_or_pieces_by_pkt_qty(app):
    tag = f"T{_seq['n']}"
    bolts = _old_part(75, "R9-S1-B2", tag)                 # Pkt Qty 20 (the helper's)
    cyl = _old_part(3, "R9-S1-B1", tag)
    cyl.package_standard = None                             # no Pkt Qty: a label a piece
    over = _old_part(2, "R9-S2-B1", tag)
    db.session.commit()
    rack = svc.old_stock(STORE, rack="R9", q=f"OLDSTK {tag}", show="todo", everything=True)["rows"]
    assert {r["part"]["id"] for r in rack} == {bolts.id, cyl.id, over.id}
    out = svc.rack_pack([{"part_id": bolts.id, "counted_qty": 75}, {"part_id": cyl.id, "counted_qty": 3},
                         {"part_id": over.id, "counted_qty": 9},           # more than the app has
                         {"part_id": over.id, "counted_qty": ""}], user="sup")  # not counted: skipped
    assert out["parts"] == 2 and [e["part_no"] for e in out["errors"]] == [over.part_no]
    # Rack order: R9-S1-B1 (3 pieces) first, then R9-S1-B2 (3 x 20 + 15).
    assert [(p["part"]["id"], p["kind"], p["qty"]) for p in out["packets"]] == (
        [(cyl.id, "UNIT", 1)] * 3 + [(bolts.id, "PACKET", 20)] * 3 + [(bolts.id, "PACKET", 15)])
    assert svc.old_figures(bolts.id)["to_label"] == 0 and svc.old_figures(over.id)["to_label"] == 2
    c = app.test_client()
    with c.session_transaction() as s:
        s["user_id"] = _user({"spare_packets": {"view": True}}).id
    assert c.get("/api/v1/spare-packets/old-stock/rack", query_string={"store_code": STORE, "rack": "R9"}).status_code == 200
    assert c.post("/api/v1/spare-packets/old-stock/rack-pack", json={"items": []}).status_code == 403
