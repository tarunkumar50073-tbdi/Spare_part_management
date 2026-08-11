"""Auto-derive component type (Part.sub_category) from description, and the
part-type-wise consumption report that reads it."""
from app.extensions import db
from app.models.part import Part
from app.services.part_service import PartService
from app.services.spare_stock_service import SpareStockService
from app.utils.part_category import derive_component_type

_seq = {"n": 0}


def _part(desc, store_code="MAINTENANCE", sub_category=None):
    _seq["n"] += 1
    p = Part(part_no=f"PC-{_seq['n']}", part_name=desc, uom="NO",
             part_type="OTHER", store_code=store_code, sub_category=sub_category)
    db.session.add(p)
    db.session.commit()
    return p


def _set_physical(part_id, qty):
    SpareStockService().set_quantity(part_id, float(qty), txn_type="OPENING")


def test_derive_component_type_keywords():
    assert derive_component_type("DIE#3 -PILOT PIN (STAL5-LC49)") == "Pilot Pin"
    assert derive_component_type("PROXIMITY SENSOR PNP") == "Sensor"
    assert derive_component_type("GAS SPRING PASCAL") == "Gas Spring"
    assert derive_component_type("LOWER RAIL PUNCH") == "Punch"       # component beats product
    assert derive_component_type("SPOOL RETAINER CSR16-85") == "Retainer"
    assert derive_component_type("APEL13-80-P8.8") is None            # pure code -> uncategorised


def test_derive_bulk_sets_subcategory_with_dry_run():
    a = _part("PROXIMITY SENSOR XYZ")
    b = _part("PILOT PIN STAL5-LC80")
    svc = PartService()

    preview = svc.derive_component_types("MAINTENANCE", dry_run=True)
    assert preview["dry_run"] is True and preview["would_update"] >= 2
    db.session.expire_all()
    assert Part.query.get(a.id).sub_category is None  # dry run wrote nothing

    result = svc.derive_component_types("MAINTENANCE", dry_run=False)
    assert result["updated"] >= 2
    db.session.expire_all()
    assert Part.query.get(a.id).sub_category == "Sensor"
    assert Part.query.get(b.id).sub_category == "Pilot Pin"


def test_only_missing_leaves_existing_subcategory():
    p = _part("SOME PUNCH", sub_category="Hand-set Type")
    PartService().derive_component_types("MAINTENANCE", only_missing=True)
    db.session.expire_all()
    assert Part.query.get(p.id).sub_category == "Hand-set Type"  # untouched


def test_consumption_by_type():
    svc = SpareStockService()
    p = _part("HYDRAULIC CYLINDER 50MM")   # -> Cylinder
    PartService().derive_component_types("MAINTENANCE")
    _set_physical(p.id, 20)

    def cyl():
        return next((r["value"] for r in svc.consumption_by_type("MAINTENANCE") if r["name"] == "Cylinder"), 0.0)

    before = cyl()
    svc.issue(p.id, 3, "Maintenance", machine="M1")
    assert cyl() - before == 3.0
