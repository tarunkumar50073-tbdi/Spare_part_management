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


def test_rack_pack_reports_a_bad_row_and_still_makes_the_rest():
    a, b = _part(qty=4, pkt=1), _part(qty=3, pkt=1)
    out = svc.rack_pack([{"part_id": a.id, "counted_qty": 4},
                         {"part_id": 99999999, "counted_qty": 2},
                         {"part_id": b.id, "counted_qty": "abc"}], user="sup")
    assert out["parts"] == 1 and len(out["packets"]) == 4
    assert {e["part_id"] for e in out["errors"]} == {99999999, b.id}


def test_the_return_pick_list_shows_every_packet_still_out():
    from app.models.spare_stock import SpareStockLedger
    from app.services.spare_stock_service import SpareStockService
    from tests.test_spare_packets import DEPT
    p = _part(qty=20, pkt=10)
    made = svc.old_stock_pack(p.id, 20, "PACKET", user="sup")["packets"]
    svc.issue_many([str(x["id"]) for x in made], DEPT, user="tester", issued_to="Ravi", remarks="r")
    rows = SpareStockService().returnable_issues_for_part(p.id)
    assert len(rows) == 1 and rows[0]["issued_qty"] == 20
    assert sorted(x["qty"] for x in rows[0]["packets"]) == [10, 10]
    assert rows[0]["packet"]["id"] in {x["id"] for x in rows[0]["packets"]}


def test_reading_return_documents_needs_a_right(app):
    from tests.test_read_access import _login
    plain = _login(app, perms={"live_dashboard": {"view": True}})
    assert plain.get(f"/api/v1/spare-flow/returns?store_code={STORE}").status_code == 403
    keeper = _login(app, perms={"scan_part": {"view": True}})
    assert keeper.get(f"/api/v1/spare-flow/returns?store_code={STORE}").status_code == 200


def test_issue_and_return_numbers_run_by_financial_year():
    """21 Nov 2026: IS/2026-27/0001 and RET/2026-27/0001, 4 digits, from April each year."""
    import re
    from datetime import date
    from app.models.spare_stock import SpareStockLedger
    from app.services.spare_journal_service import SpareJournalService
    from app.services.spare_return_service import SpareReturnService
    from app.services.spare_stock_service import SpareStockService
    from tests.test_spare_packets import DEPT
    fy = SpareJournalService.financial_year
    assert fy(date(2026, 11, 21)) == "2026-27" and fy(date(2027, 3, 31)) == "2026-27"
    assert fy(date(2027, 4, 1)) == "2027-28" and fy(date(2099, 1, 5)) == "2098-99"
    p = _part(qty=10, pkt=1)
    stock = SpareStockService()
    a = stock.issue(p.id, 1, DEPT, issued_to="Ravi", user="sup", remarks="r")["issue"]
    b = stock.issue(p.id, 1, DEPT, issued_to="Ravi", user="sup", remarks="r")["issue"]
    pat = re.compile(r"^IS/\d{4}-\d{2}/(\d{4})$")
    na, nb = pat.match(a["issue_no"]), pat.match(b["issue_no"])
    assert na and nb and int(nb.group(1)) == int(na.group(1)) + 1
    assert a["issue_no"].split("/")[1] == fy()
    ret = SpareReturnService().return_to_store(a["id"], qty=1, reason="Wrong Part", user="sup")
    assert re.match(r"^RET/\d{4}-\d{2}/\d{4}$", ret["return_no"]), ret["return_no"]
    # A count or receipt gets no issue number.
    assert SpareStockLedger.query.filter(SpareStockLedger.part_id == p.id,
                                         SpareStockLedger.txn_type != "ISSUE",
                                         SpareStockLedger.issue_no.isnot(None)).count() == 0
