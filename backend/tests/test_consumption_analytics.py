"""Consumption Analytics (/api/v1/consumption-analytics).

The session DB is shared, so every test works in its own section, on parts with
a CA- prefix, and in the late 1990s — dates no other test writes to. Issues are
stamped at 12:00 UTC so they land on the same plant day whatever the server's
offset. Each test that needs "the ledger covers this window" plants its own
OPENING row before the window; the store's first ledger row can only be as
early or earlier, which is all coverage needs.

The department of a breakdown, a filter and the filter bar is the one that
CONSUMES the part — the owner of its section — never the one typed on the
issue (the store's rule, 14 Oct 2026). The CA sections are owned by no
department, so their parts count under the section's own name; the tests of
the rule itself build their own store and departments (CA-<n>) and remove the
departments afterwards.
"""
from datetime import date, datetime, timedelta

import pytest

from app.extensions import db
from app.models.department import Department
from app.models.part import Part
from app.models.spare_stock import SpareStockLedger
from app.models.store import Section, Store
from app.models.user import User, UserStoreAccess
from app.services.consumption_analytics_service import (
    ConsumptionAnalyticsService, _weeks_ending, detect_spikes,
)
from app.utils.exceptions import BadRequestError

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


def _row(part, qty, day, txn="ISSUE", dept=None, machine=None, status=None, **place):
    """One ledger row at 12:00 UTC; `place` = line_name, line_no, die_no,
    confirmed_at as Confirm Installation writes them."""
    db.session.add(SpareStockLedger(
        part_id=part.id, qty_delta=-qty if txn == "ISSUE" else qty, balance_after=0, txn_type=txn,
        department=dept, machine=machine, status=status,
        created_at=datetime.combine(day, datetime.min.time()) + timedelta(hours=12), **place))
    db.session.commit()


svc = ConsumptionAnalyticsService()


@pytest.fixture()
def march_1998():
    """Window 1998-03-01..03-10 (10 days); previous 1998-02-19..02-28.

        A  rate 10, type "CA Sensor"   3 on 03-01 (Tool Room, Press 1), 2 on 03-05 (Maintenance),
                                       5 on 02-20 (previous), 7 on 03-11 (after the window)
        B  no rate, type "CA Belt"     4 on 03-10 (Tool Room)

    Tool Room / Maintenance are what the issues were TYPED with; the section,
    owned by no department, is who consumes them all.
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

    # Who consumes it (the section, no department owning it), not who it was typed to.
    assert r["by_department"] == [{"name": sec.name, "key": sec.name, "qty": 9.0, "lines": 3, "parts": 2,
                                   "value": 50.0, "unvalued_lines": 1}]
    assert "never the" in r["basis"]["department"]
    assert r["by_section"] == [{"name": sec.name, "key": sec.id, "qty": 9.0, "lines": 3, "parts": 2,
                                "value": 50.0, "unvalued_lines": 1}]
    assert {t["name"]: t["qty"] for t in r["by_type"]} == {"CA Sensor": 5.0, "CA Belt": 4.0}
    machines = {m["name"]: m for m in r["by_machine"]}
    assert machines["Press 1"]["qty"] == 3.0 and machines["Press 1"]["key"] == "Press 1"
    # Never installed: waiting for the fitter, named as the table names it.
    assert machines["Not recorded yet"]["qty"] == 6.0 and machines["Not recorded yet"]["key"] is None


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


def test_machine_named_as_the_table_names_it():
    """The By machine chart names an issue with no machine by the rule the
    table's Line / Machine view uses (place_of): its die when fitted on a die
    alone, "Installed, place not recorded" when installed with no place,
    "Not recorded yet" when not installed — waiting for the fitter, not missing
    data. Installed = through Confirm Installation (confirmed_at), whatever
    status a later return gave it. A line with no machine shows by its line."""
    sec = _section()
    p = _part(sec, "M", rate=1)
    fitted = datetime(1998, 6, 9, 9, 0)
    _row(p, 100, date(1998, 1, 5), txn="OPENING")
    _row(p, 2, date(1998, 6, 2), status="PENDING_USER_CONFIRMATION")
    _row(p, 1, date(1998, 6, 3), status="ISSUED_BY_STORE")
    _row(p, 4, date(1998, 6, 4), status="RETURNED", confirmed_at=fitted)      # installed, then sent back
    _row(p, 5, date(1998, 6, 5), status="INSTALLED", machine=" Press 9 ", confirmed_at=fitted)
    _row(p, 6, date(1998, 6, 6), status="INSTALLED", die_no="D-9", confirmed_at=fitted)
    _row(p, 7, date(1998, 6, 7), status="INSTALLED", line_name="Recliner", line_no="02", confirmed_at=fitted)
    _row(p, 8, date(1998, 6, 8), status="INSTALLED", line_name="Recliner", die_no="D-9", confirmed_at=fitted)
    r = svc.analytics(STORE, date_from="1998-06-01", date_to="1998-06-10", section_id=sec.id)
    machines = {(m["name"], m["key"]): m["qty"] for m in r["by_machine"]}
    assert machines == {("Press 9", "Press 9"): 5.0, ("Not recorded yet", None): 3.0,
                        ("Installed, place not recorded", None): 4.0, ("Die D-9", None): 6.0,
                        ("Line Recliner 02", None): 7.0, ("Line Recliner", None): 8.0}
    assert "Installed, place not recorded" in r["basis"]["machine"]


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
    dept = _run(sec, department=f"  {sec.name.upper()} ")  # the consumer: trimmed, case-insensitive
    assert dept["current"]["qty"] == 9.0 and dept["filters"]["department"] == sec.name.upper()
    assert dept["previous"]["qty"] == 5.0
    typed = _run(sec, department="Tool Room")              # what the issue was typed with: not a consumer
    assert typed["current"]["qty"] == 0.0 and typed["previous"]["qty"] == 0.0
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
    r = c.get(URL, query_string={"store_code": STORE, "from": "1998-03-01", "to": "1998-03-10",
                                 "granularity": "week", "section_id": sec.id, "department": sec.name})
    assert r.status_code == 200
    body = r.get_json()["data"]
    assert body["current"]["qty"] == 9.0 and body["window"]["granularity"] == "week"
    assert {"current", "previous", "series", "top_parts", "by_department", "by_section", "by_type",
            "by_machine", "spikes", "filters", "ledger_since", "basis"} <= set(body)

    r = c.get(f"{URL}?store_code={STORE}&from=1998-03-01&to=1998-03-10&part_id={a.id}&type=CA%20Sensor")
    assert r.get_json()["data"]["current"]["qty"] == 5.0


@pytest.mark.parametrize("query", [
    "from=1998-13-01",                         # not a date
    "from=1998-03-10&to=1998-03-01",           # backwards
    "from=1990-01-01&to=1995-01-05",           # 1,831 days: past 5 years
    "from=1990-01-01&to=1991-02-05&granularity=day",   # 401 days, day by day
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
    # The section is owned by no department: it consumes under its own name.
    assert sec.name in body["departments"]
    # Never a department that only takes parts out or buys them.
    assert not {"Store", "Purchase"} & set(body["departments"])


def test_cancelled_issue_is_not_consumption(march_1998):
    sec, a, _ = march_1998
    _row(a, 50, date(1998, 3, 2), dept="Tool Room", status="CANCELLED")
    r = _run(sec)
    assert (r["current"]["qty"], r["current"]["lines"]) == (9.0, 3)
    assert "cancelled issues aside" in r["basis"]["quantity"]


def test_a_rate_of_0_is_a_missing_rate_as_in_the_table():
    """A part at rate 0 is unrated on the chart as in the table under it
    (spare_report_service._money): the chart's note ("X of Y issue lines ...
    no rate") and the table's ("N issues have no rate") count the same issues,
    and the money agrees (review, 15 Oct 2026)."""
    from app.services.consumption_table_service import ConsumptionTableService
    sec = _section()
    zero, rated = _part(sec, "Z", rate=0), _part(sec, "R", rate=10)
    _row(zero, 100, date(1998, 1, 5), txn="OPENING")
    _row(zero, 2, date(1998, 7, 2))
    _row(rated, 3, date(1998, 7, 3))
    span = {"date_from": "1998-07-01", "date_to": "1998-07-10", "section_id": sec.id}
    r = svc.analytics(STORE, **span)
    table = ConsumptionTableService().table(STORE, "part", **span)
    assert (r["current"]["value"], r["current"]["unvalued_lines"], r["current"]["lines"]) == (30.0, 1, 2)
    assert table["unrated_issues"] == r["current"]["unvalued_lines"]
    assert table["rows"][-1]["Value"] == r["current"]["value"]
    top = {t["part_id"]: t for t in r["top_parts"]}
    assert (top[zero.id]["unit_price"], top[zero.id]["value"]) == (None, None)


def test_five_year_window_and_day_by_day_cap(march_1998):
    sec, _, _ = march_1998
    r = svc.analytics(STORE, date_from="1994-01-01", date_to="1998-12-31", section_id=sec.id)
    assert r["window"]["days"] == 1826 and r["window"]["granularity"] == "month"
    assert len(r["series"]) == 60 and r["current"]["qty"] == 21.0          # 02-20 and 03-11 are in it now
    assert r["previous"]["coverage"] == "none"                             # 1989-1993: never measured
    weekly = svc.analytics(STORE, date_from="1994-01-01", date_to="1998-12-31", section_id=sec.id,
                           granularity="week")
    assert weekly["series"][0]["from"] == "1994-01-01" and len(weekly["series"]) == 262
    with pytest.raises(BadRequestError, match="at most 400 days"):
        svc.analytics(STORE, date_from="1997-01-01", date_to="1998-02-05", section_id=sec.id, granularity="day")
    assert len(svc.analytics(STORE, date_from="1997-01-02", date_to="1998-02-05", section_id=sec.id,
                             granularity="day")["series"]) == 400


@pytest.fixture()
def owned_store():
    """A store of its own, its sections owned the store's way (CA-<n>):

        Grp-A   group "CA Grp <n>"   -> department "CA Grp <n>"   (sort 2)
        Grp-B   group "CA Grp <n>"   -> department "CA Grp <n>"
        Maint   named like department "CA Maint <n>"              (sort 1)
        Loose   owned by no department -> its own name
        Shut    switched off, owned by "CA Shut <n>"              (sort 0)

    and a part with no section. Every issue is typed "Store", who only hands
    parts out."""
    n = _n()
    store = Store(code=f"CA{n}", name=f"CA Store {n}")
    db.session.add(store)
    db.session.flush()
    grp, maint, shut = f"CA Grp {n}", f"CA Maint {n}", f"CA Shut {n}"
    depts = [Department(name=grp, sort_order=2), Department(name=maint, sort_order=1),
             Department(name=shut, sort_order=0)]
    secs = {
        "a": Section(store_id=store.id, name=f"CA Grp-A {n}", group_name=grp),
        "b": Section(store_id=store.id, name=f"CA Grp-B {n}", group_name=grp),
        "maint": Section(store_id=store.id, name=maint),
        "loose": Section(store_id=store.id, name=f"CA Loose {n}"),
        "shut": Section(store_id=store.id, name=shut, is_active=False),
    }
    db.session.add_all([*depts, *secs.values()])
    db.session.commit()
    parts = {key: _part(secs.get(key), key.upper(), store=store.code)
             for key in ("a", "b", "maint", "loose", "shut", "none")}
    _row(parts["a"], 100, date(1996, 7, 1), txn="OPENING")
    for qty, key in ((1, "a"), (2, "b"), (4, "maint"), (8, "loose"), (16, "shut"), (32, "none")):
        _row(parts[key], qty, date(1996, 8, 5), dept="Store")
    yield type("Owned", (), {"code": store.code, "grp": grp, "maint": maint, "shut": shut,
                             "loose": secs["loose"].name, "parts": parts})
    db.session.rollback()
    Department.query.filter(Department.id.in_([d.id for d in depts])).delete(synchronize_session=False)
    Store.query.filter_by(id=store.id).update({"is_active": False})
    db.session.commit()


def test_department_breakdown_and_filter_by_consumer(owned_store):
    o = owned_store

    def run(**kw):
        return svc.analytics(o.code, date_from="1996-08-01", date_to="1996-08-10", **kw)

    r = run()
    assert {(d["name"], d["key"], d["qty"]) for d in r["by_department"]} == {
        (o.grp, o.grp, 3.0), (o.maint, o.maint, 4.0), (o.loose, o.loose, 8.0),
        (o.shut, o.shut, 16.0), ("No section", "No section", 32.0)}
    assert not any(d["name"] == "Store" for d in r["by_department"])
    # Each bar's key filters to exactly that bar.
    for d in r["by_department"]:
        assert run(department=d["key"])["current"]["qty"] == d["qty"], d["name"]
    assert run(department=f" {o.grp.lower()} ")["current"]["parts"] == 2       # both group sections
    assert run(department="Store")["current"]["qty"] == 0.0                     # the taker consumes nothing


def test_options_list_the_consuming_departments(owned_store):
    o = owned_store
    # The owners of active sections in master order, then sections no
    # department owns, then "No section" (an active part sits in none). Never
    # the owner of only a switched-off section, nor Store / Purchase.
    assert svc.options(o.code)["departments"] == [o.maint, o.grp, o.loose, "No section"]
