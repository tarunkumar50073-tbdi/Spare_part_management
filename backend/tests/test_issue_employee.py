"""Issue by mobile number: the counter picks the taker from the Employee master
(name / code / department fill in), the ISSUE ledger and journal rows keep who
it was, and every issue list carries the person — while the timeline names
them without ever printing the full mobile number. Plus the Scan Part payload
additions that go with it: the part's barcodes (internal QR + mapped supplier
codes) and the label count its newest ERP GRN suggests."""
import json
from datetime import date, timedelta

import pytest

from app.extensions import db
from app.models.employee import Employee
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.spare_flow import SpareTransaction
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.models.supplier import Supplier
from app.models.user import User, UserStoreAccess
from app.services.assistant_service import AssistantService
from app.services.barcode_service import BarcodeService
from app.services.scan_result_service import ScanResultService
from app.services.service_catalog import SERVICES
from app.services.spare_stock_service import SpareStockService
from app.utils.exceptions import BadRequestError

_seq = {"n": 0}

PERSON_KEYS = ("employee_id", "issued_to_mobile", "issued_to_code")
BARCODE_KEYS = {"id", "code", "source", "symbology", "is_primary", "is_active", "supplier_id",
                "supplier_name", "created_at", "created_by"}


def _n():
    _seq["n"] += 1
    return _seq["n"]


def _part(qty=10, location="C3-01"):
    p = Part(part_no=f"IE-{_n():04d}", part_name="Limit Switch", uom="NO",
             part_type="OTHER", store_code="MAINTENANCE", location=location)
    db.session.add(p)
    db.session.commit()
    if qty is not None:
        SpareStockService().set_quantity(p.id, qty, txn_type="OPENING")
    return p


def _person(name="Ravi Kumar", code="auto", department="Tool Room", active=True):
    n = _n()
    emp = Employee(mobile=f"77{n:08d}", name=name,
                   employee_code=f"E-IE-{n}" if code == "auto" else code,
                   department=department, is_active=active)
    db.session.add(emp)
    db.session.commit()
    return emp


def _on_hand(part_id):
    row = SpareStock.query.filter_by(part_id=part_id).first()
    return float(row.qty_on_hand) if row else 0.0


def _issue_rows(part_id):
    return SpareStockLedger.query.filter_by(part_id=part_id, txn_type="ISSUE").all()


# ---- issue by employee -------------------------------------------------------------

def test_issue_by_employee_fills_the_name_and_keeps_code_and_mobile_on_both_rows():
    p = _part()
    emp = _person()
    res = SpareStockService().issue(p.id, 2, "Maintenance", employee_id=emp.id,
                                    issued_to_mobile=f"+91 {emp.mobile}", user="storekpr")

    # the name comes from the master; the department stays the operator's pick
    issue = res["issue"]
    assert issue["issued_to"] == "Ravi Kumar" and issue["department"] == "Maintenance"
    assert [issue[k] for k in PERSON_KEYS] == [emp.id, emp.mobile, emp.employee_code]
    assert res["qty_on_hand"] == 8.0

    led = db.session.get(SpareStockLedger, issue["id"])
    assert led.issued_to == "Ravi Kumar"
    assert (led.employee_id, led.issued_to_mobile, led.issued_to_code) == (
        emp.id, emp.mobile, emp.employee_code)
    j = SpareTransaction.query.filter_by(part_id=p.id, txn_type="ISSUE").one()
    assert j.ledger_id == led.id and j.issued_to == "Ravi Kumar"
    assert (j.employee_id, j.issued_to_mobile, j.issued_to_code) == (
        emp.id, emp.mobile, emp.employee_code)


def test_a_name_sent_with_the_person_is_kept():
    p = _part()
    emp = _person(name="Harkesh Singh")
    res = SpareStockService().issue(p.id, 1, "Tool Room", employee_id=emp.id, issued_to="Harkesh S.")
    assert res["issue"]["issued_to"] == "Harkesh S." and res["issue"]["employee_id"] == emp.id


def test_a_person_without_an_employee_code_is_stored_with_mobile_only():
    p = _part()
    emp = _person(name="Contract Fitter", code=None)
    issue = SpareStockService().issue(p.id, 1, "Maintenance", employee_id=emp.id)["issue"]
    assert (issue["issued_to_mobile"], issue["issued_to_code"]) == (emp.mobile, None)


def test_mobile_alone_finds_the_person():
    p = _part()
    emp = _person()
    issue = SpareStockService().issue(p.id, 1, "Maintenance", issued_to_mobile=f"0{emp.mobile}")["issue"]
    assert issue["employee_id"] == emp.id and issue["issued_to"] == emp.name


@pytest.mark.parametrize("case", ["inactive", "unknown_id", "unknown_mobile", "bad_mobile", "mismatch"])
def test_a_person_the_master_cannot_vouch_for_is_refused_and_nothing_moves(case):
    p = _part(qty=5)
    emp = _person(active=(case != "inactive"))
    kwargs = {
        "inactive": {"employee_id": emp.id},
        "unknown_id": {"employee_id": 99999999},
        "unknown_mobile": {"issued_to_mobile": "6000000001"},
        "bad_mobile": {"employee_id": emp.id, "issued_to_mobile": "12345"},
        "mismatch": {"employee_id": emp.id, "issued_to_mobile": "6000000002"},
    }[case]
    with pytest.raises(BadRequestError) as err:
        SpareStockService().issue(p.id, 2, "Maintenance", **kwargs)
    if case == "inactive":
        assert "inactive" in err.value.message
    assert _on_hand(p.id) == 5.0
    assert _issue_rows(p.id) == []
    assert SpareTransaction.query.filter_by(part_id=p.id, txn_type="ISSUE").count() == 0


def test_old_free_text_issue_still_works():
    p = _part()
    issue = SpareStockService().issue(p.id, 3, "Press Shop", issued_to="Asha")["issue"]
    assert issue["issued_to"] == "Asha"
    assert [issue[k] for k in PERSON_KEYS] == [None, None, None]
    j = SpareTransaction.query.filter_by(part_id=p.id, txn_type="ISSUE").one()
    assert (j.issued_to, j.employee_id, j.issued_to_mobile, j.issued_to_code) == ("Asha", None, None, None)
    # and with nobody named at all
    assert SpareStockService().issue(p.id, 1, "Press Shop")["issue"]["issued_to"] is None


# ---- every issue list carries the person ----------------------------------------------

def test_issue_lists_carry_mobile_and_code():
    svc = SpareStockService()
    p = _part()
    emp = _person()
    lid = svc.issue(p.id, 2, "Maintenance", employee_id=emp.id, returnable=True)["issue"]["id"]
    want = (emp.mobile, emp.employee_code)

    def pick(rows):
        row = next(r for r in rows if r["id"] == lid)
        return row["issued_to_mobile"], row["issued_to_code"]

    assert pick(svc.returnable_issues_for_part(p.id)) == want
    assert pick(svc.pending_confirmations("MAINTENANCE")) == want
    assert pick(svc.pending_confirmations_for_part(p.id)) == want
    assert pick(svc.history_for_part(p.id)) == want
    assert pick(svc.outstanding_returnables("MAINTENANCE")) == want

    scan = ScanResultService()
    assert pick(scan.build(p.id)["open_issues"]) == want


def test_timeline_names_the_person_and_code_but_never_the_mobile():
    p = _part()
    emp = _person(name="Ravi Kumar")
    SpareStockService().issue(p.id, 2, "Maintenance", employee_id=emp.id)
    # an older ISSUE row with no journal row behind it reads the same way
    db.session.add(SpareStockLedger(part_id=p.id, txn_type="ISSUE", qty_delta=-1, balance_after=7,
                                    department="Tool Room", issued_to="Ravi Kumar",
                                    employee_id=emp.id, issued_to_mobile=emp.mobile,
                                    issued_to_code=emp.employee_code))
    db.session.commit()

    scan = ScanResultService()
    rows = scan.timeline(p.id)["rows"]
    issues = [r for r in rows if r["kind"] == "ISSUE"]
    assert sorted(r["source"] for r in issues) == ["journal", "ledger"]
    assert all(r["detail"] == f"Handed to Ravi Kumar ({emp.employee_code})" for r in issues)
    assert emp.mobile not in json.dumps(rows)
    assert emp.mobile not in json.dumps(scan.build(p.id)["timeline"])
    # the Scan Part card may show it — the open issue carries it
    assert any(i["issued_to_mobile"] == emp.mobile for i in scan.build(p.id)["open_issues"])


def test_timeline_without_a_code_names_the_person_only():
    p = _part()
    SpareStockService().issue(p.id, 1, "Maintenance", issued_to="Asha")
    row = next(r for r in ScanResultService().timeline(p.id)["rows"] if r["kind"] == "ISSUE")
    assert row["detail"] == "Handed to Asha"


# ---- route --------------------------------------------------------------------------

def _client(app, perms):
    u = User(username=f"ieuser{_n()}", role="STORE_USER", is_active=True)
    u.set_password("pw")
    u.set_permissions(perms)
    db.session.add(u)
    db.session.flush()
    db.session.add(UserStoreAccess(user_id=u.id, store_code="MAINTENANCE"))
    db.session.commit()
    c = app.test_client()
    with c.session_transaction() as s:
        s["user_id"] = u.id
    return c


def test_issue_route_takes_the_person(app):
    client = _client(app, {"scan_part": {"view": True, "edit": True}})
    p = _part()
    emp = _person(name="Mohan Lal")
    r = client.post(f"/api/v1/spare-stock/parts/{p.id}/issue",
                    json={"qty": 1, "department": "Maintenance", "employee_id": emp.id,
                          "issued_to_mobile": emp.mobile})
    assert r.status_code == 200, r.get_json()
    body = r.get_json()
    assert body["data"]["issue"]["issued_to"] == "Mohan Lal"
    assert body["data"]["issue"]["issued_to_code"] == emp.employee_code
    assert "Mohan Lal" in body["message"]

    gone = _person(active=False)
    r = client.post(f"/api/v1/spare-stock/parts/{p.id}/issue",
                    json={"qty": 1, "department": "Maintenance", "employee_id": gone.id})
    assert r.status_code == 400
    # the old free-text body keeps working
    r = client.post(f"/api/v1/spare-stock/parts/{p.id}/issue",
                    json={"qty": 1, "department": "Maintenance", "issued_to": "Asha"})
    assert r.status_code == 200 and r.get_json()["data"]["issue"]["employee_id"] is None
    assert _on_hand(p.id) == 8.0


def test_scan_result_route_carries_barcodes_and_label_hint(app):
    client = _client(app, {"scan_part": {"view": True, "edit": True}})
    p = _part()
    data = client.get(f"/api/v1/spare-flow/parts/{p.id}/scan-result").get_json()["data"]
    assert {"barcodes", "label_qty_hint"} <= set(data)
    assert data["barcodes"][0]["source"] == "INTERNAL" and data["label_qty_hint"] is None


# ---- scan-result: barcodes -------------------------------------------------------------

def test_barcodes_list_internal_first_then_supplier_codes():
    p = _part(qty=None)
    scan = ScanResultService()

    # never printed: the internal code is still the Part No., not yet allocated
    only = scan.build(p.id)["barcodes"]
    assert len(only) == 1 and set(only[0]) == BARCODE_KEYS
    assert (only[0]["id"], only[0]["code"], only[0]["source"]) == (None, p.part_no, "INTERNAL")
    assert only[0]["is_primary"] and only[0]["is_active"] and only[0]["created_at"] is None

    n = _n()
    sup = Supplier(vendor_code=f"VIE{n}", supplier_name=f"Barcode Supplier {n}", status="Active")
    db.session.add(sup)
    db.session.commit()
    bc = BarcodeService()
    bc.map_supplier_barcode(p.id, f"SUP-{p.part_no}-A", supplier_id=sup.id, symbology="OTHER", user="sup")
    rows = bc.map_supplier_barcode(p.id, f"SUP-{p.part_no}-B", symbology="OTHER", user="sup")
    b_id = next(r["id"] for r in rows if r["code"].endswith("-B"))
    bc.set_mapping_active(b_id, False)
    bc.ensure_internal_barcode(p, user="store1")          # the first label print allocates it

    out = scan.build(p.id)["barcodes"]
    assert all(set(b) == BARCODE_KEYS for b in out)
    assert [b["source"] for b in out] == ["INTERNAL", "SUPPLIER", "SUPPLIER"]
    assert out[0]["code"] == p.part_no and out[0]["id"] is not None
    a, b = out[1], out[2]
    assert (a["code"], a["supplier_id"], a["supplier_name"], a["is_active"]) == (
        f"SUP-{p.part_no}-A", sup.id, sup.supplier_name, True)
    assert (b["code"], b["supplier_name"], b["is_active"]) == (f"SUP-{p.part_no}-B", None, False)


# ---- scan-result: label qty hint ---------------------------------------------------------

def _grn(part, receipt, accept=None, reject=None, days_ago=3):
    grn_no = f"GRN-IE-{_n():05d}"
    db.session.add(ReceivingRegister(store_code="MAINTENANCE", item_cd=part.part_no, grn_no=grn_no,
                                     grn_date=date.today() - timedelta(days=days_ago), ven_cd="VA-1",
                                     ven_name="ABC Engineering", receipt_qty=receipt,
                                     accept_qty=accept, reject_qty=reject))
    db.session.commit()
    return grn_no


def test_label_qty_hint_follows_the_newest_erp_grn():
    p = _part()
    scan = ScanResultService()
    assert scan.build(p.id)["label_qty_hint"] is None                  # no GRN in ERP

    pending = _grn(p, 4, days_ago=6)                                    # quality pending
    assert scan.build(p.id)["label_qty_hint"] == {
        "grn_no": pending, "grn_date": (date.today() - timedelta(days=6)).isoformat(),
        "qty": 4.0, "basis": "received"}

    accepted = _grn(p, 6, accept=5, reject=1, days_ago=3)               # newer, quality accepted
    hint = scan.build(p.id)["label_qty_hint"]
    assert (hint["grn_no"], hint["qty"], hint["basis"]) == (accepted, 5.0, "accepted")

    _grn(p, 2, reject=2, days_ago=1)                                    # newest, rejected outright
    hint = scan.build(p.id)["label_qty_hint"]
    assert (hint["grn_no"], hint["qty"], hint["basis"]) == (accepted, 5.0, "accepted")


# ---- service catalogue -------------------------------------------------------------------

def test_scan_part_replaces_the_supplier_barcodes_screen():
    routes = {s["route"] for s in SERVICES}
    assert "/supplier-barcodes" not in routes
    assert not any(s["key"] == "supplier_barcodes" for s in SERVICES)
    scan_part = next(s for s in SERVICES if s["key"] == "scan_part")
    assert {"supplier barcode", "mapping", "label"} <= set(scan_part["keywords"])

    class _Admin:
        is_admin = True

        @staticmethod
        def can(_mod):
            return True

    picks = AssistantService._suggest("supplier barcode", _Admin())
    assert picks[0]["route"] == "/scan-part"
