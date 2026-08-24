"""Regression tests for the adversarial-review findings (barcode module)."""
import io

import pytest
from openpyxl import Workbook

from app.extensions import db
from app.models.part import Part
from app.models.part_barcode import PartBarcode
from app.models.spare_stock import SpareStockLedger
from app.models.user import User, UserStoreAccess
from app.services.barcode_service import BarcodeService
from app.services.spare_stock_service import SpareStockService
from app.utils.exceptions import BadRequestError, ConflictError

_seq = {"n": 0}


def _part(store="MAINTENANCE"):
    _seq["n"] += 1
    p = Part(part_no=f"BF-{_seq['n']}", part_name=f"BF {_seq['n']}", uom="NO",
             part_type="OTHER", store_code=store)
    db.session.add(p)
    db.session.commit()
    return p


@pytest.fixture()
def client(app):
    return app.test_client()


def _login(client, uid):
    with client.session_transaction() as s:
        s["user_id"] = uid


def _store_user(stores=("MAINTENANCE",)):
    _seq["n"] += 1
    u = User(username=f"bfu{_seq['n']}", role="STORE_USER", is_active=True)
    u.set_password("pw")
    db.session.add(u)
    db.session.flush()
    for c in stores:
        db.session.add(UserStoreAccess(user_id=u.id, store_code=c))
    db.session.commit()
    return u


def _xlsx(part_no, qty):
    wb = Workbook()
    ws = wb.active
    ws.append(["Part No", "Qty On Hand"])
    ws.append([part_no, qty])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


# #1 — a returned returnable issue is closed out (status RETURNED), off the
# confirmation queue, and can no longer be confirmed as installed.
def test_returned_issue_is_closed_and_not_confirmable():
    svc = SpareStockService()
    p = _part()
    svc.set_quantity(p.id, 10, txn_type="OPENING")
    svc.issue(p.id, 2, "Tool Room", returnable=True)
    lid = SpareStockLedger.query.filter_by(part_id=p.id, txn_type="ISSUE").first().id
    svc.return_item(lid)
    assert SpareStockLedger.query.get(lid).status == "RETURNED"
    assert not any(r["id"] == lid for r in svc.pending_confirmations("MAINTENANCE"))
    with pytest.raises(BadRequestError):
        svc.confirm_installation(lid, machine="MC-1")


# Case-insensitive resolve — a part number typed in lower case still resolves.
def test_resolve_is_case_insensitive():
    bc = BarcodeService()
    p = _part()
    payload = bc.resolve("MAINTENANCE", p.part_no.lower(), scan_source="MANUAL_ENTRY", scan_mode="LOOKUP")
    assert payload["part_no"] == p.part_no
    # trailing/leading spaces are tolerated too
    assert bc.resolve("MAINTENANCE", f"  {p.part_no.lower()}  ")["part_no"] == p.part_no


# #5 — a supplier code equal to ANOTHER part's internal Part No is rejected.
def test_supplier_mapping_cannot_hijack_another_part_no():
    bc = BarcodeService()
    a = _part()
    b = _part()
    with pytest.raises(ConflictError):
        bc.map_supplier_barcode(a.id, b.part_no)


# #2 — re-mapping a deactivated supplier code for the same part reactivates it.
def test_remapping_deactivated_supplier_code_reactivates():
    bc = BarcodeService()
    p = _part()
    bc.map_supplier_barcode(p.id, "VND-XYZ-1")
    m = PartBarcode.query.filter_by(code="VND-XYZ-1").first()
    bc.set_mapping_active(m.id, False)
    assert PartBarcode.query.filter_by(code="VND-XYZ-1").first().is_active is False
    bc.map_supplier_barcode(p.id, "VND-XYZ-1")  # re-map the same code
    assert PartBarcode.query.filter_by(code="VND-XYZ-1").first().is_active is True


# #3 — spare opening-stock import is store-access enforced (no cross-store IDOR).
def test_spare_import_denies_other_store(client):
    u = _store_user(stores=("CHILD_PART",))   # NOT MAINTENANCE
    _login(client, u.id)
    p = _part("MAINTENANCE")
    resp = client.post("/api/v1/spare-stock/import",
                       data={"file": (_xlsx(p.part_no, 99), "x.xlsx"), "store_code": "MAINTENANCE"},
                       content_type="multipart/form-data")
    assert resp.status_code == 403


def test_spare_import_requires_store_code(client):
    u = _store_user()
    _login(client, u.id)
    p = _part("MAINTENANCE")
    resp = client.post("/api/v1/spare-stock/import",
                       data={"file": (_xlsx(p.part_no, 5), "x.xlsx")},
                       content_type="multipart/form-data")
    assert resp.status_code == 400   # store_code required


# #4 — spare template download enforces access on a named store.
def test_spare_template_denies_other_store(client):
    u = _store_user(stores=("CHILD_PART",))
    _login(client, u.id)
    resp = client.get("/api/v1/spare-stock/template?store_code=MAINTENANCE")
    assert resp.status_code == 403
