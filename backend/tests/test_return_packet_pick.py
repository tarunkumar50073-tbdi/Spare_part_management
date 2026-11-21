"""21 Nov 2026 audit: a return takes the scanned packet, never one already
recorded on an earlier return, and finds any whole-packet combination."""
import pytest

from app.extensions import db
from app.models.spare_packet import SparePacket
from app.models.spare_stock import SpareStockLedger
from app.services.spare_return_service import SpareReturnService
from app.utils.exceptions import BadRequestError
from tests.test_spare_packets import DEPT, _part, svc

rsvc = SpareReturnService()


def _issued(sizes_total=24, pkt=10):
    whole = -(-sizes_total // pkt) * pkt
    p = _part(qty=whole, pkt=pkt)
    made = svc.old_stock_pack(p.id, whole, "PACKET", user="sup")["packets"]
    if whole != sizes_total:   # the last packet a smaller one, as a short receipt leaves it
        db.session.get(SparePacket, made[-1]["id"]).qty = pkt - (whole - sizes_total)
        db.session.commit()
    out = svc.issue_many([str(x["id"]) for x in made], DEPT, user="tester", issued_to="Ravi", remarks="r")
    issue = SpareStockLedger.query.filter_by(part_id=p.id, txn_type="ISSUE").one()
    return p, [db.session.get(SparePacket, x["id"]) for x in out["packets"]], issue


def test_ten_ten_four_returns_twenty_as_the_two_tens():
    _, packets, issue = _issued()
    assert sorted(float(x.qty) for x in packets) == [4, 10, 10]
    back = rsvc._packets_back(issue, 20)
    assert sorted(float(x.qty) for x in back) == [10, 10]
    with pytest.raises(BadRequestError, match="whole packets"):
        rsvc._packets_back(issue, 5)


def test_the_scanned_packet_is_the_one_that_comes_back():
    _, packets, issue = _issued(sizes_total=20)
    a, b = sorted(packets, key=lambda x: x.seq)
    a.code = a.code + "-A"
    db.session.commit()
    assert [x.id for x in rsvc._packets_back(issue, 10, scanned=a.code.lower())] == [a.id]


def test_a_packet_sent_on_job_work_is_not_put_back_on_the_shelf():
    _, packets, issue = _issued(sizes_total=20)
    jw = rsvc.job_work_return(issue.id, qty=10, reason="worn out", user="tester")
    sent = jw.get("packet_id") if isinstance(jw, dict) else None
    from app.models.spare_flow import SpareReturn
    sent = sent or SpareReturn.query.filter_by(issue_id=issue.id).one().packet_id
    back = rsvc._packets_back(issue, 10)
    assert [x.id for x in back] != [sent] and len(back) == 1
