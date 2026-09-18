"""A spare part's suppliers are derived live from ERP gate entries, never
stored: the same part_no (= ERP item_code) arrives from several vendors over
time, so a part is not tied to one supplier and traceability lists them all,
newest arrival first."""
from datetime import date

from app.extensions import db
from app.models.gate_entry import GateEntry
from app.models.part import Part
from app.services.spare_flow_service import SpareFlowService


def _part(part_no):
    p = Part(part_no=part_no, part_name="Taper Pin", uom="PCS", part_type="OTHER")
    db.session.add(p)
    db.session.commit()
    return p


def _gate(part_no, ven_cd, ven_name, d, qty):
    db.session.add(GateEntry(
        store_code="MAINTENANCE", item_code=part_no, ven_cd=ven_cd, ven_name=ven_name,
        gate_entry_dt=d, qty=qty, gate_entry_no=f"GE-{ven_cd}-{d.isoformat()}",
    ))
    db.session.commit()


def test_gate_suppliers_lists_every_vendor_newest_first():
    p = _part("GSUP-0001")
    _gate("GSUP-0001", "VD-0002", "D.S TOOLS & MILL STORE", date(2026, 6, 16), 50)
    _gate("GSUP-0001", "VG-0001", "G R TRADERS", date(2026, 6, 19), 500)
    _gate("GSUP-0001", "VJ-0020", "JMD TRADERS", date(2026, 6, 19), 50)

    sup = SpareFlowService().traceability(p.id)["gate_suppliers"]

    # every distinct vendor surfaces — a part is not tied to one supplier
    assert {s["ven_cd"] for s in sup} == {"VD-0002", "VG-0001", "VJ-0020"}
    # newest arrival first, so the 16th (D.S Tools) sorts last
    assert sup[-1]["ven_cd"] == "VD-0002"
    assert all(s["arrivals"] == 1 for s in sup)


def test_gate_suppliers_aggregates_repeat_arrivals():
    p = _part("GSUP-0002")
    _gate("GSUP-0002", "VG-0005", "GROWTECH ENGINEERS", date(2026, 6, 15), 2)
    _gate("GSUP-0002", "VG-0005", "GROWTECH ENGINEERS", date(2026, 8, 31), 2)
    _gate("GSUP-0002", "VN-0005", "NEERAJ INDUSTRIES", date(2026, 6, 15), 6)

    sup = SpareFlowService().traceability(p.id)["gate_suppliers"]
    by = {s["ven_cd"]: s for s in sup}

    assert by["VG-0005"]["arrivals"] == 2
    assert by["VG-0005"]["total_qty"] == 4.0
    assert by["VG-0005"]["last_dt"] == "2026-08-31"
    assert by["VG-0005"]["first_dt"] == "2026-06-15"
    # Growtech's newer arrival (Aug 31) ranks it above Neeraj (Jun 15)
    assert sup[0]["ven_cd"] == "VG-0005"


def test_gate_suppliers_empty_when_no_gate_entry():
    p = _part("GSUP-0003")
    assert SpareFlowService().traceability(p.id)["gate_suppliers"] == []


def test_gate_suppliers_match_is_case_insensitive():
    p = _part("GSUP-0004")
    # ERP could push a lower/mixed-case item_code; it must still match the part
    _gate("gsup-0004", "VU-0001", "UNIQUE INDUSTRIAL CORPORATION", date(2026, 7, 1), 10)
    sup = SpareFlowService().traceability(p.id)["gate_suppliers"]
    assert [s["ven_cd"] for s in sup] == ["VU-0001"]
