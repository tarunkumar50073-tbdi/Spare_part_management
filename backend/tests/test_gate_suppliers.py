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

    trace = SpareFlowService().traceability(p.id)
    sup = trace["gate_suppliers"]

    # every distinct vendor surfaces — a part is not tied to one supplier
    assert {s["ven_cd"] for s in sup} == {"VD-0002", "VG-0001", "VJ-0020"}
    # newest arrival first, so the 16th (D.S Tools) sorts last
    assert sup[-1]["ven_cd"] == "VD-0002"
    assert all(s["arrivals"] == 1 for s in sup)

    # the arrival log: every gate entry, when + from whom, newest first
    arr = trace["gate_arrivals"]
    assert len(arr) == 3
    assert arr[-1]["ven_cd"] == "VD-0002"          # 16 Jun sorts last
    assert arr[-1]["gate_entry_dt"] == "2026-06-16"
    assert arr[-1]["qty"] == 50.0


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


def test_gate_history_empty_when_no_gate_entry():
    p = _part("GSUP-0003")
    trace = SpareFlowService().traceability(p.id)
    assert trace["gate_suppliers"] == []
    assert trace["gate_arrivals"] == []


def test_gate_suppliers_match_is_case_insensitive():
    p = _part("GSUP-0004")
    # ERP could push a lower/mixed-case item_code; it must still match the part
    _gate("gsup-0004", "VU-0001", "UNIQUE INDUSTRIAL CORPORATION", date(2026, 7, 1), 10)
    sup = SpareFlowService().traceability(p.id)["gate_suppliers"]
    assert [s["ven_cd"] for s in sup] == ["VU-0001"]


def test_part_ledger_merges_arrivals_opening_and_issue():
    """The unified ledger is the part's whole life on one timeline: it arrived
    from a supplier (gate), was counted in (opening), and was issued to a
    department / person / machine — each event shown with its own details."""
    from app.models.spare_stock import SpareStockLedger
    p = _part("GSUP-0005")
    _gate("GSUP-0005", "VG-0005", "GROWTECH ENGINEERS", date(2026, 5, 1), 20)
    db.session.add(SpareStockLedger(part_id=p.id, txn_type="OPENING", qty_delta=20, balance_after=20))
    db.session.add(SpareStockLedger(part_id=p.id, txn_type="ISSUE", qty_delta=-3, balance_after=17,
                                    department="Press Shop", issued_to="ANKIT", machine="OP-30 Press"))
    db.session.commit()

    led = SpareFlowService().traceability(p.id)["ledger"]
    kinds = {e["kind"] for e in led}
    assert {"GATE_ARRIVAL", "OPENING", "ISSUE"} <= kinds

    issue = next(e for e in led if e["kind"] == "ISSUE")
    assert issue["direction"] == "out"
    assert issue["qty"] == -3.0
    assert issue["department"] == "Press Shop"
    assert issue["issued_to"] == "ANKIT"
    assert issue["machine"] == "OP-30 Press"

    arrival = next(e for e in led if e["kind"] == "GATE_ARRIVAL")
    assert arrival["direction"] == "in"
    assert arrival["supplier_name"] == "GROWTECH ENGINEERS"

    opening = next(e for e in led if e["kind"] == "OPENING")
    assert opening["direction"] == "count"


def test_ledger_grn_received_and_gate_becomes_arrival():
    """GRN and gate entry are the same receipt at two stages. Where a GRN exists
    it is the counted "Received" (accept qty, with reject noted) and the gate row
    is demoted to a non-counted "Arrival", so the received total is not doubled."""
    from app.models.receiving_register import ReceivingRegister
    p = _part("GSUP-0006")
    _gate("GSUP-0006", "VD-0002", "D.S TOOLS & MILL STORE", date(2026, 6, 16), 50)
    db.session.add(ReceivingRegister(
        store_code="MAINTENANCE", item_cd="GSUP-0006", grn_no="IN-TEST-1",
        grn_date=date(2026, 6, 16), ven_cd="VD-0002", ven_name="D.S TOOLS & MILL STORE",
        receipt_qty=50, accept_qty=48, reject_qty=2))
    db.session.commit()

    led = SpareFlowService().traceability(p.id)["ledger"]
    grn = next(e for e in led if e["kind"] == "RECEIVED")
    assert grn["direction"] == "in"
    assert grn["qty"] == 48.0
    assert grn["reference"] == "IN-TEST-1"
    assert "reject" in (grn["remarks"] or "").lower()
    arr = next(e for e in led if e["kind"] == "GATE_ARRIVAL")
    assert arr["direction"] == "arrival"          # demoted — GRN carries the count


def test_ledger_gate_counts_when_no_grn():
    p = _part("GSUP-0007")
    _gate("GSUP-0007", "VG-0005", "GROWTECH ENGINEERS", date(2026, 7, 1), 5)
    arr = next(e for e in SpareFlowService().traceability(p.id)["ledger"] if e["kind"] == "GATE_ARRIVAL")
    assert arr["direction"] == "in"               # no GRN, so the gate arrival is the inflow
