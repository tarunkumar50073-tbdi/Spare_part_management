"""Consumption Analytics (/api/v1/consumption-analytics).

The session DB is shared, so every test works in its own section, on parts with
a CA- prefix, and in the late 1990s — dates no other test writes to. Issues are
stamped at 12:00 UTC so they land on the same plant day whatever the server's
offset. Each test that needs "the ledger covers this window" plants its own
OPENING row before the window; the store's first ledger row can only be as
early or earlier, which is all coverage needs.
"""
from datetime import date, datetime, timedelta

import pytest

from app.extensions import db
from app.models.part import Part
from app.models.spare_stock import SpareStockLedger
from app.models.store import Section, Store
from app.models.user import User, UserStoreAccess
from app.services.consumption_analytics_service import (
    ConsumptionAnalyticsService, _weeks_ending, detect_spikes,
)

STORE = "MAINTENANCE"
URL = "/api/v1/consumption-analytics"
_seq = {"n": 0}


def _n():
    _seq["n"] += 1
    return _seq["n"]


def _section():
    store = Store.query.filter_by(code=STORE).first()
    s = Section(store_id=store.id, name=f"CA Section {_n()}")
    db.session.add(s)
    db.session.commit()
    return s


def _part(sec, tag, rate=None, sub=None, store=STORE):
    p = Part(part_no=f"CA-{_n()}-{tag}", part_name=f"Consumption {tag}", uom="NO", part_type="OTHER",
             store_code=store, section_id=sec.id if sec else None, unit_price=rate, sub_category=sub)
    db.session.add(p)
    db.session.commit()
    return p


def _row(part, qty, day, txn="ISSUE", dept=None, machine=None, status=None):
    db.session.add(SpareStockLedger(
        part_id=part.id, qty_delta=-qty if txn == "ISSUE" else qty, balance_after=0, txn_type=txn,
        department=dept, machine=machine, status=status,
        created_at=datetime.combine(day, datetime.min.time()) + timedelta(hours=12)))
    db.session.commit()


svc = ConsumptionAnalyticsService()


@pytest.fixture()
def march_1998():
    """Window 1998-03-01..03-10 (10 days); previous 1998-02-19..02-28.

        A  rate 10, type "CA Sensor"   3 on 03-01 (Tool Room, Press 1), 2 on 03-05 (Maintenance),
                                       5 on 02-20 (previous), 7 on 03-11 (after the window)
        B  no rate, type "CA Belt"     4 on 03-10 (Tool Room)
    """
    sec = _section()
    a = _part(sec, "A", rate=10, sub="CA Sensor")
    b = _part(sec, "B", sub="CA Belt")
    _row(a, 100, date(1998, 1, 5), txn="OPENING")
    _row(a, 3, date(1998, 3, 1), dept="Tool Room", machine="Press 1")
    _row(a, 2, date(1998, 3, 5), dept="Maintenance")
    _row(a, 5, date(1998, 2, 20), dept="Tool Room")
    _row(a, 7, date(1998, 3, 11), dept="Tool Room")
    _row(b, 4, date(1998, 3, 10), dept="Tool Room")
    return sec, a, b


def _run(sec, **kw):
    return svc.analytics(STORE, date_from=kw.pop("f", "1998-03-01"), date_to=kw.pop("t", "1998-03-10"),
                         section_id=sec.id, **kw)


def test_window_previous_and_change(march_1998):
    sec, a, b = march_1998
    r = _run(sec, granularity="day")

    assert r["window"] == {"from": "1998-03-01", "to": "1998-03-10", "days": 10, "granularity": "day",
                           "today": r["window"]["today"], "clamped_to_today": False, "ends_today": False}
    assert r["previous_window"] == {"from": "1998-02-19", "to": "1998-02-28", "days": 10}
    cur, prev = r["current"], r["previous"]
    assert (cur["qty"], cur["lines"], cur["parts"], cur["value"], cur["unvalued_lines"]) == (9.0, 3, 2, 50.0, 1)
    assert (prev["qty"], prev["lines"], prev["parts"], prev["value"]) == (5.0, 1, 1, 50.0)
    assert cur["coverage"] == "full" and prev["coverage"] == "full"
    # B has no rate, so this window's value is short a line the previous one
    # never had: no value % — it would measure rates, not usage.
    assert prev["change_pct"] == {"qty": 80.0, "lines": 200.0, "parts": 100.0, "value": None}
    assert prev["change_note"] is None
    assert prev["value_note"].startswith("1 of 3 issue lines in this window and 0 of 1 in the previous one")
    assert "not netted" in r["basis"]["quantity"] and "today's rate" in r["basis"]["value"]

    top = r["top_parts"]
    assert [t["part_id"] for t in top] == [a.id, b.id]
    assert (top[0]["qty"], top[0]["lines"], top[0]["value"], top[0]["share_pct"]) == (5.0, 2, 50.0, 55.6)
    assert top[1]["value"] is None            # no rate -> no value, not zero
    assert r["issued_parts"] == 2

    dept = {d["name"]: d for d in r["by_department"]}
    assert dept["Tool Room"]["qty"] == 7.0 and dept["Maintenance"]["qty"] == 2.0
    assert [d["name"] for d in r["by_department"]] == ["Tool Room", "Maintenance"]
    assert r["by_section"] == [{"name": sec.name, "key": sec.id, "qty": 9.0, "lines": 3, "parts": 2,
                                "value": 50.0, "unvalued_lines": 1}]
    assert {t["name"]: t["qty"] for t in r["by_type"]} == {"CA Sensor": 5.0, "CA Belt": 4.0}
    machines = {m["name"]: m for m in r["by_machine"]}
    assert machines["Press 1"]["qty"] == 3.0 and machines["Press 1"]["key"] == "Press 1"
    assert machines["Not recorded"]["qty"] == 6.0 and machines["Not recorded"]["key"] is None


def test_series_is_zero_filled_and_previous_aligned(march_1998):
    sec, _, _ = march_1998
    days = _run(sec, granularity="day")["series"]
    assert len(days) == 10
    assert [d["qty"] for d in days] == [3, 0, 0, 0, 2, 0, 0, 0, 0, 4]
    # 02-20 is the 2nd day of the previous window -> laid over 03-02.
    assert [d["previous_qty"] for d in days] == [0, 5, 0, 0, 0, 0, 0, 0, 0, 0]
    assert days[1]["previous_from"] == "1998-02-20"
    assert all(d["coverage"] == "full" and d["previous_coverage"] == "full" for d in days)

    weeks = _run(sec, granularity="week")["series"]
    # 03-01 is a Sunday: a one-day first week, a full week, then a two-day tail.
    assert [(w["from"], w["to"]) for w in weeks] == [
        ("1998-03-01", "1998-03-01"), ("1998-03-02", "1998-03-08"), ("1998-03-09", "1998-03-10")]
    assert [w["qty"] for w in weeks] == [3, 2, 4]
    assert [w["previous_qty"] for w in weeks] == [0, 5, 0]

    months = _run(sec, granularity="month")["series"]
    assert [(m["label"], m["qty"], m["value"]) for m in months] == [("Mar 1998", 9.0, 50.0)]


def test_value_change_shown_when_every_line_is_rated(march_1998):
    sec, a, _ = march_1998
    r = _run(sec, part_id=a.id)                        # only A, which has a rate
    assert r["previous"]["change_pct"]["value"] == 0.0 and r["previous"]["value_note"] is None


def test_value_is_none_not_zero_when_no_line_has_a_rate(march_1998):
    sec, _, b = march_1998
    _row(b, 2, date(1998, 2, 25), dept="Tool Room")
    r = _run(sec, part_id=b.id)
    assert (r["current"]["qty"], r["current"]["value"], r["current"]["unvalued_lines"]) == (4.0, None, 1)
    assert (r["previous"]["qty"], r["previous"]["value"]) == (2.0, None)
    assert r["previous"]["change_pct"]["qty"] == 100.0 and r["previous"]["change_pct"]["value"] is None
    assert "no rate" in r["previous"]["value_note"]
    assert r["series"][-1]["value"] is None and r["series"][0]["value"] == 0.0   # nothing issued = measured 0
    assert r["by_section"][0]["value"] is None


def test_machine_awaiting_confirmation_is_not_missing_data():
    sec = _section()
    p = _part(sec, "M", rate=1)
    _row(p, 100, date(1998, 1, 5), txn="OPENING")
    _row(p, 2, date(1998, 6, 2), status="PENDING_USER_CONFIRMATION")
    _row(p, 1, date(1998, 6, 3), status="ISSUED_BY_STORE")
    _row(p, 4, date(1998, 6, 4), status="INSTALLED")
    _row(p, 5, date(1998, 6, 5), status="INSTALLED", machine="Press 9")
    r = svc.analytics(STORE, date_from="1998-06-01", date_to="1998-06-10", section_id=sec.id)
    machines = {(m["name"], m["key"]): m["qty"] for m in r["by_machine"]}
    assert machines == {("Press 9", "Press 9"): 5.0, ("Awaiting fitter's confirmation", None): 3.0,
                        ("Not recorded", None): 4.0}


def test_change_pct_is_none_on_a_zero_base(march_1998):
    sec, a, _ = march_1998
    _row(a, 1, date(1998, 4, 3), dept="Tool Room")
    r = _run(sec, f="1998-04-01", t="1998-04-10")
    assert r["current"]["qty"] == 1.0
    assert r["previous"]["qty"] == 0.0
    assert r["previous"]["change_pct"] == {"qty": None, "lines": None, "parts": None, "value": None}
    assert "nothing was issued" in r["previous"]["change_note"]


def test_filters(march_1998):
    sec, a, b = march_1998
    dept = _run(sec, department="  tool room ")            # trimmed, case-insensitive
    assert dept["current"]["qty"] == 7.0 and dept["filters"]["department"] == "tool room"
    assert dept["previous"]["qty"] == 5.0
    assert _run(sec, part_type="CA Belt")["current"]["qty"] == 4.0
    part = _run(sec, part_id=a.id)
    assert part["current"]["qty"] == 5.0
    assert (part["filters"]["part_no"], part["filters"]["section_name"]) == (a.part_no, sec.name)
    assert [t["part_id"] for t in part["top_parts"]] == [a.id]
    # Another section sees none of it.
    other = _section()
    assert svc.analytics(STORE, date_from="1998-03-01", date_to="1998-03-10",
                         section_id=other.id)["current"]["qty"] == 0.0


def test_uncategorised_type_matches_blank_sub_category():
    sec = _section()
    p = _part(sec, "U")
    _row(p, 100, date(1998, 1, 5), txn="OPENING")
    _row(p, 6, date(1998, 5, 4))
    r = svc.analytics(STORE, date_from="1998-05-01", date_to="1998-05-10",
                      section_id=sec.id, part_type="Uncategorised")
    assert r["current"]["qty"] == 6.0
    assert r["by_type"][0]["name"] == "Uncategorised"


def test_spikes_unavailable_before_eight_weeks_of_ledger():
    sec = _section()
    # The ledger's start is planted here, not left to whatever ran before: the
    # store's first row is then 1998-01-05 or earlier — still years after the window.
    _row(_part(sec, "S"), 1, date(1998, 1, 5), txn="OPENING")
    r = svc.analytics(STORE, date_from="1990-01-01", date_to="1990-01-31", section_id=sec.id)
    sp = r["spikes"]
    assert sp["available"] is False and sp["items"] == []
    assert sp["reason"].startswith("needs 8+ weeks of issue history; the app's ledger starts")
    # Nothing measured: not "zero issued, 0% change".
    assert r["current"]["coverage"] == "none"
    assert all(v is None for v in r["previous"]["change_pct"].values())
    assert "before the app's ledger" in r["previous"]["change_note"]
    assert all(s["coverage"] == "none" for s in r["series"])


def test_detect_spikes_needs_eight_covered_weeks():
    end = date(2026, 9, 27)                                   # a Sunday
    weeks = _weeks_ending(end)
    assert len(weeks) == 12 and weeks[-1] == (date(2026, 9, 21), date(2026, 9, 27))
    weekly = {1: {"info": {"part_no": "X"}, "weeks": [1.0] * 11 + [50.0]}}

    short = detect_spikes(weekly, weeks, since=weeks[-7][0])   # 7 covered weeks
    assert short["available"] is False and short["weeks_available"] == 7
    assert short["reason"] == f"needs 8+ weeks of issue history; the app's ledger starts {weeks[-7][0].isoformat()}"
    assert detect_spikes(weekly, weeks, since=None)["reason"].endswith("the app's ledger has no rows yet")
    # A ledger that starts mid-week does not count that week.
    assert detect_spikes(weekly, weeks, since=weeks[-8][0] + timedelta(days=1))["available"] is False

    eight = detect_spikes(weekly, weeks, since=weeks[-8][0])
    assert eight["available"] is True and eight["baseline_weeks"] == 7
    assert eight["items"][0]["last_week_qty"] == 50.0 and eight["items"][0]["mean"] == 1.0


def test_week_running_today_is_not_a_full_week():
    sunday = date(2026, 9, 27)
    # Sunday is today: issues are still coming in, so the last full week is the one before.
    assert _weeks_ending(sunday, today=sunday)[-1] == (date(2026, 9, 14), date(2026, 9, 20))
    # Once Sunday is over, its week counts.
    assert _weeks_ending(sunday, today=sunday + timedelta(days=1))[-1] == (date(2026, 9, 21), sunday)
    assert _weeks_ending(date(2026, 9, 23), today=date(2026, 9, 23))[-1] == (date(2026, 9, 14), date(2026, 9, 20))


def test_spike_detected_with_long_history():
    """Twelve Monday–Sunday weeks, 1997-01-06 .. 1997-03-30 (a Sunday).

        C  2/3 alternating for 11 weeks, then 20  -> spike
        D  2/3 alternating for 11 weeks, then 3   -> normal
        E  nothing for 11 weeks, then 9           -> no baseline (mean 0), not a spike
    """
    sec = _section()
    c, d, e = _part(sec, "C", rate=5), _part(sec, "D"), _part(sec, "E")
    first_monday = date(1997, 1, 6)
    _row(c, 500, first_monday, txn="OPENING")
    for w in range(11):
        monday = first_monday + timedelta(weeks=w)
        _row(c, 2 + w % 2, monday + timedelta(days=2))
        _row(d, 2 + w % 2, monday + timedelta(days=3))
    last_monday = first_monday + timedelta(weeks=11)
    _row(c, 12, last_monday)
    _row(c, 8, last_monday + timedelta(days=6))               # Sunday — still the same week
    _row(d, 3, last_monday + timedelta(days=1))
    _row(e, 9, last_monday + timedelta(days=4))

    r = svc.analytics(STORE, date_from="1997-03-01", date_to="1997-03-30", section_id=sec.id)
    sp = r["spikes"]
    assert sp["available"] is True
    assert sp["baseline_weeks"] == 11
    assert sp["last_week"] == {"from": "1997-03-24", "to": "1997-03-30"}
    assert [i["part_id"] for i in sp["items"]] == [c.id]
    hit = sp["items"][0]
    assert hit["last_week_qty"] == 20.0 and hit["mean"] == round(27 / 11, 2)
    assert hit["threshold"] < 20 and len(hit["weekly"]) == 12

    # A window ending mid-week judges the last FULL week (the one before).
    mid = svc.analytics(STORE, date_from="1997-03-01", date_to="1997-03-28", section_id=sec.id)["spikes"]
    assert mid["available"] is True and mid["last_week"]["to"] == "1997-03-23"
    assert mid["items"] == []


def test_default_window_and_clamp_to_today():
    sec = _section()
    r = svc.analytics(STORE, section_id=sec.id)
    today = date.fromisoformat(r["window"]["today"])
    assert r["window"]["to"] == today.isoformat() and r["window"]["days"] == 30
    assert r["window"]["from"] == (today - timedelta(days=29)).isoformat()
    assert r["window"]["granularity"] == "day" and r["window"]["ends_today"] is True

    ahead = svc.analytics(STORE, date_from=(today - timedelta(days=6)).isoformat(),
                          date_to=(today + timedelta(days=10)).isoformat(), section_id=sec.id)
    assert ahead["window"]["to"] == today.isoformat() and ahead["window"]["clamped_to_today"] is True
    assert len(ahead["series"]) == 7


# ------------------------------------------------------------------ the API

@pytest.fixture()
def client(app):
    return app.test_client()


def _login(client, role="STORE_USER", perms=None, store_access=True):
    u = User(username=f"causer{_n()}", role=role, is_active=True)
    u.set_password("pw")
    if perms:
        u.set_permissions(perms)
    db.session.add(u)
    db.session.flush()
    if store_access:
        db.session.add(UserStoreAccess(user_id=u.id, store_code=STORE))
    db.session.commit()
    with client.session_transaction() as s:
        s["user_id"] = u.id
    return client


VIEW = {"spare_store": {"view": True}}


def test_endpoint_ok_and_filters(client, march_1998):
    sec, a, _ = march_1998
    c = _login(client, perms=VIEW)
    r = c.get(f"{URL}?store_code={STORE}&from=1998-03-01&to=1998-03-10&granularity=week"
              f"&section_id={sec.id}&department=Tool%20Room")
    assert r.status_code == 200
    body = r.get_json()["data"]
    assert body["current"]["qty"] == 7.0 and body["window"]["granularity"] == "week"
    assert {"current", "previous", "series", "top_parts", "by_department", "by_section", "by_type",
            "by_machine", "spikes", "filters", "ledger_since", "basis"} <= set(body)

    r = c.get(f"{URL}?store_code={STORE}&from=1998-03-01&to=1998-03-10&part_id={a.id}&type=CA%20Sensor")
    assert r.get_json()["data"]["current"]["qty"] == 5.0


@pytest.mark.parametrize("query", [
    "from=1998-13-01",                         # not a date
    "from=1998-03-10&to=1998-03-01",           # backwards
    "from=1990-01-01&to=1991-02-05",           # 401 days
    "granularity=hour",
    "section_id=abc",
    "part_id=1.5",
])
def test_endpoint_rejects_bad_input(client, query):
    c = _login(client, perms=VIEW)
    assert c.get(f"{URL}?store_code={STORE}&{query}").status_code == 400


def test_endpoint_needs_store_code(client):
    c = _login(client, perms=VIEW)
    assert c.get(URL).status_code == 400


def test_endpoint_permission_and_store_access(client):
    assert _login(client).get(f"{URL}?store_code={STORE}").status_code == 403           # no spare_store right
    no_store = _login(client, perms=VIEW, store_access=False)
    assert no_store.get(f"{URL}?store_code={STORE}").status_code == 403                  # not this store
    assert no_store.get(f"{URL}/options?store_code={STORE}").status_code == 403


def test_endpoint_part_of_another_store_is_404(client):
    other = _part(None, "X", store="CHILD_PART")
    c = _login(client, role="ADMIN")
    assert c.get(f"{URL}?store_code={STORE}&part_id={other.id}").status_code == 404


def test_options(client, march_1998):
    sec, _, _ = march_1998
    c = _login(client, perms=VIEW)
    r = c.get(f"{URL}/options?store_code={STORE}")
    assert r.status_code == 200
    body = r.get_json()["data"]
    assert {"id": sec.id, "name": sec.name} in body["sections"]
    assert {"CA Sensor", "CA Belt"} <= {t["name"] for t in body["types"]}
    assert {"Tool Room", "Maintenance"} <= set(body["departments"])
