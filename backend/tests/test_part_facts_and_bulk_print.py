"""Per-part facts for the inventory table, and bulk label printing.

part_facts: the last ISSUE + 90-day issued qty come from the ledger, the last
supplier from the gate entries (derived, never stored on the part); a part with
neither is simply absent — "nothing recorded", not zero.

print-bulk: same rules as a single print — a part that already has a label is
skipped (named) unless a reprint reason is given; a foreign-store part refuses
the whole batch.
"""
from datetime import date

import pytest

from app.extensions import db
from app.models.gate_entry import GateEntry
from app.models.part import Part
from app.models.user import User, UserStoreAccess
from app.services.spare_stock_service import SpareStockService

_seq = {"n": 0}


def _part(store="MAINTENANCE"):
    _seq["n"] += 1
    p = Part(part_no=f"PF-{_seq['n']}", part_name=f"Facts {_seq['n']}", uom="NO",
             part_type="OTHER", store_code=store)
    db.session.add(p)
    db.session.commit()
    return p


def test_part_facts_last_issue_90d_and_gate_supplier():
    svc = SpareStockService()
    a, b = _part(), _part()
    svc.set_quantity(a.id, 10, txn_type="OPENING")
    svc.issue(a.id, 3, "Press Shop")
    db.session.add(GateEntry(store_code="CHILD_PART", item_code=a.part_no.lower(), ven_cd="VX-1",
                             ven_name="X TRADERS", gate_entry_dt=date(2026, 8, 1), qty=5,
                             gate_entry_no=f"GE-{a.part_no}"))
    db.session.commit()

    facts = svc.part_facts("MAINTENANCE")
    fa = facts[str(a.id)]
    assert fa["last_issue_at"] is not None
    assert fa["issued_90d"] == 3.0
    assert (fa["supplier"], fa["supplier_code"], fa["last_arrival"]) == ("X TRADERS", "VX-1", "2026-08-01")
    assert str(b.id) not in facts                       # nothing recorded -> absent


@pytest.fixture()
def client(app):
    return app.test_client()


def _login(client, role="ADMIN", stores=()):
    _seq["n"] += 1
    u = User(username=f"pfuser{_seq['n']}", role=role, is_active=True)
    u.set_password("pw")
    db.session.add(u)
    db.session.flush()
    for code in stores:
        db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
    db.session.commit()
    with client.session_transaction() as s:
        s["user_id"] = u.id
    return client


def test_bulk_print_first_labels_then_skips_reprints_without_reason(client):
    c = _login(client)
    p1, p2 = _part(), _part()
    r = c.post("/api/v1/barcode/print-bulk", json={"part_ids": [p1.id, p2.id, p1.id]})
    assert r.status_code == 201, r.get_json()
    d = r.get_json()["data"]
    assert [x["part_id"] for x in d["printed"]] == [p1.id, p2.id]     # de-duplicated
    assert d["skipped"] == []

    r = c.post("/api/v1/barcode/print-bulk", json={"part_ids": [p1.id]})
    d = r.get_json()["data"]
    assert d["printed"] == [] and d["skipped"][0]["part_no"] == p1.part_no
    assert "reason" in d["skipped"][0]["why"].lower()

    r = c.post("/api/v1/barcode/print-bulk", json={"part_ids": [p1.id], "reason": "label torn"})
    assert [x["part_id"] for x in r.get_json()["data"]["printed"]] == [p1.id]


def test_bulk_print_refuses_a_foreign_store_part(client):
    c = _login(client, role="STORE_USER", stores=("MAINTENANCE",))
    mine, theirs = _part(), _part("CHILD_PART")
    r = c.post("/api/v1/barcode/print-bulk", json={"part_ids": [mine.id, theirs.id]})
    assert r.status_code == 403


def test_bulk_print_validates_the_batch(client):
    c = _login(client)
    # The app answers payload validation with 422 (validate_payload).
    assert c.post("/api/v1/barcode/print-bulk", json={"part_ids": []}).status_code == 422
    assert c.post("/api/v1/barcode/print-bulk", json={"part_ids": list(range(1, 302))}).status_code == 422
