"""RGP status (the store, 12 Nov 2026: "issue hokar jo bhi part ja rha h spare part
store se wo sabhi" — kab bani, kitne part, qty, kitni close huyi, kitni pending,
kitne din se). Every challan of this plant made from an issue slip for a
spare-store part, any party; what came back is the party's GRN of the same part
dated on / after the challan, the oldest challan first (ERP's GRN carries no RGP
no. — the app's match until IT's RGP receiving detail)."""
from datetime import date

import pytest

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.services.job_work_service import RECEIPTS_KEY, JobWorkService

STORE = "MAINTENANCE"
TODAY = date(2026, 11, 12)
_n = {"n": 0}
jobs = JobWorkService()


@pytest.fixture(autouse=True)
def _clean():
    yield
    AppSetting.query.filter_by(key=RECEIPTS_KEY).delete()
    ReceivingRegister.query.filter(ReceivingRegister.grn_no.like("RGPT-%")).delete(synchronize_session=False)
    db.session.commit()


def _part(store=STORE):
    _n["n"] += 1
    p = Part(part_no=f"RGPT-{_n['n']}", part_name="UPPER RAIL BENDING INSERT", uom="NOS", part_type="OTHER",
             store_code=store)
    db.session.add(p)
    db.session.commit()
    return p


def _line(item, no, day, qty, party, slip="26-27/001IS7762", status="EXITED"):
    return {"id": None, "challan_no": no, "challan_dt": day.strftime("%d-%m-%Y"), "challan_type": "General FOC",
            "party_cd": party, "party_name": f"PARTY {party}", "status": status, "target_date": None,
            "gate_exit_no": None, "doc_no": slip, "item_cd": item, "item_desc": "INSERT - COATING", "uom": "NOS",
            "qty": str(qty)}


def _rgp(summary, no):
    return next(r for r in summary["rows"] if r["challan_no"] == no)


def test_each_issue_slip_rgp_shows_sent_back_pending_and_days():
    p, q = _part(), _part()
    party = f"VR-{_n['n']}"
    a, b = f"FO001/{_n['n']}1/26-27", f"FO001/{_n['n']}2/26-27"
    rows = [
        _line(p.part_no, a, date(2026, 9, 1), 3, party),
        _line(q.part_no, a, date(2026, 9, 1), 2, party),
        _line(p.part_no, b, date(2026, 10, 1), 2, party, slip="26-27/001IS8022"),
        _line(p.part_no, f"FO001/{_n['n']}3/26-27", date(2026, 10, 2), 4, party, slip=None),        # no issue slip
        _line(p.part_no, f"FO002/{_n['n']}4/26-27", date(2026, 10, 3), 4, party),                   # Plant 2
        _line(p.part_no, f"FO001/{_n['n']}5/26-27", date(2026, 10, 4), 4, party, status="CANCEL"),  # cancelled
        _line("NOT-A-SPARE", f"FO001/{_n['n']}6/26-27", date(2026, 10, 5), 4, party),               # not in Part Master
    ]
    grns = [
        [party, p.part_no, "RGPT-SR0", "2026-08-25", "5"],    # before the challan: not its return
        [party, p.part_no, "RGPT-SR1", "05-09-2026", "3"],
        [party, q.part_no, "RGPT-SR3", "2026-09-10", "2"],
        [party, p.part_no, "RGPT-SR2", "2026-10-05", "1"],
        ["OTHER", p.part_no, "RGPT-SR9", "2026-10-06", "9"],  # another party
    ]
    jobs.sync(rows=rows, grns=grns)
    out = jobs.rgp_summary(today=TODAY)
    mine = [r for r in out["rows"] if r["party_cd"] == party]
    assert [r["challan_no"] for r in mine] == [b, a]          # open first, then closed
    first, second = _rgp(out, a), _rgp(out, b)
    assert (first["parts"], first["qty"], first["back"], first["pending"], first["state"]) == (2, 5, 5, 0, "CLOSED")
    assert first["last_return"] == "2026-09-10" and first["days_taken"] == 9 and first["days_open"] is None
    assert first["issue_slips"] == ["26-27/001IS7762"] and first["challan_date"] == "2026-09-01"
    line = next(x for x in first["lines"] if x["part_no"] == p.part_no)
    assert line["grns"] == [{"grn_no": "RGPT-SR1", "grn_date": "2026-09-05", "qty": 3}]
    assert (second["qty"], second["back"], second["pending"], second["state"]) == (2, 1, 1, "PART_BACK")
    assert second["days_open"] == 42 and second["issue_slips"] == ["26-27/001IS8022"]
    party_row = next(x for x in out["parties"] if x["party_cd"] == party)
    assert (party_row["rgps"], party_row["open"], party_row["qty"], party_row["back"], party_row["pending"]) == (2, 1, 7, 6, 1)
    assert out["totals"]["open"] >= 1 and out["totals"]["oldest_days"] >= 42


def test_the_grn_mirror_fills_in_a_newer_return_and_a_grn_is_never_counted_twice():
    p = _part()
    party = f"VR-{_n['n']}"
    no = f"FO001/{_n['n']}7/26-27"
    rows = [_line(p.part_no, no, date(2026, 10, 1), 3, party)]
    jobs.sync(rows=rows, grns=[[party, p.part_no, "RGPT-SR5", "2026-10-03", "1"]])
    assert _rgp(jobs.rgp_summary(today=TODAY), no)["pending"] == 2
    # The same GRN in the mirror too, and a newer one only there.
    db.session.add_all([
        ReceivingRegister(store_code="CHILD_PART", grn_no="RGPT-SR5", grn_date=date(2026, 10, 3), item_cd=p.part_no,
                          ven_cd=party, receipt_qty=1),
        ReceivingRegister(store_code="CHILD_PART", grn_no="RGPT-SR6", grn_date=date(2026, 11, 2), item_cd=p.part_no.lower(),
                          ven_cd=party, receipt_qty=2),
    ])
    db.session.commit()
    rgp = _rgp(jobs.rgp_summary(today=TODAY), no)
    assert (rgp["back"], rgp["pending"], rgp["state"], rgp["last_return"]) == (3, 0, "CLOSED", "2026-11-02")
    assert rgp["days_taken"] == 32
    # A read with rows handed in and no GRNs keeps the GRNs read before.
    jobs.sync(rows=rows)
    assert AppSetting.get_value(RECEIPTS_KEY)["grns"] == [[party, p.part_no, "RGPT-SR5", "2026-10-03", 1.0]]


def test_the_rgp_status_route():
    from flask import current_app

    from app.models.user import User, UserStoreAccess
    p = _part()
    party = f"VR-{_n['n']}"
    jobs.sync(rows=[_line(p.part_no, f"FO001/{_n['n']}8/26-27", date(2026, 11, 1), 1, party)], grns=[])
    client = current_app.test_client()
    user = User(username=f"rgpview{_n['n']}", role="STORE_USER", is_active=True)
    user.set_password("pw")
    user.set_permissions({"scan_part": {"view": True}})
    db.session.add(user)
    db.session.flush()
    db.session.add(UserStoreAccess(user_id=user.id, store_code=STORE))
    db.session.commit()
    with client.session_transaction() as sess:
        sess["user_id"] = user.id
    resp = client.get("/api/v1/job-work/rgp/summary")
    assert resp.status_code == 200, resp.get_json()
    data = resp.get_json()["data"]
    assert any(r["party_cd"] == party and r["state"] == "OPEN" for r in data["rows"])
    assert {"rows", "parties", "totals", "grns_read_at", "today"} <= set(data)


def test_before_any_grn_read_is_kept_the_status_reads_erp_itself_and_saves_nothing(monkeypatch):
    p = _part()
    party = f"VR-{_n['n']}"
    no = f"FO001/{_n['n']}9/26-27"
    jobs.sync(rows=[_line(p.part_no, no, date(2025, 7, 9), 2, party)])     # rows handed in: no GRN read kept
    assert AppSetting.get_value(RECEIPTS_KEY) is None
    asked = []

    def read(parties, items):
        asked.append((sorted(parties), sorted(items)))
        return [[party, p.part_no, "RGPT-SR7", "15-07-2025", "2"]]
    monkeypatch.setattr(JobWorkService, "_read_returns", staticmethod(read))
    rgp = _rgp(jobs.rgp_summary(today=TODAY), no)
    assert (rgp["back"], rgp["state"]) == (2, "CLOSED") and party in asked[0][0]   # other tests' parties may be read too
    assert AppSetting.get_value(RECEIPTS_KEY) is None                       # nothing saved by a read of the page

    def down(parties, items):
        raise RuntimeError("ERP not reachable")
    monkeypatch.setattr(JobWorkService, "_read_returns", staticmethod(down))
    assert _rgp(jobs.rgp_summary(today=TODAY), no)["state"] == "OPEN"       # the mirror alone, no error
