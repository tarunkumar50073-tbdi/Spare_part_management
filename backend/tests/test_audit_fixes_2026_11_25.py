"""25 Nov 2026 audit fixes."""
import io
from datetime import date, datetime

import pytest
from openpyxl import Workbook

from app.extensions import db
from app.models.spare_stock import SpareStock
from app.services.spare_stock_service import SpareStockService
from tests.test_spare_packets import STORE, _part, _seq

_seq["n"] = max(_seq["n"], 90000)


def _sheet(rows):
    wb = Workbook()
    ws = wb.active
    ws.append(["Part No", "In Stock"])
    for r in rows:
        ws.append(list(r))
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_a_part_on_two_rows_of_a_stock_upload_is_refused_not_overwritten():
    a, b = _part(qty=7, pkt=1), _part(qty=2, pkt=1)
    data = _sheet([(a.part_no, 5), (b.part_no, 9), (a.part_no, 3)])
    out = SpareStockService().bulk_import(io.BytesIO(data), store_code=STORE, user="keeper")
    assert out["error_count"] == 2
    assert all(a.part_no in e["reason"] and "2 rows" in e["reason"] for e in out["errors"])
    stock = {s.part_id: float(s.qty_on_hand) for s in SpareStock.query.filter(SpareStock.part_id.in_([a.id, b.id]))}
    assert stock == {a.id: 7.0, b.id: 9.0}          # a untouched, b loaded
