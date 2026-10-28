"""Packet codes and what their QR carries (the store, 28 Oct 2026: "TBdatepartnomber",
"2026 krna 26 ki jagah", "naye date wala and spec and location"): the code is
TB + DDMMYYYY + Part No. + "-NN" (that part's label number on that date) — the
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


def test_old_stock_labels_are_tb_today_part_and_number():
    p = _part(10)
    today = f"{date.today():%d%m%Y}"
    made = svc.old_stock_pack(p.id, 3, "UNIT", user="sup")["packets"]
    assert [m["code"] for m in made] == [f"TB{today}{p.part_no}-0{i}" for i in (1, 2, 3)]
    more = svc.old_stock_pack(p.id, 2, "UNIT", user="sup")["packets"]           # the same day: numbers carry on
    assert [m["code"] for m in more] == [f"TB{today}{p.part_no}-04", f"TB{today}{p.part_no}-05"]
    other = _part(5)
    assert svc.old_stock_pack(other.id, 1, "UNIT", user="sup")["packets"][0]["code"] == f"TB{today}{other.part_no}-01"


def test_a_receipts_labels_carry_the_date_the_material_came_in():
    p = _part(0)
    r = SpareBatch(receipt_no=f"RCP-T{_n['n']}", store_code=STORE, part_id=p.id, source="ERP_GRN",
                   received_on=date(2026, 10, 27), qty=4, uom="NOS")
    db.session.add(r)
    db.session.commit()
    SpareStockService().set_quantity(p.id, 4, txn_type="ADJUSTMENT")
    svc.verify(r.id, 4, user="sup")
    made = svc.pack(r.id, "UNIT", user="sup")["packets"]
    assert made[0]["code"] == f"TB27102026{p.part_no}-01" and made[-1]["code"] == f"TB27102026{p.part_no}-04"


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


def test_old_stock_batches_never_show_as_receipts():
    """28 Oct 2026: "receipt me shelf stock kyu dikha rha h" — a label of old
    stock made and cancelled leaves its batch; it is not a receipt."""
    p = _part(3)
    m = svc.old_stock_pack(p.id, 1, "UNIT", user="sup")["packets"][0]
    svc.cancel(m["code"], "testing", user="sup")
    assert svc.receipts(STORE, q=p.part_no)["rows"] == []
    assert svc.old_figures(p.id)["to_label"] == 3                         # back on the Old stock list
