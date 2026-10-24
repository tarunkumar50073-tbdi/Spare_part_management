"""Data Quality Center (/api/v1/data-quality) and the part-change audit.

Five active parts in an isolated section, so every check's count is known:

    A  complete: min 2, reorder 5, max 10, rate, location, counted, barcode on
       the part, a label printed, seen at the gate (lower-case, padded code), NOS
    B  nothing planned, no rate/location, never counted, no barcode, UOM "NO",
       description "... bearing-6205"
    C  max 0, min 3, reorder 1, counted, a mapped (supplier) barcode, NOS,
       description "... BEARING 6205" (same as B once normalised)
    D  min 8 > max 5, reorder 6 (outside the band), counted, NOS
    E  complete but its only barcode mapping is deactivated; its only gate row
       names no vendor, so it still has no supplier; NOS
    F  inactive, everything missing -> never counted anywhere
"""
import io
from datetime import date

import pytest
from openpyxl import Workbook

from app.extensions import db
from app.models.audit_log import AuditLog
from app.models.gate_entry import GateEntry
from app.models.label_print_audit import LabelPrintAudit
from app.models.part import Part
from app.models.part_barcode import PartBarcode
from app.models.spare_stock import SpareStock
from app.models.store import Section, Store
from app.models.user import User, UserStoreAccess
from app.services.data_quality_service import CHECK_KEYS, DataQualityService, _uom_key
from app.services.part_service import PartService

STORE = "MAINTENANCE"
_seq = {"n": 0}


def _next():
    _seq["n"] += 1
    return _seq["n"]


def _part(sec, tag, qty=None, **kw):
    n = _next()
    fields = dict(uom="NOS", part_type="OTHER", store_code=STORE, section_id=sec.id,
                  location="R1-S1-B1", min_stock_level=0)
    fields.update(kw)
    fields.setdefault("part_name", f"DQ {n} {tag} unique item")
    p = Part(part_no=f"DQ-{n}-{tag}", **fields)
    db.session.add(p)
    db.session.commit()
    if qty is not None:
        db.session.add(SpareStock(part_id=p.id, qty_on_hand=qty))
        db.session.commit()
    return p


@pytest.fixture()
def seeded():
    n = _next()
    store = Store.query.filter_by(code=STORE).first()
    sec = Section(store_id=store.id, name=f"DQ Section {n}")
    db.session.add(sec)
    db.session.commit()

    dup = f"DQ{n}"
    p = {
        "A": _part(sec, "A", 4, min_stock_level=2, reorder_level=5, max_stock_level=10,
                   unit_price=100, barcode=f"DQBC-{n}"),
        "B": _part(sec, "B", None, uom="NO", location="", part_name=f"{dup} bearing-6205"),
        "C": _part(sec, "C", 0, min_stock_level=3, reorder_level=1, max_stock_level=0,
                   unit_price=5, location="R2", part_name=f"{dup.lower()}  BEARING 6205"),
        "D": _part(sec, "D", 7, min_stock_level=8, reorder_level=6, max_stock_level=5,
                   unit_price=1, location="R3"),
        "E": _part(sec, "E", 2, min_stock_level=1, reorder_level=2, max_stock_level=3,
                   unit_price=2, location="R4"),
        "F": _part(sec, "F", None, is_active=False, location=None),
    }
    db.session.add_all([
        LabelPrintAudit(part_id=p["A"].id, barcode_value=p["A"].part_no, copies=1),
        PartBarcode(part_id=p["C"].id, code=f"SUP-{n}-C", source="SUPPLIER", is_active=True),
        PartBarcode(part_id=p["E"].id, code=f"SUP-{n}-E", source="SUPPLIER", is_active=False),
        GateEntry(store_code="CHILD_PART", item_code=f"  {p['A'].part_no.lower()} ", ven_cd="V1",
                  ven_name="V ONE", gate_entry_dt=date(2026, 8, 1), gate_entry_no=f"GE-DQ-{n}"),
        GateEntry(store_code="CHILD_PART", item_code=p["E"].part_no, ven_cd=None, ven_name="  ",
                  gate_entry_dt=date(2026, 8, 2), gate_entry_no=f"GE-DQ-{n}-E"),
    ])
    db.session.commit()
    return sec, p


def _hits(summary):
    return {c["key"]: c for c in summary["checks"]}


def test_summary_counts_for_a_section(seeded):
    sec, p = seeded
    s = DataQualityService().summary(STORE, section_id=sec.id)
    assert s["parts"] == 5                                    # F is inactive
    c = _hits(s)
    assert [k for k in c] == list(CHECK_KEYS)
    expected = {
        "missing_max": 2, "missing_min": 1, "missing_reorder": 1, "missing_rate": 1,
        "zero_reorder": 0, "zero_rate": 0,
        "missing_location": 1, "never_counted": 1, "reorder_outside_min_max": 1,
        "min_greater_than_max": 1, "missing_barcode": 3, "no_label_printed": 4,
        "no_gate_supplier": 4, "uom_variants": 1, "duplicate_names": 2,
    }
    assert {k: c[k]["count"] for k in expected} == expected
    assert c["missing_max"]["pct"] == 40.0
    assert c["missing_max"]["fixable_field"] == "max_stock_level"
    assert c["missing_max"]["severity"] == "warning"
    assert c["missing_barcode"]["fixable_field"] is None
    assert c["duplicate_names"]["severity"] == "info" and c["duplicate_names"]["groups"] == 1
    assert c["no_gate_supplier"]["gate_window"]["rows"] >= 1
    # Same five-field rule as the dashboard: 25 slots, 6 empty.
    assert s["completeness_pct"] == round(19 / 25 * 100, 1)
    assert {f["field"]: f["filled"] for f in s["fields"]} == {
        "max_stock_level": 3, "min_stock_level": 4, "reorder_level": 4,
        "unit_price": 4, "location": 4,
    }
    assert s["uom_variants"] == [{
        "unit": "NO", "parts": 5, "most_used": "NOS",
        "spellings": [{"uom": "NOS", "count": 4}, {"uom": "NO", "count": 1}],
    }]


def _ids(rows):
    return {r["part_id"] for r in rows}


def test_zero_rate_and_reorder_and_vendor_only_gate_rows():
    n = _next()
    store = Store.query.filter_by(code=STORE).first()
    sec = Section(store_id=store.id, name=f"DQ Zero {n}")
    db.session.add(sec)
    db.session.commit()
    z1 = _part(sec, "Z1", 1, min_stock_level=2, reorder_level=0, max_stock_level=10, unit_price=0)
    z2 = _part(sec, "Z2", 1)                                    # rate and reorder blank
    z3 = _part(sec, "Z3", 1, min_stock_level=1, reorder_level=4, max_stock_level=5, unit_price=3)
    # A vendor code with no name still names a supplier (the app's gate rule).
    db.session.add(GateEntry(store_code="CHILD_PART", item_code=z3.part_no, ven_cd="V9", ven_name=None,
                             gate_entry_dt=date(2026, 8, 3), gate_entry_no=f"GE-DQZ-{n}"))
    db.session.commit()

    svc = DataQualityService()
    s = svc.summary(STORE, section_id=sec.id)
    c = _hits(s)
    counts = {k: c[k]["count"] for k in ("missing_reorder", "zero_reorder", "missing_rate", "zero_rate")}
    assert counts == {"missing_reorder": 1, "zero_reorder": 1, "missing_rate": 1, "zero_rate": 1}
    assert c["zero_rate"]["fixable_field"] == "unit_price"
    # A stored 0 stays "filled" in completeness (the dashboard's rule); the tile carries it.
    fields = {f["field"]: f for f in s["fields"]}
    assert (fields["unit_price"]["filled"], fields["unit_price"]["zero"]) == (2, 1)
    assert (fields["reorder_level"]["filled"], fields["reorder_level"]["zero"]) == (2, 1)
    assert fields["unit_price"]["zero_check"] == "zero_rate" and "zero" not in fields["max_stock_level"]
    assert s["completeness_pct"] == round(11 / 15 * 100, 1)

    def section_ids(check):
        return _ids(svc.parts(STORE, check, section_id=sec.id)["rows"])

    assert section_ids("zero_rate") == {z1.id} and section_ids("zero_reorder") == {z1.id}
    assert section_ids("missing_rate") == {z2.id}
    assert section_ids("no_gate_supplier") == {z1.id, z2.id}


def test_parts_list_per_check(seeded):
    sec, p = seeded
    svc = DataQualityService()
    ids = lambda *tags: {p[t].id for t in tags}  # noqa: E731

    def section_rows(check):
        return svc.parts(STORE, check, section_id=sec.id)["rows"]

    assert _ids(section_rows("missing_max")) == ids("B", "C")
    assert _ids(section_rows("missing_min")) == ids("B")
    assert _ids(section_rows("reorder_outside_min_max")) == ids("D")
    assert _ids(section_rows("min_greater_than_max")) == ids("D")
    assert _ids(section_rows("missing_barcode")) == ids("B", "D", "E")
    assert _ids(section_rows("no_label_printed")) == ids("B", "C", "D", "E")
    assert _ids(section_rows("no_gate_supplier")) == ids("B", "C", "D", "E")
    assert _ids(section_rows("never_counted")) == ids("B")

    uom = section_rows("uom_variants")
    assert _ids(uom) == ids("B") and uom[0]["uom_most_used"] == "NOS"

    dup = section_rows("duplicate_names")
    assert _ids(dup) == ids("B", "C")
    assert {r["name_group"] for r in dup} == {f"{p['B'].part_name.split()[0]} BEARING 6205"}

    row = next(r for r in section_rows("missing_max") if r["part_id"] == p["C"].id)
    assert row["part_no"] == p["C"].part_no and row["section"] == sec.name
    assert (row["min_stock_level"], row["reorder_level"], row["max_stock_level"]) == (3.0, 1.0, 0.0)
    assert row["barcode"].startswith("SUP-") and row["barcode"].endswith("-C")   # the mapped one
    assert row["qty_on_hand"] == 0.0 and row["unit_price"] == 5.0 and row["location"] == "R2"

    # Store-wide (other tests' parts share the store): filtered to ours, same answer.
    mine = ids("A", "B", "C", "D", "E", "F")
    store_rows = svc.parts(STORE, "missing_max")["rows"]
    assert _ids(store_rows) & mine == ids("B", "C")
    assert _ids(svc.parts(STORE, "no_gate_supplier")["rows"]) & mine == ids("B", "C", "D", "E")


@pytest.fixture()
def client(app):
    return app.test_client()


def _login(client, role="STORE_USER", perms=None, stores=(STORE,)):
    n = _next()
    u = User(username=f"dquser{n}", role=role, is_active=True)
    u.set_password("pw")
    if perms:
        u.set_permissions(perms)
    db.session.add(u)
    db.session.flush()
    for code in stores:
        db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
    db.session.commit()
    with client.session_transaction() as s:
        s["user_id"] = u.id
    return u


def test_endpoints_ok_bad_check_and_store_required(client, seeded):
    sec, p = seeded
    _login(client, perms={"data_quality": {"view": True}})
    r = client.get(f"/api/v1/data-quality?store_code={STORE}&section_id={sec.id}")
    assert r.status_code == 200
    body = r.get_json()["data"]
    assert body["parts"] == 5 and len(body["checks"]) == len(CHECK_KEYS)

    r = client.get(f"/api/v1/data-quality/parts?store_code={STORE}&section_id={sec.id}&check=missing_rate")
    assert r.status_code == 200
    assert _ids(r.get_json()["data"]["rows"]) == {p["B"].id}

    assert client.get(f"/api/v1/data-quality/parts?store_code={STORE}&check=nope").status_code == 400
    assert client.get(f"/api/v1/data-quality/parts?store_code={STORE}").status_code == 400
    assert client.get("/api/v1/data-quality").status_code == 400


def test_endpoints_need_data_quality_and_store_access(client):
    _login(client, perms={"part_master": {"view": True}})          # Part Master alone: Data Quality has its own right
    assert client.get(f"/api/v1/data-quality?store_code={STORE}").status_code == 403
    assert client.get(f"/api/v1/data-quality/parts?store_code={STORE}&check=missing_max").status_code == 403

    _login(client, perms={"data_quality": {"view": True}}, stores=())  # right, but not this store
    assert client.get(f"/api/v1/data-quality?store_code={STORE}").status_code == 403


# ------------------------------------------------------------ part-change audit

def _audit(part_id, action):
    return (AuditLog.query.filter_by(entity_type="PART", entity_id=part_id, action=action)
            .order_by(AuditLog.id.asc()).all())


def test_update_writes_old_to_new_and_noop_writes_nothing(client, seeded):
    sec, p = seeded
    part = _part(sec, "AU", min_stock_level=5, location="R1-S1-B1")
    u = _login(client, role="ADMIN", stores=())

    r = client.put(f"/api/v1/parts/{part.id}", json={"min_stock_level": 7, "location": "R2-S1-B1"})
    assert r.status_code == 200
    rows = _audit(part.id, "PART_UPDATED")
    assert len(rows) == 1
    assert rows[0].user == "STORE"
    assert f"by {u.username}: min_stock_level 5 -> 7; location R1-S1-B1 -> R2-S1-B1" in rows[0].remarks
    assert rows[0].remarks.startswith(part.part_no)

    # Same values again (and a blank that was already blank): nothing changed, nothing logged.
    r = client.put(f"/api/v1/parts/{part.id}",
                   json={"min_stock_level": 7, "location": "R2-S1-B1", "max_stock_level": None})
    assert r.status_code == 200
    assert len(_audit(part.id, "PART_UPDATED")) == 1

    # Only the field that moved is named.
    client.put(f"/api/v1/parts/{part.id}", json={"min_stock_level": 7, "max_stock_level": 12.5})
    rows = _audit(part.id, "PART_UPDATED")
    assert len(rows) == 2 and rows[1].remarks.endswith(": max_stock_level blank -> 12.5")


def test_create_and_delete_are_audited_outside_a_request():
    svc = PartService()
    n = _next()
    part = svc.create({"part_no": f"DQ-AUD-{n}", "part_name": "Audit me", "store_code": STORE})
    created = _audit(part.id, "PART_CREATED")
    assert len(created) == 1
    assert created[0].user == "SYSTEM" and "by system: created (Audit me)" in created[0].remarks

    pid = part.id
    svc.delete(pid)
    assert db.session.get(Part, pid) is None
    deleted = _audit(pid, "PART_DELETED")
    assert len(deleted) == 1 and deleted[0].remarks.startswith(f"DQ-AUD-{n} by system: deleted")


def test_bulk_import_writes_one_summary_row():
    wb = Workbook()
    ws = wb.active
    ws.append(["Part No", "Part Name", "UOM"])
    n = _next()
    ws.append([f"DQ-IMP-{n}", "Imported", "NO"])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    report = PartService().bulk_import_excel(buf, store_code=STORE, user="keeper", filename="dq.xlsx")
    rows = AuditLog.query.filter_by(entity_type="PART", action="PARTS_IMPORTED").all()
    mine = [r for r in rows if r.remarks.startswith(f"Import #{report['history_id']} ")]
    assert len(mine) == 1
    assert "(dq.xlsx) by keeper: 1 added, 0 updated, 0 failed of 1" in mine[0].remarks
    # Per-part detail lives in the import history, not one audit row per part.
    # (Matched on the part no: SQLite reuses a deleted part's id.)
    part = Part.query.filter_by(part_no=f"DQ-IMP-{n}").first()
    assert not [r for r in _audit(part.id, "PART_CREATED") if r.remarks.startswith(part.part_no)]


def test_uom_spellings_normalise_to_one_unit():
    assert {_uom_key(u) for u in ("NOS", "Nos.", "no", "NUMBERS")} == {"NO"}
    assert {_uom_key(u) for u in ("PCS", "pc", "Pieces")} == {"PC"}
    assert _uom_key("KGS") == "KG" and _uom_key("MS") == "MS" and _uom_key("SET") == "SET"
