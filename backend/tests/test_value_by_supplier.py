"""On-hand stock value by each part's LAST gate-entry supplier.

A spare part arrives from several vendors over time, so the value is credited
to whoever brought it most recently — an approximation the response labels in
`basis`. Parts never seen at the gate are reported apart as `unattributed`
(not ranked as a fake supplier), so total = attributed + unattributed."""
from datetime import date

from app.extensions import db
from app.models.gate_entry import GateEntry
from app.models.part import Part
from app.models.spare_stock import SpareStock
from app.models.store import Section, Store
from app.services.spare_stock_service import SpareStockService

STORE = "MAINTENANCE"


def _section(name):
    # Own section, so the shared session DB's other parts stay out of the sums.
    store = Store.query.filter_by(code=STORE).first()
    sec = Section(store_id=store.id, name=name)
    db.session.add(sec)
    db.session.commit()
    return sec


def _part(sec, part_no, qty, rate):
    p = Part(part_no=part_no, part_name=part_no, uom="PCS", part_type="OTHER",
             store_code=STORE, section_id=sec.id, unit_price=rate)
    db.session.add(p)
    db.session.commit()
    if qty is not None:
        db.session.add(SpareStock(part_id=p.id, qty_on_hand=qty))
        db.session.commit()
    return p


def _gate(part_no, ven_cd, ven_name, d):
    db.session.add(GateEntry(store_code=STORE, item_code=part_no, ven_cd=ven_cd,
                             ven_name=ven_name, gate_entry_dt=d, qty=1,
                             gate_entry_no=f"GE-{part_no}-{d.isoformat()}"))
    db.session.commit()


def test_value_credited_to_latest_supplier_and_unattributed_kept_apart():
    sec = _section("VBS Latest")
    a = _part(sec, "VBS-A", 10, 100)      # ₹1,000 — older Alpha, newer Beta → Beta
    b = _part(sec, "VBS-B", 5, 40)        # ₹200   — Alpha only
    c = _part(sec, "VBS-C", 2, 250)       # ₹500   — never at the gate
    _part(sec, "VBS-D", None, 99)         # not counted → no value, left out
    _gate("VBS-A", "V-ALPHA", "ALPHA TRADERS", date(2026, 6, 1))
    _gate("vbs-a", "V-BETA", "BETA INDUSTRIES", date(2026, 8, 1))   # case-insensitive match
    _gate("VBS-B", "V-ALPHA", "ALPHA TRADERS", date(2026, 7, 1))
    # A vendor-less gate row newer than Beta must not steal VBS-A.
    _gate("VBS-A", None, None, date(2026, 9, 1))

    out = SpareStockService().stock_value_by_last_supplier(STORE, section_id=sec.id)

    assert out["basis"] == "last gate-entry supplier"
    by = {s["ven_cd"]: s for s in out["suppliers"]}
    assert set(by) == {"V-BETA", "V-ALPHA"}
    assert by["V-BETA"]["value"] == 1000.0 and by["V-BETA"]["part_ids"] == [a.id]
    assert by["V-ALPHA"]["value"] == 200.0 and by["V-ALPHA"]["part_ids"] == [b.id]
    assert out["suppliers"][0]["ven_cd"] == "V-BETA"          # ranked by value

    assert out["unattributed"]["value"] == 500.0
    assert out["unattributed"]["part_ids"] == [c.id]
    assert out["attributed"] == 1200.0
    assert out["total"] == 1700.0 == out["attributed"] + out["unattributed"]["value"]
    assert out["supplier_count"] == 2
    assert out["others"] == {"count": 0, "value": 0.0, "parts": 0}


def test_value_by_supplier_top_folds_the_rest_into_others():
    sec = _section("VBS Top")
    for i, (qty, rate) in enumerate([(1, 300), (1, 200), (1, 100)]):
        _part(sec, f"VBS-T{i}", qty, rate)
        _gate(f"VBS-T{i}", f"V-T{i}", f"VENDOR {i}", date(2026, 8, 1))

    out = SpareStockService().stock_value_by_last_supplier(STORE, section_id=sec.id, top=1)

    assert [s["ven_cd"] for s in out["suppliers"]] == ["V-T0"]
    assert out["others"] == {"count": 2, "value": 300.0, "parts": 2}
    assert out["total"] == 600.0
