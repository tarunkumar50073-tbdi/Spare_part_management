"""Part returns by type, job work returns and ERP's RGPs (the store's spec of 27
Oct 2026: "Part Return, Job Work Return & Pending RGP Integration"). The spec's
acceptance tests are numbered."""
from datetime import date, datetime, timedelta, timezone

import pytest

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.job_work import ErpRgpLine, RgpReturnLink
from app.models.part import Part
from app.models.spare_flow import SpareReturn, SpareRgp
from app.models.spare_packet import SparePacket
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.models.user import User, UserStoreAccess
from app.services.barcode_service import BarcodeService
from app.services.consumption_table_service import ConsumptionTableService
from app.services.job_work_service import SETTING_KEY, JobWorkService
from app.services.spare_packet_service import SparePacketService
from app.services.spare_return_service import SpareReturnService
from app.services.spare_stock_service import SpareStockService
from app.utils.exceptions import BadRequestError

STORE = "MAINTENANCE"
DEPT = "Maintenance"
_seq = {"n": 0}
packets, returns, jobs = SparePacketService(), SpareReturnService(), JobWorkService()


def _part(qty):
    _seq["n"] += 1
    p = Part(part_no=f"JW-{_seq['n']}-{datetime.now().microsecond}", part_name=f"BOLT M8 {_seq['n']}", uom="NOS",
             part_type="OTHER", store_code=STORE, location=f"R9-S1-B{_seq['n']}")
    db.session.add(p)
    db.session.commit()
    SpareStockService().set_quantity(p.id, qty, txn_type="OPENING")
    return p


def _on_hand(p):
    return float(SpareStock.query.filter_by(part_id=p.id).first().qty_on_hand)


def _packet_issued(qty=20, kind="PACKET"):
    """A part with `qty` on the shelf packed as one packet (or one unit) and issued whole."""
    p = _part(qty)
    batch = packets.opening_receipt(p.id, qty, user="sup")
    made = packets.pack(batch["id"], kind, packet_qty=qty if kind == "PACKET" else None, user="sup")["packets"]
    code = made[0]["code"]
    out = packets.issue(code, DEPT, user="store", issued_to="Ravi")
    return p, code, out["issue"]["id"]


def _issued(qty=3, stock=10):
    p = _part(stock)
    lid = SpareStockService().issue(p.id, qty, DEPT, user="store", issued_to="Ravi")["issue"]["id"]
    return p, lid


def _user(perms):
    _seq["n"] += 1
    u = User(username=f"jwuser{_seq['n']}", role="STORE_USER", is_active=True)
    u.set_password("pw-jobwork-1")
    u.set_permissions(perms)
    db.session.add(u)
    db.session.flush()
    db.session.add(UserStoreAccess(user_id=u.id, store_code=STORE))
    db.session.commit()
    return u


def _as(client, u):
    with client.session_transaction() as s:
        s["user_id"] = u.id


# ---- 1, 2, 11, 13: the unused packet comes back whole, once --------------------------------------

def test_1_2_11_13_an_unused_packet_comes_back_whole_once_after_the_count(app):
    p, code, issue_id = _packet_issued(20)
    assert _on_hand(p) == 0
    c = app.test_client()
    _as(c, _user({"scan_part": {"view": True, "create": True}}))
    url = f"/api/v1/spare-stock/issues/{issue_id}/return"
    # Not counted yet: refused, no stock.
    r = c.post(url, json={"qty": 20, "reason": "Size does not fit", "return_type": "UNUSED_RETURN"})
    assert r.status_code == 400 and _on_hand(p) == 0
    # Part of a packet: refused.
    r = c.post(url, json={"qty": 5, "reason": "Size does not fit", "return_type": "UNUSED_RETURN", "verified": True})
    assert r.status_code == 400 and "only whole" in r.get_json()["message"] and _on_hand(p) == 0
    r = c.post(url, json={"qty": 20, "reason": "Size does not fit", "return_type": "UNUSED_RETURN", "verified": True,
                          "identified_by": "QR", "scanned_code": code})
    assert r.status_code == 200 and _on_hand(p) == 20
    ret = SpareReturn.query.filter_by(issue_id=issue_id).one()
    assert (ret.return_type, ret.status, ret.identified_by, ret.verified_by is not None) == ("UNUSED_RETURN", "CLOSED", "QR", True)
    pk = SparePacket.query.filter_by(code=code).one()
    assert (pk.status, ret.packet_id) == ("AVAILABLE", pk.id)                       # the same QR, on the shelf again
    assert packets.figures(p.id) == {"on_hand": 20, "packed_available": 20, "loose": 0}
    # 11: sent again — nothing is left out on that issue, no second credit.
    r = c.post(url, json={"qty": 20, "reason": "Size does not fit", "return_type": "UNUSED_RETURN", "verified": True})
    assert r.status_code == 400 and _on_hand(p) == 20 and SpareReturn.query.filter_by(issue_id=issue_id).count() == 1
    # 13: the issue row and the packet's receipt batch are still there.
    issue = db.session.get(SpareStockLedger, issue_id)
    assert (issue.txn_type, issue.reference, issue.status) == ("ISSUE", code, "RETURNED")
    assert pk.batch_id == packets.get(code)["receipt"]["id"]
    # The packet can be issued again, whole.
    assert packets.issue(code, DEPT, user="store", issued_to="Ravi")["issue"]["qty"] == 20 and _on_hand(p) == 0


# ---- 3, 4, 5, 6: job work return -------------------------------------------------------------------

def test_3_4_5_6_a_job_work_return_is_linked_to_its_issue_and_never_stock():
    p, code, issue_id = _packet_issued(1, kind="UNIT")
    rgps_before = SpareRgp.query.count()
    scan = BarcodeService().resolve(STORE, code, user="tester")                 # its existing QR
    assert scan["packet"]["issue_ledger_id"] == issue_id
    with pytest.raises(BadRequestError, match="job work"):
        returns.job_work_return(issue_id, 1, reason=None, user="store")
    out = returns.job_work_return(issue_id, 1, reason="Worn out", returned_by="AMAN", user="store",
                                  scanned_code=code, scan_source="CAMERA_SCAN", identified_by="QR")
    assert (out["return_type"], out["status"], out["qty_rgp"], out["issue_id"]) == ("JOB_WORK_RETURN", "JOB_WORK", 1, issue_id)
    assert _on_hand(p) == 0                                                         # 5: not stock
    assert SparePacket.query.filter_by(code=code).one().status == "ISSUED"           # not on the shelf
    assert SpareRgp.query.count() == rgps_before                                     # 6: no RGP made here
    # 4: no inspection waits on it.
    ret = db.session.get(SpareReturn, out["id"])
    assert ret.q("qty_pending") + ret.q("qty_hold") + ret.q("qty_damaged") == 0
    with pytest.raises(BadRequestError):
        returns.job_work_return(issue_id, 1, reason="Worn out", user="store")       # nothing left out
    state = jobs.returns(STORE, q=ret.return_no)["rows"][0]
    assert state["state"] in ("PENDING_RGP", "SYNC_FAILED")


def test_a_job_work_return_still_counts_as_consumed():
    p, issue_id = _issued(qty=3, stock=10)
    day = date.today().isoformat()
    before = ConsumptionTableService().table(STORE, "part", day, day, part_id=p.id)["rows"][0]
    returns.job_work_return(issue_id, 2, reason="Damaged", user="store")
    after = ConsumptionTableService().table(STORE, "part", day, day, part_id=p.id)["rows"][0]
    assert (before["Net Qty"], after["Net Qty"]) == (3, 3)
    p2, issue2 = _issued(qty=3, stock=10)
    returns.return_to_store(issue2, 2, reason="Not required", user="store", verified_by="sup")
    assert ConsumptionTableService().table(STORE, "part", day, day, part_id=p2.id)["rows"][0]["Net Qty"] == 1


# ---- 7, 8, 9, 10: ERP's RGPs and the link ----------------------------------------------------------

def _rgp(challan, item, qty, day, status="HOLD", party="REPAIR WORKS"):
    return {"id": None, "challan_no": challan, "challan_dt": day.strftime("%d-%m-%Y"), "challan_type": "General FOC",
            "party_cd": "P1", "party_name": party, "status": status, "target_date": None, "gate_exit_no": None,
            "doc_no": None, "item_cd": item, "item_desc": "PUMP SEAL", "uom": "NOS", "qty": str(qty)}


def test_7_8_9_10_challans_read_from_erp_linked_by_themselves_and_never_twice():
    """27 Oct 2026: spares go out on ERP's "General FOC" returnable challan
    (made from the issue slip), and a waiting return is linked to its challan
    by itself ("Apne aap jode"); a person can unlink and pick another."""
    p, issue_id = _issued(qty=1, stock=2)
    ret = returns.job_work_return(issue_id, 1, reason="Seal leaking", user="store")
    today = date.today()
    tag = p.part_no
    rows = [_rgp(f"RG/{tag}/1", p.part_no, 1, today), _rgp(f"RG/{tag}/2", p.part_no.lower(), 1, today, party="OTHER CO"),
            _rgp(f"RG/{tag}/3", p.part_no, 1, today - timedelta(days=30)),           # before the return
            _rgp(f"RG/{tag}/4", p.part_no, 1, today, status="CANCEL")]
    st = jobs.sync(rows=rows)                                                         # 7: read (rows as ERP gives them)
    assert st["ok"] is True and ErpRgpLine.query.filter(ErpRgpLine.challan_no.like(f"RG/{tag}/%")).count() == 4
    # 9: linked by itself to the first fitting line — never the earlier or the cancelled one.
    row = jobs.returns(STORE, q=ret["return_no"])["rows"][0]
    assert row["state"] == "RGP_LINKED"
    assert (row["link"]["rgp"]["challan_no"], row["link"]["linked_by"]) == (f"RG/{tag}/1", "Auto (ERP challan)")
    # A wrong one is unlinked by a person: both fitting lines are offered and
    # the next read does not link it again by itself.
    jobs.unlink(ret["id"], user="sup")
    jobs.sync(rows=rows)
    cand = jobs.candidates(ret["id"])
    assert sorted(x["challan_no"] for x in cand["suggested"]) == [f"RG/{tag}/1", f"RG/{tag}/2"]
    row = jobs.returns(STORE, q=ret["return_no"])["rows"][0]
    assert (row["state"], row["suggested"], row["link"]) == ("RGP_AVAILABLE", 2, None)
    # 8: the store person picks the right one.
    pick = next(x for x in cand["suggested"] if x["challan_no"] == f"RG/{tag}/2")
    out = jobs.link(ret["id"], pick["id"], user="sup")
    assert out["link"]["rgp"]["challan_no"] == f"RG/{tag}/2" and out["link"]["linked_by"] == "sup"
    assert jobs.returns(STORE, q=ret["return_no"])["rows"][0]["state"] == "RGP_LINKED"
    # The same line cannot go to a second return.
    p2, issue2 = _issued(qty=1, stock=2)
    ret2 = returns.job_work_return(issue2, 1, reason="Worn", user="store")
    with pytest.raises(BadRequestError, match="already linked"):
        jobs.link(ret2["id"], pick["id"], user="sup")
    # 10: reading ERP again (a status changed) makes no second line and keeps the link.
    rows[1]["status"] = "EXITED"
    jobs.sync(rows=rows)
    jobs.sync(rows=rows)
    assert ErpRgpLine.query.filter(ErpRgpLine.challan_no.like(f"RG/{tag}/%")).count() == 4
    assert RgpReturnLink.query.filter_by(return_id=ret["id"]).one().rgp.status == "EXITED"
    # A line gone from ERP's read is dropped, unless a return holds it.
    jobs.sync(rows=[rows[1]])
    assert [l.challan_no for l in ErpRgpLine.query.filter(ErpRgpLine.challan_no.like(f"RG/{tag}/%"))] == [f"RG/{tag}/2"]


def test_the_erp_read_asks_for_returnable_foc_challans_of_spare_parts_only():
    from app.services import job_work_service as jw
    assert "challan_type = %s AND upper(exit_type) = %s" in jw._SQL and "ANY(%s)" in jw._SQL
    assert (jw.FOC_TYPE, jw.RETURNABLE) == ("General FOC", "RETURNABLE")


def test_an_erp_read_failure_keeps_everything_and_says_so(monkeypatch):
    p, issue_id = _issued(qty=1, stock=2)
    ret = returns.job_work_return(issue_id, 1, reason="Broken", user="store")
    lines = ErpRgpLine.query.count()

    def down():
        raise ConnectionError("ERP not reachable")
    monkeypatch.setattr(JobWorkService, "_read_erp", staticmethod(down))
    st = jobs.sync()
    assert st["ok"] is False and "ERP not reachable" in st["last_error"] and ErpRgpLine.query.count() == lines
    assert jobs.returns(STORE, q=ret["return_no"])["rows"][0]["state"] == "SYNC_FAILED"
    AppSetting.set_value(SETTING_KEY, {**AppSetting.get_value(SETTING_KEY), "ok": True}, "test")


# ---- 12: scanning or reprinting a label moves no stock ---------------------------------------------

def test_12_scanning_a_returned_packet_moves_no_stock():
    p, code, issue_id = _packet_issued(10)
    returns.return_to_store(issue_id, 10, reason="Not required", user="store", verified_by="sup")
    before = _on_hand(p)
    BarcodeService().resolve(STORE, code, user="tester")
    packets.record_print([code], reprint=True, reason="Label torn", user="sup")
    assert _on_hand(p) == before == 10


def test_job_work_routes_rights(app):
    p, issue_id = _issued(qty=1, stock=2)
    ret = returns.job_work_return(issue_id, 1, reason="Worn", user="store")
    c = app.test_client()
    _as(c, _user({"scan_part": {"view": True}}))
    body = c.get("/api/v1/job-work/returns", query_string={"store_code": STORE, "q": ret["return_no"]}).get_json()["data"]
    assert [r["return_no"] for r in body["rows"]] == [ret["return_no"]] and "sync" in body
    assert c.post(f"/api/v1/job-work/returns/{ret['id']}/link", json={"rgp_line_id": 1}).status_code == 403
