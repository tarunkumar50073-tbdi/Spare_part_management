"""Phase 3 — Part-master Excel import: preview (dry-run), granular counts
(inserted/updated/failed), duplicate detection, and import history.
"""
import io

from openpyxl import Workbook

from app.extensions import db
from app.models.part import Part
from app.models.part_import_history import PartImportHistory
from app.services.part_service import PartService

_seq = {"n": 0}


def _uniq():
    _seq["n"] += 1
    return f"IMP-{_seq['n']}"


def _xlsx(rows, headers=("Part No", "Part Name", "UOM")):
    wb = Workbook()
    ws = wb.active
    ws.append(list(headers))
    for r in rows:
        ws.append(list(r))
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


def _existing(part_no):
    db.session.add(Part(part_no=part_no, part_name="Exists", uom="NO",
                        part_type="OTHER", store_code="MAINTENANCE"))
    db.session.commit()


def test_preview_marks_insert_update_error_without_writing():
    svc = PartService()
    ex = _uniq(); _existing(ex)
    new_pn = _uniq()
    buf = _xlsx([
        (new_pn, "Brand New", "NO"),   # INSERT
        (ex, "", "NO"),                 # UPDATE (existing part; name blank is fine)
        ("", "No Part No", "NO"),       # ERROR — missing Part No
        (new_pn, "Dup", "NO"),          # ERROR — duplicate Part No in file
    ])
    before = Part.query.count()
    res = svc.preview_import(buf)
    assert res["counts"]["insert"] == 1
    assert res["counts"]["update"] == 1
    assert res["counts"]["error"] == 2
    assert Part.query.count() == before   # dry-run persisted nothing


def test_import_granular_counts_and_history():
    svc = PartService()
    ex = _uniq(); _existing(ex)
    new_pn = _uniq()
    buf = _xlsx([
        (new_pn, "New One", "NO"),
        (ex, "Existing", "PCS"),        # updates uom on the existing part
        ("", "bad", "NO"),              # fails (no part_no)
    ])
    res = svc.bulk_import_excel(buf, store_code="MAINTENANCE", user="admin", filename="parts.xlsx")
    assert res["inserted"] == 1
    assert res["updated"] == 1
    assert res["failed"] == 1
    assert res["history_id"]
    h = PartImportHistory.query.get(res["history_id"])
    assert h.inserted == 1 and h.updated == 1 and h.failed == 1
    assert h.imported_by == "admin" and h.filename == "parts.xlsx"
    assert Part.query.filter_by(part_no=new_pn).first() is not None


def test_import_does_not_delete_missing_parts():
    """A part absent from the file must survive the import (no auto-delete)."""
    svc = PartService()
    keep = _uniq(); _existing(keep)
    buf = _xlsx([(_uniq(), "Only This", "NO")])
    svc.bulk_import_excel(buf, store_code="MAINTENANCE", filename="x.xlsx")
    assert Part.query.filter_by(part_no=keep).first() is not None


def test_import_history_lists_runs():
    svc = PartService()
    buf = _xlsx([(_uniq(), "H1", "NO")])
    svc.bulk_import_excel(buf, store_code="MAINTENANCE", filename="hist.xlsx")
    hist = svc.import_history(limit=20)
    assert any(x["filename"] == "hist.xlsx" for x in hist)


def test_rates_only_file_keeps_the_existing_uom():
    """10 Nov 2026: a file with Part No, Description and Rate but no UOM column
    must not turn an existing part's UOM into PCS — a blank leaves every field
    alone."""
    svc = PartService()
    pn = _uniq()
    db.session.add(Part(part_no=pn, part_name="Oil", uom="LTR", part_type="OTHER",
                        store_code="MAINTENANCE", unit_price=0))
    db.session.commit()
    buf = _xlsx([(pn, "Oil", 125.5)], headers=("Part No", "Description", "Rate"))
    res = svc.bulk_import_excel(buf, store_code="MAINTENANCE", filename="rates.xlsx")
    assert res["updated"] == 1 and res["failed"] == 0
    p = Part.query.filter_by(part_no=pn).first()
    assert p.uom == "LTR"
    assert float(p.unit_price) == 125.5
    # a blank UOM cell in a file that has the column leaves it alone too
    svc.bulk_import_excel(_xlsx([(pn, "Oil", None)]), store_code="MAINTENANCE", filename="blank.xlsx")
    assert Part.query.filter_by(part_no=pn).first().uom == "LTR"


def test_new_part_without_uom_gets_pcs():
    svc = PartService()
    pn = _uniq()
    svc.bulk_import_excel(_xlsx([(pn, "Bolt")], headers=("Part No", "Part Name")),
                          store_code="MAINTENANCE", filename="new.xlsx")
    assert Part.query.filter_by(part_no=pn).first().uom == "PCS"


def test_part_no_matches_case_and_space_insensitively():
    """The one-shot part lookup keeps the old rule: ' imp-x ' finds IMP-X."""
    svc = PartService()
    pn = _uniq(); _existing(pn)
    res = svc.preview_import(_xlsx([(f" {pn.lower()} ", "", "NO")]))
    assert res["counts"]["update"] == 1
    res = svc.bulk_import_excel(_xlsx([(f" {pn.lower()} ", "", "KG")]), store_code="MAINTENANCE", filename="c.xlsx")
    assert res["updated"] == 1 and res["inserted"] == 0
    assert Part.query.filter_by(part_no=pn).first().uom == "KG"


def test_same_new_part_twice_in_a_file_is_one_part():
    """A Part No repeated in the file: the first row adds it, the second
    updates that new part (it is not added twice)."""
    svc = PartService()
    pn = _uniq()
    res = svc.bulk_import_excel(_xlsx([(pn, "First", "NO"), (pn, "Second", "KG")]),
                                store_code="MAINTENANCE", filename="twice.xlsx")
    assert res["inserted"] == 1 and res["updated"] == 1
    rows = Part.query.filter_by(part_no=pn).all()
    assert len(rows) == 1 and rows[0].uom == "KG"


def test_import_and_preview_read_the_parts_once(app):
    """One query for all parts, not one per row (a 743-row file over a slow
    network timed out on 10 Nov 2026)."""
    from sqlalchemy import event
    svc = PartService()
    pns = [_uniq() for _ in range(30)]
    for pn in pns:
        db.session.add(Part(part_no=pn, part_name="X", uom="NO", part_type="OTHER", store_code="MAINTENANCE"))
    db.session.commit()
    buf_rows = [(pn, "", "NO") for pn in pns]
    seen = []

    def count(conn, cursor, statement, *a):
        if "FROM parts" in statement and statement.lstrip().upper().startswith("SELECT"):
            seen.append(statement)

    engine = db.engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        svc.preview_import(_xlsx(buf_rows))
        assert len(seen) <= 2, len(seen)
        seen.clear()
        svc.bulk_import_excel(_xlsx(buf_rows), store_code="MAINTENANCE", filename="once.xlsx")
        assert len(seen) <= 2, len(seen)
    finally:
        event.remove(engine, "before_cursor_execute", count)


def test_pkt_qty_column_sets_and_zero_clears_the_packet_qty():
    """The Spare store's Pkt Qty (13 Nov 2026) is Part.package_standard: the
    store's own file heading "Pkt Qty." sets it, 0 takes the part off the packed
    list, a blank cell leaves it, and the spare export carries it."""
    svc = PartService()
    a, b, c = _uniq(), _uniq(), _uniq()
    for pn in (a, b, c):
        _existing(pn)
    hdr = ("Part No", "Item Description", "Pkt Qty.")
    svc.bulk_import_excel(_xlsx([(a, "", 30), (b, "", 10), (c, "", None)], hdr), store_code="MAINTENANCE")
    got = {p.part_no: p.package_standard for p in Part.query.filter(Part.part_no.in_([a, b, c]))}
    assert (float(got[a]), float(got[b]), got[c]) == (30, 10, None)
    svc.bulk_import_excel(_xlsx([(a, "", 0), (b, "", None)], hdr), store_code="MAINTENANCE")
    got = {p.part_no: p.package_standard for p in Part.query.filter(Part.part_no.in_([a, b]))}
    assert got[a] is None and float(got[b]) == 10            # 0 clears, blank keeps
    new = _uniq()
    svc.bulk_import_excel(_xlsx([(new, "New Bolt", 0)], hdr), store_code="MAINTENANCE")
    assert Part.query.filter_by(part_no=new).one().package_standard is None
    from app.services.part_service import SPARE_EXPORT_COLUMNS
    assert ("Pkt Qty", "package_standard") in SPARE_EXPORT_COLUMNS
