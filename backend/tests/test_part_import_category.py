"""Part Master Excel (27 Oct 2026, "part master ki file excel k according sahi
kar k bna"): the Spare Parts Store's file is in its DX sheet's layout — each
part by its Section, Category = the part's kind (sub_category), no broad
category and no Part Type. The DX sheet itself imports as it is. Older files
("Category (BOP/...)" + "Sub Category", or the short-lived "Main Category"
one) still read as before, and the Child Part store keeps its own layout."""
import io

from openpyxl import Workbook, load_workbook

from app.extensions import db
from app.models.part import Part
from app.models.store import Section, Store
from app.services.part_service import (SPARE_TEMPLATE_COLUMNS, TEMPLATE_COLUMNS, PartService)

STORE = "MAINTENANCE"
_n = {"n": 0}


def _section():
    _n["n"] += 1
    sec = Section(store_id=Store.query.filter_by(code=STORE).one().id, name=f"PIC Section {_n['n']}")
    db.session.add(sec)
    db.session.commit()
    return sec


def _file(head, *rows):
    wb = Workbook()
    ws = wb.active
    ws.append(head)
    for r in rows:
        ws.append(list(r))
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


def _sheet(buf):
    buf = buf[0] if isinstance(buf, tuple) else buf
    ws = load_workbook(buf).active
    head = [c.value for c in next(ws.iter_rows(max_row=1))]
    return head, list(ws.iter_rows(min_row=2, values_only=True))


DX_HEAD = ["SR.NO", " ITEM CODE ", "LOCATION", "REWORK  ITEM LOCATION", "Section", "Category", "Specification",
           "    ITEM DESCRIPTION ", "UOM", "SUPPLIER", "MIN. ", "MAX.", "REODER.", "ERP", "PHYSICAL STOCK ", "Gap", "RATE"]


def test_the_dx_sheet_imports_as_it_is():
    sec = _section()
    db.session.add(Part(part_no="PIC-DX-OLD", part_name="OLD NAME", uom="NOS", part_type="OTHER",
                        store_code=STORE, category="Maintenance/Tool Room"))
    db.session.commit()
    # The sheet as it is: a title row above the headings.
    f = _file(["MAINTENANCE SPARE PART PHYSICAL INVENTORY AS ON 27.09.2026"], DX_HEAD,
              (1, "PIC-DX-1", "R1-S1-B1", None, sec.name, "Cylinder", "MGPM20-150Z", "AIR CYLINDER MGPM20-150Z",
               "NOS", "SMC CORPORATION", 1, 3, 2, 1, 1, 0, 7535),
              (2, "PIC-DX-OLD", "R1-S1-B2", "RW-1", sec.name.lower(), "Bearing", None, None,
               "NOS", None, 2, 4, 1, 0, 0, 0, None))
    report = PartService().bulk_import_excel(f, store_code=STORE)
    assert (report["inserted"], report["updated"], report["failed"]) == (1, 1, 0)

    new = Part.query.filter_by(part_no="PIC-DX-1").one()
    assert (new.section_id, new.sub_category, new.category) == (sec.id, "Cylinder", "Maintenance/Tool Room")
    assert (new.part_name, new.location, new.specification, new.part_type) == (
        "AIR CYLINDER MGPM20-150Z", "R1-S1-B1", "MGPM20-150Z", "OTHER")
    assert (float(new.min_stock_level), float(new.max_stock_level), float(new.reorder_level), float(new.unit_price)) == (1, 3, 2, 7535)

    old = Part.query.filter_by(part_no="PIC-DX-OLD").one()
    assert (old.section_id, old.sub_category, old.rework_location, old.part_name) == (sec.id, "Bearing", "RW-1", "OLD NAME")


def test_a_section_not_of_the_store_is_refused_for_its_row():
    f = _file(["Part No", "Section", "Category", "Description"], ("PIC-NOSEC-1", "No Such Section", "Seal", "SEAL"))
    preview = PartService().preview_import(_file(["Part No", "Section", "Category", "Description"],
                                                 ("PIC-NOSEC-1", "No Such Section", "Seal", "SEAL")), store_code=STORE)
    assert preview["rows"][0]["action"] == "ERROR" and "not a section" in preview["rows"][0]["reason"]
    report = PartService().bulk_import_excel(f, store_code=STORE)
    assert report["inserted"] == 0 and "not a section" in str(report.get("errors"))
    assert Part.query.filter_by(part_no="PIC-NOSEC-1").first() is None


def test_the_spare_export_is_the_dx_layout_and_reads_back():
    sec = _section()
    db.session.add(Part(part_no="PIC-EXP-1", part_name="BEARING 6204", uom="NOS", part_type="TOOL_ROOM",
                        store_code=STORE, category="Maintenance/Tool Room", sub_category="Bearing",
                        section_id=sec.id, location="R2-S1-B3", min_stock_level=2, max_stock_level=6))
    db.session.commit()
    head, rows = _sheet(PartService().export_all(STORE))
    assert head[:9] == ["Part No", "Location", "Rework Location", "Section", "Category", "Specification",
                        "Description", "UOM", "Supplier"]
    assert not {"Main Category", "Sub Category", "Part Type", "Store"} & set(head)
    row = next(r for r in rows if r[head.index("Part No")] == "PIC-EXP-1")
    assert (row[head.index("Section")], row[head.index("Category")], row[head.index("Description")]) == (
        sec.name, "Bearing", "BEARING 6204")

    # Typed into and loaded back: the same file is the import.
    wb = load_workbook(_buf := PartService().export_all(STORE))
    ws = wb.active
    for r in ws.iter_rows(min_row=2):
        if r[0].value == "PIC-EXP-1":
            r[head.index("Max")].value = 8
            r[head.index("Category")].value = "Ball Bearing"
    out = io.BytesIO()
    wb.save(out)
    out.seek(0)
    report = PartService().bulk_import_excel(out, store_code=STORE)
    assert report["failed"] == 0
    p = Part.query.filter_by(part_no="PIC-EXP-1").one()
    assert (float(p.max_stock_level), p.sub_category, p.category, p.part_type, p.section_id) == (
        8, "Ball Bearing", "Maintenance/Tool Room", "TOOL_ROOM", sec.id)


def test_templates_per_store():
    assert not any(c.startswith(("Main Category", "Part Type", "Sub Category")) for c in SPARE_TEMPLATE_COLUMNS)
    assert SPARE_TEMPLATE_COLUMNS[:5] == ["Part No", "Location", "Rework Location", "Section", "Category"]
    assert "Supplier" not in SPARE_TEMPLATE_COLUMNS and "Status" not in SPARE_TEMPLATE_COLUMNS
    assert "Sub Category" in TEMPLATE_COLUMNS and any(c.startswith("Category (BOP") for c in TEMPLATE_COLUMNS)
    head, _ = _sheet(PartService.build_template(STORE))
    assert head == SPARE_TEMPLATE_COLUMNS
    head, _ = _sheet(PartService.build_template("CHILD_PART"))
    assert head == TEMPLATE_COLUMNS


def test_the_child_part_export_keeps_category_and_sub_category():
    db.session.add(Part(part_no="PIC-CP-1", part_name="BRACKET", uom="NOS", part_type="OTHER",
                        store_code="CHILD_PART", category="BOP", sub_category="Bracket"))
    db.session.commit()
    head, rows = _sheet(PartService().export_all("CHILD_PART"))
    row = next(r for r in rows if r[head.index("Part No")] == "PIC-CP-1")
    assert (row[head.index("Category")], row[head.index("Sub Category")]) == ("BOP", "Bracket")
    assert "Part Type" in head and "Main Category" not in head


def test_older_files_land_as_before():
    old = _file(["Part No", "Part Name", "Category (BOP/Import/Maintenance-Tool Room/Consumable/In-Parts)", "Sub Category"],
                ("PIC-OLD-1", "SEAL", "Maintenance/Tool Room", "Seal"))
    PartService().bulk_import_excel(old, store_code=STORE)
    q = Part.query.filter_by(part_no="PIC-OLD-1").one()
    assert (q.sub_category, q.category) == ("Seal", "Maintenance/Tool Room")

    mid = _file(["Part No", "Part Name", "Main Category (BOP/Import/Maintenance-Tool Room/Consumable/In-Parts)", "Category"],
                ("PIC-MID-1", "AIR CYLINDER", "Maintenance/Tool Room", "Cylinder"))
    PartService().bulk_import_excel(mid, store_code=STORE)
    p = Part.query.filter_by(part_no="PIC-MID-1").one()
    assert (p.sub_category, p.category) == ("Cylinder", "Maintenance/Tool Room")
