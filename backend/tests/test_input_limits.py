"""Limits on what one upload or one question can make the server do (security
audit, 24 Oct 2026): Store Saathi's question length, the part photo's formats
and pixel count, and an Excel file's unpacked size."""
import io
import struct
import uuid
import zlib

import pytest
from openpyxl import Workbook
from PIL import Image

from app.extensions import db
from app.models.part import Part
from app.models.user import User
from app.services.part_image_service import PartImageService
from app.utils import excel_io
from app.utils.exceptions import BadRequestError

_TAG = uuid.uuid4().hex[:6].upper()


def _as(app, perms=None, admin=False):
    u = User(username=f"il{_TAG.lower()}{uuid.uuid4().hex[:4]}", role="ADMIN" if admin else "STORE_USER", is_active=True)
    u.set_password("pw")
    u.set_permissions(perms or {})
    db.session.add(u)
    db.session.commit()
    c = app.test_client()
    with c.session_transaction() as sess:
        sess["user_id"] = u.id
    return c


def test_store_saathi_refuses_a_question_over_300_characters(app):
    c = _as(app)
    r = c.post("/api/v1/assistant/ask", json={"query": "9" * 301})
    assert r.status_code == 400 and "300" in r.get_json()["message"]
    assert c.post("/api/v1/assistant/ask", json={"query": "stock khatam"}).status_code == 200


def _png_claiming(width, height):
    """A tiny real PNG whose header says width x height — Pillow reads the size
    from the header alone, so no big picture is ever made here."""
    buf = io.BytesIO()
    Image.new("RGB", (1, 1)).save(buf, "PNG")
    data = bytearray(buf.getvalue())
    ihdr = data.index(b"IHDR")
    data[ihdr + 4:ihdr + 12] = struct.pack(">II", width, height)
    crc = zlib.crc32(bytes(data[ihdr:ihdr + 17])) & 0xFFFFFFFF
    data[ihdr + 17:ihdr + 21] = struct.pack(">I", crc)
    return io.BytesIO(bytes(data))


@pytest.fixture()
def part(app, tmp_path):
    old = app.config.get("PART_IMAGE_DIR")
    app.config["PART_IMAGE_DIR"] = str(tmp_path / "imgs")
    p = Part(part_no=f"IL-{_TAG}-{uuid.uuid4().hex[:4]}", part_name="Limit part", uom="NOS", part_type="OTHER",
             store_code="MAINTENANCE")
    db.session.add(p)
    db.session.commit()
    yield p
    app.config["PART_IMAGE_DIR"] = old
    db.session.rollback()
    Part.query.filter_by(id=p.id).delete()
    db.session.commit()


def test_a_photo_too_large_in_pixels_is_refused_before_its_pixels_are_read(part):
    with pytest.raises(BadRequestError, match="too large"):
        PartImageService().save(part.id, _png_claiming(12000, 12000))      # 144 MP
    db.session.refresh(part)
    assert part.image_file is None


def test_only_camera_and_picture_formats_are_opened(part):
    ico = io.BytesIO()
    Image.new("RGB", (16, 16), (200, 0, 0)).save(ico, "ICO")
    ico.seek(0)
    with pytest.raises(BadRequestError, match="not a photo"):
        PartImageService().save(part.id, ico)
    png = io.BytesIO()
    Image.new("RGB", (40, 30), (0, 120, 0)).save(png, "PNG")
    png.seek(0)
    assert PartImageService().save(part.id, png).image_file


def test_an_excel_file_that_unpacks_too_big_is_refused(monkeypatch):
    wb = Workbook()
    wb.active.append(["Part No", "Part Name"])
    for i in range(200):
        wb.active.append([f"P-{i}", "x" * 50])
    buf = io.BytesIO()
    wb.save(buf)
    data = buf.getvalue()
    excel_io.check_xlsx_size(data)                                   # well under the real limit
    monkeypatch.setattr(excel_io, "XLSX_MAX_UNPACKED", 1000)
    with pytest.raises(ValueError, match="too big to read"):
        excel_io.check_xlsx_size(data)
    stream = io.BytesIO(data)
    stream.seek(0)
    with pytest.raises(ValueError):
        excel_io.check_xlsx_size(stream)
    assert stream.tell() == 0                                         # the stream is left where it was
    excel_io.check_xlsx_size(b"not a zip at all")                    # left to openpyxl's own error
