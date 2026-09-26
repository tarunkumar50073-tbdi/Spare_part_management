"""Spare receiving flow (spec 1 / 9): receive -> record the ERP GRN -> quality
clearance -> available stock, and the /api/v1/spare-flow/receipts routes.

The rules under test: a receive adds NO stock (the material is quality
pending); only the clearance adds the ACCEPTED quantity, as one RECEIPT ledger
row; a rejected quantity never reaches stock; every step writes its journal row
with previous / new status; a vendor code is never typed free; a receipt can be
cancelled only before its GRN.

ERP mirror rows seeded here are removed again afterwards — the gate / GRN
mirrors are plant-wide and other tests read them.
"""
from datetime import date, timedelta

import pytest
from sqlalchemy import func

from app.extensions import db
from app.models.department import Department
from app.models.gate_entry import GateEntry
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.spare_flow import RECEIPT_OPEN, SpareReceipt, SpareTransaction
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.models.store import Store
from app.models.supplier import Supplier
from app.models.user import User, UserStoreAccess
from app.services.erp_control_service import ERPControlService
from app.services.spare_receipt_service import ERP_VENDOR_ONLY, SpareReceiptService
from app.services.spare_stock_service import SpareStockService
from app.utils.exceptions import BadRequestError, NotFoundError

STORE = "MAINTENANCE"
URL = "/api/v1/spare-flow/receipts"
_seq = {"n": 0}


def _next():
    _seq["n"] += 1
    return _seq["n"]


def _part(store=STORE, active=True):
    n = _next()
    p = Part(part_no=f"SRC-{n}", part_name=f"Receipt Part {n}", uom="NO", part_type="OTHER",
             store_code=store, is_active=active, location="R1-S1-B1")
    db.session.add(p)
    db.session.commit()
    return p


def _opening(part, qty):
    SpareStockService().set_quantity(part.id, float(qty), txn_type="OPENING")


def _on_hand(part):
    row = SpareStock.query.filter_by(part_id=part.id).first()
    return float(row.qty_on_hand) if row else None


def _quality_pending(part):
    """The contract's quality_pending bucket, straight from the documents."""
    total = (db.session.query(func.coalesce(func.sum(SpareReceipt.qty_received), 0))
             .filter(SpareReceipt.part_id == part.id, SpareReceipt.status.in_(RECEIPT_OPEN))
             .scalar())
    return float(total)


def _receipt_rows(part):
    return SpareStockLedger.query.filter_by(part_id=part.id, txn_type="RECEIPT").all()


def _journal(receipt_id):
    return (SpareTransaction.query.filter_by(receipt_id=receipt_id)
            .order_by(SpareTransaction.id.asc()).all())


@pytest.fixture()
def svc():
    return SpareReceiptService()


@pytest.fixture()
def erp_rows():
    """Add ERP gate / GRN mirror rows for a test; removed afterwards."""
    made = []

    def gate(part_no, ven_cd, ven_name="Gate Vendor", days_ago=3):
        g = GateEntry(store_code="CHILD_PART", gate_entry_no=f"GE-SRC-{_next()}",
                      gate_entry_dt=date.today() - timedelta(days=days_ago), item_code=part_no,
                      qty=1, ven_cd=ven_cd, ven_name=ven_name)
        db.session.add(g)
        db.session.commit()
        made.append(g)
        return g

    def grn(part_no, ven_cd, ven_name="GRN Vendor", days_ago=2):
        r = ReceivingRegister(store_code="CHILD_PART", grn_no=f"GRN-SRC-{_next()}",
                              grn_date=date.today() - timedelta(days=days_ago), item_cd=part_no,
                              ven_cd=ven_cd, ven_name=ven_name, receipt_qty=1, accept_qty=1)
        db.session.add(r)
        db.session.commit()
        made.append(r)
        return r

    yield gate, grn
    for row in made:
        db.session.delete(row)
    db.session.commit()


# ------------------------------------------------------------------ receive

def test_receive_adds_no_stock_and_is_quality_pending(svc):
    p = _part()
    _opening(p, 5)
    rows_before = SpareStockLedger.query.filter_by(part_id=p.id).count()

    r = svc.receive(p.id, 3, user="storeman", invoice_no="INV-7", check_result="ok",
                    scanned_code="ABC-78452", scan_source="SUPPLIER_BARCODE")

    assert r["status"] == "RECEIVED" and r["receipt_no"].startswith("RCV-")
    assert (r["part_no"], r["part_name"], r["qty_received"]) == (p.part_no, p.part_name, 3.0)
    assert (r["check_result"], r["invoice_no"], r["received_by"]) == ("OK", "INV-7", "storeman")
    assert r["age_days"] == 0 and r["ledger_id"] is None
    # Available stock does not move and no ledger row is written.
    assert _on_hand(p) == 5.0
    assert SpareStockLedger.query.filter_by(part_id=p.id).count() == rows_before
    assert _quality_pending(p) == 3.0


def test_receive_validates_part_qty_and_check(svc):
    p = _part()
    with pytest.raises(BadRequestError):
        svc.receive(p.id, 0, user="u")
    with pytest.raises(BadRequestError):
        svc.receive(p.id, -1, user="u")
    with pytest.raises(BadRequestError):
        svc.receive(p.id, 1, user="u", check_result="BROKEN")
    with pytest.raises(BadRequestError):
        svc.receive(_part(active=False).id, 1, user="u")
    with pytest.raises(NotFoundError):
        svc.receive(999999, 1, user="u")
    assert SpareReceipt.query.filter_by(part_id=p.id).count() == 0


def test_receipt_numbers_are_sequential(svc):
    p = _part()
    a = svc.receive(p.id, 1, user="u")["receipt_no"]
    b = svc.receive(p.id, 1, user="u")["receipt_no"]
    assert a[:13] == b[:13]                                   # RCV-YYYYMMDD-
    assert int(b.rsplit("-", 1)[1]) == int(a.rsplit("-", 1)[1]) + 1


# ---------------------------------------------------------- GRN + quality

def test_grn_then_quality_moves_accepted_into_available(svc):
    p = _part()
    _opening(p, 2)
    sup = Supplier(vendor_code=f"SRCV{_next()}", supplier_name="Master Supplier", status="Active")
    db.session.add(sup)
    db.session.commit()
    r = svc.receive(p.id, 5, user="storeman", supplier_id=sup.id, invoice_no="INV-9",
                    invoice_date="2026-09-20", check_result="SHORT")

    g = svc.record_grn(r["id"], " GRN-5501 ", grn_date="2026-09-25", quality_by="tool room",
                       user="supervisor")
    assert g["status"] == "QUALITY_PENDING" and g["grn_no"] == "GRN-5501"
    assert g["quality_by"] == "Tool Room"                        # the master's spelling
    assert (g["grn_date"], g["grn_recorded_by"]) == ("2026-09-25", "supervisor")
    assert _on_hand(p) == 2.0 and _quality_pending(p) == 5.0     # still not stock

    q = svc.quality_clear(r["id"], 4, 1, remarks="one bent", user="qc1")
    assert q["status"] == "STOCK_AVAILABLE"
    assert (q["qty_accepted"], q["qty_rejected"], q["cleared_by"]) == (4.0, 1.0, "qc1")
    assert _on_hand(p) == 6.0                                    # 2 + accepted 4
    assert _quality_pending(p) == 0.0

    rows = _receipt_rows(p)
    assert len(rows) == 1
    row = rows[0]
    assert (float(row.qty_delta), float(row.balance_after)) == (4.0, 6.0)
    assert (row.status, row.reference, row.created_by) == ("STOCK_AVAILABLE", "GRN-5501", "qc1")
    assert (row.supplier_id, row.invoice_no, row.check_result) == (sup.id, "INV-9", "SHORT")
    assert row.invoice_date == date(2026, 9, 20)
    assert q["ledger_id"] == row.id


def test_rejected_quantity_never_reaches_stock(svc):
    p = _part()
    _opening(p, 1)
    r = svc.receive(p.id, 3, user="u")
    svc.record_grn(r["id"], "GRN-REJ", quality_by="Maintenance", user="sup")
    q = svc.quality_clear(r["id"], 0, 3, remarks="wrong grade", user="qc")
    assert q["status"] == "REJECTED" and q["ledger_id"] is None
    assert _on_hand(p) == 1.0 and _receipt_rows(p) == []
    assert _quality_pending(p) == 0.0
    last = _journal(r["id"])[-1]
    assert (last.txn_type, last.to_bucket, last.inspection_result, float(last.qty)) == (
        "QUALITY_CLEARANCE", "REJECTED", "REJECTED", 3.0)


def test_quality_split_must_add_up(svc):
    p = _part()
    r = svc.receive(p.id, 5, user="u")
    svc.record_grn(r["id"], "GRN-SUM", quality_by="Maintenance", user="sup")
    for accepted, rejected in ((4, 0), (3, 3), (6, -1), (-1, 6)):
        with pytest.raises(BadRequestError):
            svc.quality_clear(r["id"], accepted, rejected, user="qc")
    assert svc.get(r["id"]).status == "QUALITY_PENDING" and _receipt_rows(p) == []


def test_grn_needs_number_and_a_known_department(svc):
    p = _part()
    r = svc.receive(p.id, 1, user="u")
    with pytest.raises(BadRequestError):
        svc.record_grn(r["id"], "  ", quality_by="Maintenance")
    with pytest.raises(BadRequestError):
        svc.record_grn(r["id"], "GRN-1", quality_by="Nowhere Dept")
    with pytest.raises(BadRequestError):
        svc.record_grn(r["id"], "GRN-1", quality_by=None)
    assert svc.get(r["id"]).status == "RECEIVED"


def test_only_maintenance_or_tool_room_inspect_quality(svc):
    """An active department that is not a quality inspector (Press Shop is in
    the seeded master) never takes spare material for quality."""
    p = _part()
    r = svc.receive(p.id, 1, user="u")
    assert Department.query.filter_by(name="Press Shop", is_active=True).first() is not None
    with pytest.raises(BadRequestError, match="Maintenance or Tool Room"):
        svc.record_grn(r["id"], "GRN-PS", quality_by="Press Shop")
    assert svc.get(r["id"]).status == "RECEIVED" and _journal(r["id"])[-1].txn_type == "RECEIVE"


def test_a_deactivated_quality_department_is_refused(svc):
    """Tool Room is a quality inspector only while the master has it active."""
    tool_room = Department.query.filter_by(name="Tool Room").first()
    tool_room.is_active = False
    db.session.commit()
    try:
        r = svc.receive(_part().id, 1, user="u")
        with pytest.raises(BadRequestError, match="not an active department"):
            svc.record_grn(r["id"], "GRN-TR", quality_by="Tool Room")
        assert svc.record_grn(r["id"], "GRN-MT", quality_by="maintenance")["quality_by"] == "Maintenance"
    finally:
        tool_room.is_active = True
        db.session.commit()


def test_wrong_state_transitions_are_refused(svc):
    p = _part()
    r = svc.receive(p.id, 2, user="u")
    with pytest.raises(BadRequestError):                     # quality before the GRN
        svc.quality_clear(r["id"], 2, 0)
    svc.record_grn(r["id"], "GRN-ST", quality_by="Maintenance")
    with pytest.raises(BadRequestError):                     # GRN twice
        svc.record_grn(r["id"], "GRN-ST2", quality_by="Maintenance")
    svc.quality_clear(r["id"], 2, 0)
    with pytest.raises(BadRequestError):                     # cleared twice: stock added once
        svc.quality_clear(r["id"], 2, 0)
    assert _on_hand(p) == 2.0 and len(_receipt_rows(p)) == 1
    with pytest.raises(BadRequestError):
        svc.cancel(r["id"], "too late")
    with pytest.raises(NotFoundError):
        svc.record_grn(999999, "GRN-X", quality_by="Maintenance")


def test_a_stale_screen_cannot_move_a_receipt_twice(svc):
    """The status move is a compare-and-set: a receipt changed elsewhere since
    this session loaded it is refused, not overwritten."""
    p = _part()
    r = svc.receive(p.id, 1, user="u")
    receipt = svc.get(r["id"])
    assert receipt.status == "RECEIVED"
    # Another terminal cancels it; this session's copy still says RECEIVED.
    SpareReceipt.query.filter_by(id=r["id"]).update({"status": "CANCELLED"}, synchronize_session=False)
    with pytest.raises(BadRequestError, match="another screen"):
        svc.record_grn(r["id"], "GRN-RACE", quality_by="Maintenance")
    # The refused transaction rolled back; nothing was recorded.
    db.session.expire_all()
    assert svc.get(r["id"]).grn_no is None
    assert [t.txn_type for t in _journal(r["id"])] == ["RECEIVE"]


# ------------------------------------------------------------------ cancel

def test_cancel_only_before_grn_and_needs_a_reason(svc):
    p = _part()
    r = svc.receive(p.id, 4, user="u")
    with pytest.raises(BadRequestError):
        svc.cancel(r["id"], "   ")
    c = svc.cancel(r["id"], "Keyed against the wrong part", user="sup")
    assert (c["status"], c["cancel_reason"], c["cancelled_by"]) == (
        "CANCELLED", "Keyed against the wrong part", "sup")
    assert _quality_pending(p) == 0.0
    with pytest.raises(BadRequestError):                     # nothing to GRN any more
        svc.record_grn(r["id"], "GRN-C", quality_by="Maintenance")
    last = _journal(r["id"])[-1]
    assert (last.txn_type, last.prev_status, last.new_status, last.to_bucket, last.remarks) == (
        "CANCEL", "RECEIVED", "CANCELLED", "CANCELLED", "Keyed against the wrong part")

    after_grn = svc.receive(p.id, 1, user="u")
    svc.record_grn(after_grn["id"], "GRN-C2", quality_by="Maintenance")
    with pytest.raises(BadRequestError, match="GRN-C2"):
        svc.cancel(after_grn["id"], "changed my mind")


# ------------------------------------------------------------------ journal

def test_journal_rows_carry_previous_and_new_status(svc):
    p = _part()
    r = svc.receive(p.id, 5, user="storeman", ven_name="Local Trader", invoice_no="INV-J",
                    scanned_code="SUP-QR-1", scan_source="SUPPLIER_BARCODE", remarks="2 boxes")
    svc.record_grn(r["id"], "GRN-J1", quality_by="Maintenance", remarks="GRN made", user="sup")
    q = svc.quality_clear(r["id"], 4, 1, remarks="1 dented", user="qc")

    rows = _journal(r["id"])
    assert [(t.txn_type, t.prev_status, t.new_status, t.from_bucket, t.to_bucket, float(t.qty))
            for t in rows] == [
        ("RECEIVE", None, "RECEIVED", "SUPPLIER", "QUALITY_PENDING", 5.0),
        ("GRN", "RECEIVED", "QUALITY_PENDING", None, None, 5.0),
        ("QUALITY_CLEARANCE", "QUALITY_PENDING", "STOCK_AVAILABLE", "QUALITY_PENDING", "AVAILABLE", 4.0),
        ("QUALITY_CLEARANCE", "QUALITY_PENDING", "REJECTED", "QUALITY_PENDING", "REJECTED", 1.0),
    ]
    rec, grn, ok, rej = rows
    assert (rec.created_by, rec.supplier_name, rec.invoice_no, rec.scanned_code, rec.scan_source) == (
        "storeman", "Local Trader", "INV-J", "SUP-QR-1", "SUPPLIER_BARCODE")
    assert (grn.grn_no, grn.department, grn.remarks, grn.created_by) == (
        "GRN-J1", "Maintenance", "GRN made", "sup")
    assert ok.ledger_id == q["ledger_id"] and ok.grn_no == "GRN-J1" and ok.inspection_result is None
    assert rej.ledger_id is None and rej.inspection_result == "REJECTED"
    assert all(t.part_id == p.id and t.store_code == STORE for t in rows)


# ---------------------------------------------------------------- supplier

def test_typed_vendor_code_is_rejected(svc, erp_rows):
    p = _part()
    with pytest.raises(BadRequestError, match=ERP_VENDOR_ONLY):
        svc.receive(p.id, 1, user="u", ven_cd="TYPED-01", ven_name="Made Up Ltd")
    # A vendor ERP knows — but for a different part — is not this part's vendor.
    other = _part()
    gate, _ = erp_rows
    gate(other.part_no, "VG-OTHER")
    with pytest.raises(BadRequestError, match=ERP_VENDOR_ONLY):
        svc.receive(p.id, 1, user="u", ven_cd="VG-OTHER")
    assert SpareReceipt.query.filter_by(part_id=p.id).count() == 0


def test_vendor_code_from_erp_is_accepted_with_its_source(svc, erp_rows):
    p = _part()
    gate, grn = erp_rows
    gate(p.part_no.lower(), " VG-77 ", ven_name="ABC Engineering")
    grn(p.part_no, "VR-88", ven_name="XYZ Traders")

    a = svc.receive(p.id, 1, user="u", ven_cd="vg-77", supplier_source="ERP_GRN")
    # Found at the gate only: the source recorded is where it really was found.
    assert (a["ven_cd"], a["ven_name"], a["supplier_source"]) == ("VG-77", "ABC Engineering", "GATE_ENTRY")
    b = svc.receive(p.id, 1, user="u", ven_cd="VR-88", supplier_source="ERP_GRN")
    assert (b["ven_cd"], b["ven_name"], b["supplier_source"]) == ("VR-88", "XYZ Traders", "ERP_GRN")


def test_name_only_and_supplier_master(svc, erp_rows):
    p = _part()
    n = svc.receive(p.id, 1, user="u", ven_name="Walk-in Seller", supplier_source="GATE_ENTRY")
    # Not in ERP under that name, so it is not claimed as an ERP supplier.
    assert (n["ven_cd"], n["ven_name"], n["supplier_source"]) == (None, "Walk-in Seller", "NAME_ONLY")
    gate, _ = erp_rows
    gate(p.part_no, None, ven_name="Gate Name Only Co")
    g = svc.receive(p.id, 1, user="u", ven_name="gate name only co", supplier_source="GATE_ENTRY")
    assert (g["ven_cd"], g["supplier_source"]) == (None, "GATE_ENTRY")

    with pytest.raises(BadRequestError):
        svc.receive(p.id, 1, user="u", supplier_id=999999)
    sup = Supplier(vendor_code=f"SRCM{_next()}", supplier_name="Master Co", status="Active")
    db.session.add(sup)
    db.session.commit()
    m = svc.receive(p.id, 1, user="u", supplier_id=sup.id)
    assert (m["supplier_id"], m["ven_cd"], m["ven_name"], m["supplier_source"]) == (
        sup.id, None, "Master Co", "SUPPLIER_MASTER")
    none = svc.receive(p.id, 1, user="u")
    assert (none["ven_name"], none["supplier_source"]) == (None, None)


# --------------------------------------------------------------- ERP queue

def test_quality_cleared_receipt_is_not_queued_for_erp(svc):
    code = f"SRCERP-{_next()}"
    db.session.add(Store(code=code, name=f"Receipt ERP Test {code}", is_active=False))
    db.session.commit()
    p = _part(store=code)
    r = svc.receive(p.id, 3, user="u")
    svc.record_grn(r["id"], "GRN-E1", quality_by="Maintenance")
    svc.quality_clear(r["id"], 3, 0)
    SpareStockService().issue(p.id, 1, "Maintenance")

    wb = ERPControlService().status(code)["write_back"]
    # Only the issue waits for ERP; the cleared receipt came in through ERP's GRN.
    assert wb["pending"] == 1 and [x["txn_type"] for x in wb["rows"]] == ["ISSUE"]
    assert wb["erp_origin_receipts"] == 1
    dx = next(s for s in ERPControlService().status(code)["data_sources"] if s["key"] == "dx")
    assert (dx["movement_rows"], dx["erp_origin_rows"]) == (1, 1)


# ------------------------------------------------------------------ routes

@pytest.fixture()
def client(app):
    return app.test_client()


def _login(client, perms=None, stores=(STORE,), role="STORE_USER"):
    u = User(username=f"rcptuser{_next()}", role=role, is_active=True)
    u.set_password("pw")
    u.set_permissions(perms or {})
    db.session.add(u)
    db.session.flush()
    for code in stores:
        db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
    db.session.commit()
    with client.session_transaction() as s:
        s["user_id"] = u.id
    return client


EDIT = {"scan_part": {"view": True, "edit": True}}


def test_route_flow_end_to_end(client):
    c = _login(client, EDIT)
    p = _part()
    _opening(p, 1)
    r = c.post(URL, json={"part_id": p.id, "qty": 2, "invoice_no": "INV-R", "check_result": "",
                          "invoice_date": "", "ven_cd": "", "scan_source": "ERP_SEARCH"})
    assert r.status_code == 201, r.get_json()
    body = r.get_json()
    rid = body["data"]["id"]
    assert body["data"]["status"] == "RECEIVED" and body["message"].startswith("Received 2")
    assert "ERP updated" not in body["message"]
    assert _on_hand(p) == 1.0

    g = c.post(f"{URL}/{rid}/grn", json={"grn_no": "GRN-R1", "quality_by": "Maintenance"})
    assert g.status_code == 201 and g.get_json()["data"]["status"] == "QUALITY_PENDING"
    assert "recorded" in g.get_json()["message"]

    q = c.post(f"{URL}/{rid}/quality", json={"accepted_qty": 2, "rejected_qty": 0})
    assert q.status_code == 201
    assert q.get_json()["message"] == "Quality cleared · 2 added to store stock"
    assert _on_hand(p) == 3.0

    listed = c.get(f"{URL}?store_code={STORE}&status=STOCK_AVAILABLE").get_json()["data"]
    assert rid in [x["id"] for x in listed]
    assert rid not in [x["id"] for x in c.get(f"{URL}?store_code={STORE}&status=OPEN").get_json()["data"]]


def test_route_validation_and_errors(client):
    c = _login(client, EDIT)
    p = _part()
    assert c.post(URL, json={"part_id": p.id}).status_code == 422                     # no qty
    assert c.post(URL, json={"part_id": p.id, "qty": 0}).status_code == 422
    assert c.post(URL, json={"part_id": p.id, "qty": 1, "ven_cd": "NOPE-1"}).status_code == 400
    assert c.post(f"{URL}/999999/grn", json={"grn_no": "G", "quality_by": "Maintenance"}).status_code == 404
    rid = c.post(URL, json={"part_id": p.id, "qty": 1}).get_json()["data"]["id"]
    assert c.post(f"{URL}/{rid}/quality", json={"accepted_qty": 1}).status_code == 400   # before GRN
    press = c.post(f"{URL}/{rid}/grn", json={"grn_no": "G", "quality_by": "Press Shop"})
    assert press.status_code == 400 and "Maintenance or Tool Room" in press.get_json()["message"]
    assert c.post(f"{URL}/{rid}/cancel", json={}).status_code == 422                    # reason required
    cancelled = c.post(f"{URL}/{rid}/cancel", json={"reason": "duplicate"})
    assert cancelled.status_code == 201 and cancelled.get_json()["data"]["status"] == "CANCELLED"
    assert c.get(URL).status_code == 400                                                # store_code required
    assert c.get(f"{URL}?store_code={STORE}&status=BOGUS").status_code == 400


def test_route_refuses_a_non_spare_part(client):
    c = _login(client, role="ADMIN")
    child = _part(store="CHILD_PART")
    r = c.post(URL, json={"part_id": child.id, "qty": 1})
    assert r.status_code == 400 and "Spare Parts Store" in r.get_json()["message"]


def test_route_needs_scan_part_edit(client):
    p = _part()
    rid = SpareReceiptService().receive(p.id, 1, user="seed")["id"]
    c = _login(client, {"scan_part": {"view": True, "edit": False}})
    assert c.post(URL, json={"part_id": p.id, "qty": 1}).status_code == 403
    assert c.post(f"{URL}/{rid}/grn", json={"grn_no": "G", "quality_by": "Maintenance"}).status_code == 403
    assert c.post(f"{URL}/{rid}/quality", json={"accepted_qty": 1}).status_code == 403
    assert c.post(f"{URL}/{rid}/cancel", json={"reason": "x"}).status_code == 403
    # Reading needs the store only.
    assert c.get(f"{URL}?store_code={STORE}").status_code == 200
    assert SpareReceiptService().get(rid).status == "RECEIVED"


def test_route_refuses_a_foreign_store_user(client):
    p = _part()
    rid = SpareReceiptService().receive(p.id, 1, user="seed")["id"]
    c = _login(client, EDIT, stores=("CHILD_PART",))
    assert c.post(URL, json={"part_id": p.id, "qty": 1}).status_code == 403
    assert c.post(f"{URL}/{rid}/cancel", json={"reason": "x"}).status_code == 403
    assert c.get(f"{URL}?store_code={STORE}").status_code == 403
