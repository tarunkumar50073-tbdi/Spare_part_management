"""Packet codes and what their QR carries (the store, 28 Oct 2026: "TBdatepartnomber",
"2026 krna 26 ki jagah", "naye date wala and spec and location"): the code is
TB + YYYYMMDD + Part No. + "-NN" (that part's label number on that date; the
date was DDMMYYYY until 10 Nov 2026: "tb k baad yyyymmdd format hona chahiye") — the
receipt's date, or the labelling day for old stock — and the QR carries
"CODE | spec | location". Scanning the whole QR finds the packet by its code;
older SPK- codes keep working."""
from datetime import date

from app.extensions import db
from app.models.part import Part
from app.models.spare_packet import SpareBatch, SparePacket
from app.services.barcode_service import BarcodeService
from app.services.spare_packet_service import SparePacketService, is_packet_code, normalize_code
from app.services.spare_stock_service import SpareStockService

STORE = "MAINTENANCE"
svc = SparePacketService()
_n = {"n": 0}


def _part(qty=10, spec="HSS TAP 1/2'' BSP"):
    _n["n"] += 1
    p = Part(part_no=f"CNTC{_n['n']:04d}", part_name="HSS TAP", uom="NOS", part_type="OTHER", store_code=STORE,
             location=f"R5-S1-B{_n['n']}(1)", specification=spec)
    db.session.add(p)
    db.session.commit()
    SpareStockService().set_quantity(p.id, qty, txn_type="OPENING")
    return p


def test_old_stock_labels_are_tb_today_and_part_no_without_a_number():
    """14 Nov 2026: "dono me number hata de" - every label of a part on a day
    carries the same code; the packets are told apart by id and seq."""
    p = _part(10)
    today = f"{date.today():%Y%m%d}"
    made = svc.old_stock_pack(p.id, 3, "UNIT", user="sup")["packets"]
    assert [m["code"] for m in made] == [f"TB{today}{p.part_no}"] * 3
    assert len({m["id"] for m in made}) == 3 and [m["seq"] for m in made] == [1, 2, 3]
    more = svc.old_stock_pack(p.id, 2, "UNIT", user="sup")["packets"]           # the same day: the same code
    assert [m["code"] for m in more] == [f"TB{today}{p.part_no}"] * 2
    other = _part(5)
    assert svc.old_stock_pack(other.id, 1, "UNIT", user="sup")["packets"][0]["code"] == f"TB{today}{other.part_no}"


def test_a_receipts_labels_carry_the_date_the_material_came_in():
    p = _part(0)
    r = SpareBatch(receipt_no=f"RCP-T{_n['n']}", store_code=STORE, part_id=p.id, source="ERP_GRN",
                   received_on=date(2026, 10, 27), qty=4, uom="NOS")
    db.session.add(r)
    db.session.commit()
    SpareStockService().set_quantity(p.id, 4, txn_type="ADJUSTMENT")
    svc.verify(r.id, 4, user="sup")
    made = svc.pack(r.id, "UNIT", user="sup")["packets"]
    assert {m["code"] for m in made} == {f"TB20261027{p.part_no}"} and len(made) == 4


def test_the_qr_carries_code_spec_and_location_and_a_scan_finds_the_packet():
    p = _part(5)
    m = svc.old_stock_pack(p.id, 1, "UNIT", user="sup")["packets"][0]
    assert m["qr"] == f"{m['code']} | HSS TAP 1/2'' BSP | {p.location}"
    scan = BarcodeService().resolve(STORE, m["qr"], user="tester")                 # the whole QR read
    assert scan["packet"]["code"] == m["code"] and scan["packet"]["part"]["id"] == p.id
    assert BarcodeService().resolve(STORE, m["code"].lower(), user="tester")["packet"]["code"] == m["code"]
    nospec = _part(5, spec=None)
    n = svc.old_stock_pack(nospec.id, 1, "UNIT", user="sup")["packets"][0]
    assert n["qr"] == f"{n['code']} | {nospec.location}"
    # The spec goes in up to 68 letters (10 Nov 2026: "68 kar de"; was 60).
    long_spec = "SCANNER 1950GSR-2-1-INT WITH 5VDC POWER ADAPTER ,232 PORT (HONEYWELL)"
    lp = _part(5, spec=long_spec)
    q = svc.old_stock_pack(lp.id, 1, "UNIT", user="sup")["packets"][0]
    assert q["qr"] == f"{q['code']} | {long_spec[:68]} | {lp.location}"


def test_older_spk_codes_keep_working():
    p = _part(5)
    m = svc.old_stock_pack(p.id, 1, "UNIT", user="sup")["packets"][0]
    SparePacket.query.filter_by(code=m["code"]).update({"code": f"SPK-OLD{_n['n']:05d}"})
    db.session.commit()
    code = f"SPK-OLD{_n['n']:05d}"
    assert BarcodeService().resolve(STORE, code, user="tester")["packet"]["code"] == code
    assert is_packet_code(code) and is_packet_code("TB28102026CNTR0332-01")
    assert is_packet_code("TB28102026CNTR0332-01 | HSS TAP | R5-S1-B1(1)")
    assert not is_packet_code("CNTR0332") and not is_packet_code("TB2810")
    assert normalize_code(" tb28102026cntr0332-01 | spec | loc ") == "TB28102026CNTR0332-01"
    # A scanner on another keyboard layout / Caps Lock types "|" as "\\" and
    # the spec in lower case (10 Nov 2026): the code still comes through.
    assert normalize_code("TB10112026CNTR1544-01 \\ pcimr5-10-1") == "TB10112026CNTR1544-01"
    assert normalize_code("TB10112026CNTR1544-01\\PCIMR5-10-1.0") == "TB10112026CNTR1544-01"
    assert normalize_code("tb10112026cntr1544-01 / PCIMR5") == "TB10112026CNTR1544-01"
    assert is_packet_code("TB10112026CNTR1544-01 \\ pcimr5-10-1")
    # A tiny label's QR since 10 Nov 2026: the code, a space, the spec in the
    # QR's own letters (so its squares can be 4 printer dots).
    tiny = "TB20261110CNTR3953-01 LOOP PIPE DIM 11.5 SENSOR BLOCK"
    assert normalize_code(tiny) == "TB20261110CNTR3953-01" and is_packet_code(tiny)
    assert BarcodeService().resolve(STORE, f"{code} SOME SPEC", user="tester")["packet"]["code"] == code
    # A wireless gun that drops an Enter (10 Nov 2026): the tail of the read
    # before, or a stray letter, sits in front of the code; two reads run on.
    assert normalize_code("232 PORT HONEYWELLTB20261110CGMM0810-01 SCANNER 1950") == "TB20261110CGMM0810-01"
    assert normalize_code("hTB20261110CNTR3953-01 LOOP PIPE IM") == "TB20261110CNTR3953-01"
    assert normalize_code("TB20261110CGMM0810-01 SCANNER 232 PORT TB20261110CGMM0810-02 SCANNER") == "TB20261110CGMM0810-01"
    assert normalize_code("spk-ab12cd34") == "SPK-AB12CD34" and normalize_code("CNTR0332") == "CNTR0332"
    tb = svc.old_stock_pack(_part(5).id, 1, "UNIT", user="sup")["packets"][0]["code"]
    assert BarcodeService().resolve(STORE, f"232 PORT HONEYWELL{tb} SCANNER", user="tester")["packet"]["code"] == tb


def test_old_stock_batches_never_show_as_receipts():
    """28 Oct 2026: "receipt me shelf stock kyu dikha rha h" — a label of old
    stock made and cancelled leaves its batch; it is not a receipt."""
    p = _part(3)
    m = svc.old_stock_pack(p.id, 1, "UNIT", user="sup")["packets"][0]
    svc.cancel(m["code"], "testing", user="sup")
    assert svc.receipts(STORE, q=p.part_no)["rows"] == []
    assert svc.old_figures(p.id)["to_label"] == 3                         # back on the Old stock list


def test_ddmmyyyy_labels_made_before_10_nov_keep_working():
    """Labels printed with the old date order (TB10112026…) still scan to their
    packet, and a new label of the same part on the same day starts its own
    YYYYMMDD numbering without clashing with them."""
    p = _part(5)
    m = svc.old_stock_pack(p.id, 1, "UNIT", user="sup")["packets"][0]
    old = f"TB{date.today():%d%m%Y}{p.part_no}-01"
    SparePacket.query.filter_by(code=m["code"]).update({"code": old})
    db.session.commit()
    assert is_packet_code(old) and is_packet_code(f"{old} \\ hss tap")
    scan = BarcodeService().resolve(STORE, f"{old} | HSS TAP 1/2'' BSP | {p.location}", user="tester")
    assert scan["packet"]["code"] == old
    new = svc.old_stock_pack(p.id, 1, "UNIT", user="sup")["packets"][0]["code"]
    assert new == f"TB{date.today():%Y%m%d}{p.part_no}" and new != old



def test_a_code_scanned_again_takes_the_next_packet_and_old_numbered_labels_still_scan():
    p = _part(10)
    made = svc.old_stock_pack(p.id, 3, "UNIT", user="sup")["packets"]
    code = made[0]["code"]
    assert normalize_code(f"{code} HSS TAP") == code and is_packet_code(code)
    # Each scan of the code: the oldest on the shelf.
    first = BarcodeService().resolve(STORE, code, user="tester")["packet"]
    assert first["id"] == made[0]["id"]
    svc.issue(code, "Maintenance", issued_to="Ravi", user="t")
    assert BarcodeService().resolve(STORE, code, user="tester")["packet"]["id"] == made[1]["id"]
    # A label printed with the old "-NN" finds the same packets.
    assert BarcodeService().resolve(STORE, f"{code}-03", user="tester")["packet"]["id"] == made[1]["id"]
    out = svc.issue_check([code, code])
    assert [x["id"] for x in out["packets"]] == [made[1]["id"], made[2]["id"]]
