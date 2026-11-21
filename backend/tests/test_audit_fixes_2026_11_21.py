"""21 Nov 2026 app audit fixes."""
import pytest

from app.extensions import db
from app.models.spare_packet import SparePacket
from app.utils.exceptions import BadRequestError
from tests.test_spare_packets import _seq, STORE, _part, svc

# Own part numbers: this file runs beside test_spare_packets in one DB.
_seq["n"] = max(_seq["n"], 50000 + (sum(map(ord, __name__)) % 1000) * 100)


def test_one_receipts_unprinted_labels_come_past_the_first_hundred():
    p = _part(qty=230, pkt=1)
    made = svc.old_stock_pack(p.id, 230, "PACKET", user="sup")["packets"]
    batch = db.session.get(SparePacket, made[0]["id"]).batch_id
    first = db.session.get(SparePacket, made[0]["id"])
    first.print_count = 1
    db.session.commit()
    got, page = [], 1
    while True:
        out = svc.packets(STORE, batch_id=batch, unprinted=True, page=page, page_size=100)
        got += out["rows"]
        if len(got) >= out["total"] or not out["rows"]:
            break
        page += 1
    assert out["total"] == 229 and len(got) == 229
    assert first.id not in {r["id"] for r in got}


@pytest.mark.parametrize("bad", ["2026-13-01", "yesterday"])
def test_a_bad_date_filter_is_a_400_not_a_500(bad):
    with pytest.raises(BadRequestError, match="date"):
        svc.packets(STORE, issued=True, date_from=bad)
    with pytest.raises(BadRequestError, match="date"):
        svc.packets(STORE, issued=True, date_to=bad)
