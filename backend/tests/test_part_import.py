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
