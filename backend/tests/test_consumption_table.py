"""The Issuance & Consumption Report (/api/v1/consumption-analytics/table): pick
a part (or all), a From - To range and a view, see it, and download it as Excel
or PDF right there ("wahi mil jaaye app me ... month wise ya year wise
consumption mil jaaye, alag se report me aane ki jarurat nhi, wahi se excel /
pdf download ho jaaye" — the store, 14 Oct 2026). The six consumption cuts the
Reports page had are views here now; their pinned figures moved with them. Two
reports for a day (17 Oct 2026), one again since 18 Oct ("issuance and
consumption report same dikh rhi h dono me differance nhi to ye kaam merge me
bhi ho sakta h"): every view shows what left the store and what was really used.

An issue counts for the department owning the part's section, never the one
typed on the issue ("consumption maintenance and tool room karega store nhi";
"issuance me store dikha rha h jabki store to issue karta h"), and what came
back is netted. The Issue Register keeps both departments side by side and is
checked here too.

Everything here is CT-<tag>-<n>: this file's own stores, sections,
departments, parts and users. Afterwards the stores and users are switched off
and the departments removed, so nothing leaks into the lists other tests read.
"""
import csv
import io
import uuid
from datetime import date, datetime, time, timedelta
from xml.sax.saxutils import escape

import pytest
from openpyxl import load_workbook
from reportlab.pdfbase.pdfmetrics import stringWidth
from werkzeug.http import parse_options_header

from app.extensions import db
from app.models.department import Department
from app.models.part import Part
from app.models.spare_flow import SpareReturn
from app.models.spare_stock import SpareStockLedger
from app.models.store import Section, Store
from app.models.user import User, UserStoreAccess
from app.services import spare_report_service
from app.services.consumption_analytics_service import ConsumptionAnalyticsService, _local_offset
from app.services.consumption_table_service import BASIS, ConsumptionTableService, preset_window, presets
from app.services.report_service import ReportService
from app.services.spare_report_service import SpareReportService
from app.services.spare_stock_service import SpareStockService, is_store_department
from app.utils import pdf_io
from app.utils.exceptions import BadRequestError, NotFoundError

_TAG = uuid.uuid4().hex[:6].upper()
_seq = {"n": 0}
URL = "/api/v1/consumption-analytics/table"
# The report's views, in the View dropdown's order: the Issue list first.
VIEWS = ["list", "day", "week", "month", "year", "fy", "part", "department", "issued_to", "dept_part", "person",
         "category"]
# The views that count Issues per row (the Issue list counts them in its subtotals).
TABLE_VIEWS = [v for v in VIEWS if v != "list"]
VIEW = {"consumption": {"view": True}}


def _n():
    _seq["n"] += 1
    return _seq["n"]


@pytest.fixture()
def make():
    made = {"stores": [], "users": [], "departments": []}

    def store():
        """A spare store with an active and a switched-off section."""
        code = f"CT{_TAG}{_n()}"
        s = Store(code=code, name=f"Consumption Store {code}")
        db.session.add(s)
        db.session.flush()
        live = Section(store_id=s.id, name=f"Live Sec {code}")
        old = Section(store_id=s.id, name=f"Old Sec {code}", is_active=False)
        db.session.add_all([live, old])
        db.session.commit()
        made["stores"].append(code)
        return type("S", (), {"code": code, "id": s.id, "live": live.id, "old": old.id,
                              "live_name": live.name, "old_name": old.name})

    def department(active=True, name=None, sort_order=100):
        d = Department(name=name or f"CT Dept {_TAG}-{_n()}", is_active=active, sort_order=sort_order)
        db.session.add(d)
        db.session.commit()
        made["departments"].append(d.id)
        return d

    def user(stores=("MAINTENANCE",), perms=None, role="STORE_USER"):
        u = User(username=f"ct{_TAG.lower()}{_n()}", role=role, is_active=True)
        u.set_password("pw")
        if perms:
            u.set_permissions(perms)
        db.session.add(u)
        db.session.flush()
        for code in stores:
            db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
        db.session.commit()
        made["users"].append(u.id)
        return u

    yield type("Make", (), {"store": staticmethod(store), "department": staticmethod(department),
                            "user": staticmethod(user)})
    db.session.rollback()
    Store.query.filter(Store.code.in_(made["stores"])).update({"is_active": False}, synchronize_session=False)
    User.query.filter(User.id.in_(made["users"])).update({"is_active": False}, synchronize_session=False)
    Department.query.filter(Department.id.in_(made["departments"])).delete(synchronize_session=False)
    db.session.commit()


@pytest.fixture()
def client(app):
    return app.test_client()


def _as(client, user):
    with client.session_transaction() as sess:
        sess["user_id"] = user.id
    return client


def _part(store, section=None, qty=None, **levels):
    n = _n()
    p = Part(part_no=f"CT-{_TAG}-{n}", part_name=f"Consumption Part {n}", uom="NOS", part_type="OTHER",
             store_code=store.code, section_id=section, **levels)
    db.session.add(p)
    db.session.commit()
    if qty is not None:
        SpareStockService().set_quantity(p.id, qty, txn_type="OPENING")
    return p


def _issue(store, department, qty=3, stock=10, section=None, at=None, part=None, **kw):
    """One ISSUE of `qty` -> (part, issue id): of `part`, or of a new part with
    `stock` on the shelf; stamped `at` (a naive UTC instant) when given."""
    p = part or _part(store, section, qty=stock)
    lid = SpareStockService().issue(p.id, qty, department.name, **kw)["issue"]["id"]
    if at is not None:
        SpareStockLedger.query.filter_by(id=lid).update({"created_at": at})
        db.session.commit()
    return p, lid


def _utc(day, hour=10, minute=0):
    """The UTC instant of a plant-clock time."""
    return datetime.combine(day, time(hour, minute)) - _local_offset()


def _return(store, part, issue_id, at, **split):
    qty = sum(split.values())
    r = SpareReturn(return_no=f"RET-CT-{_TAG}-{_n()}", part_id=part.id, store_code=store.code,
                    issue_id=issue_id, qty=qty, reason="Did not fit", returned_by="Ravi",
                    received_by="store.user", department="Press Shop", created_at=at, **split)
    r.refresh_status()
    db.session.add(r)
    db.session.commit()
    return r


def _table(store, view, date_from, date_to, **filters):
    return ConsumptionTableService().table(store.code, view, date_from=date_from, date_to=date_to, **filters)


def _view(store, view, date_from, date_to, **filters):
    return _table(store, view, date_from, date_to, **filters)["rows"]


def _cut(rows, *columns):
    return [tuple(r[c] for c in columns) for r in rows]


def _squeeze(cell):
    return "".join(str(cell).split())


def _filename(resp):
    return parse_options_header(resp.headers["Content-Disposition"])[1]["filename"]


def _drawn_pdfs(monkeypatch):
    """[(document, story)] of every PDF built from here on, as handed to reportlab."""
    drawn = []
    real_build = pdf_io.SimpleDocTemplate.build

    def build(doc, story, *args, **kwargs):
        drawn.append((doc, list(story)))           # build() consumes the story it is given
        return real_build(doc, story, *args, **kwargs)

    monkeypatch.setattr(pdf_io.SimpleDocTemplate, "build", build)
    return drawn


IST = timedelta(hours=5, minutes=30)


@pytest.fixture()
def plant_at(monkeypatch):
    """The table on a +05:30 plant clock wherever the suite runs; the naive UTC
    instant of a plant-clock time."""
    monkeypatch.setattr(spare_report_service, "_local_offset", lambda: IST)
    return lambda day, hour=10, minute=0: datetime.combine(day, time(hour, minute)) - IST


# ---- the floor: one store's consumption, pinned in every view ---------------------------

def _consumption_floor(make, at):
    """One store's consumption, 10 Mar - 1 Apr 2026 on the plant clock, every
    issue typed to the store's own people (the taker):

        i1  p1  Grp     live sec, rate 10, Bearing  2  10 Mar 09:00  Recliner 02 / MC-1, 1 back on 5 Apr
        i2  p1  Grp                                 3   1 Apr 01:30  Recliner 02 / MC-2  (31 Mar 20:00 UTC)
        i3  p2  Zed     own section, no rate        4  10 Mar 15:00  not installed
        i4  p3  Old     switched-off sec, rate 5    1   1 Apr 10:00  MC-9 (no line)  Seal
        i5  p4  -       no section, rate 2          5   1 Apr 11:00  CANCELLED
        i6  p5  -       no section, no rate         2   1 Apr 12:00  not installed
        i7  p6  Grp     live sec, no rate, Seal     6   1 Apr 13:00  not installed

    Master order puts Zed (50) before Grp (60). Old's department owns only a
    switched-off section, so it sorts with the other consumers by name."""
    s = make.store()
    group = f"Grp {s.code}"
    Section.query.filter_by(id=s.live).update({"group_name": group})
    zed = Section(store_id=s.id, name=f"Zed Sec {s.code}")
    db.session.add(zed)
    db.session.commit()
    make.department(name=group, sort_order=60)
    make.department(name=zed.name, sort_order=50)
    make.department(name=s.old_name, sort_order=1)
    taker = make.department()
    svc = SpareStockService()
    p1, i1 = _issue(s, taker, qty=2, section=s.live, at=at(date(2026, 3, 10), 9))
    _, i2 = _issue(s, taker, qty=3, part=p1, at=at(date(2026, 4, 1), 1, 30))
    assert at(date(2026, 4, 1), 1, 30) == datetime(2026, 3, 31, 20, 0)
    p2, i3 = _issue(s, taker, qty=4, section=zed.id, at=at(date(2026, 3, 10), 15))
    p3, i4 = _issue(s, taker, qty=1, section=s.old, at=at(date(2026, 4, 1), 10))
    p4, i5 = _issue(s, taker, qty=5, at=at(date(2026, 4, 1), 11))
    p5, i6 = _issue(s, taker, qty=2, at=at(date(2026, 4, 1), 12))
    p6, i7 = _issue(s, taker, qty=6, section=s.live, at=at(date(2026, 4, 1), 13))
    Part.query.filter_by(id=p1.id).update({"unit_price": 10, "sub_category": "Bearing"})
    Part.query.filter_by(id=p3.id).update({"unit_price": 5, "sub_category": "Seal"})
    Part.query.filter_by(id=p4.id).update({"unit_price": 2})
    Part.query.filter_by(id=p6.id).update({"sub_category": " Seal "})
    SpareStockLedger.query.filter_by(id=i5).update({"status": "CANCELLED"})
    db.session.commit()
    svc.confirm_installation(i1, line_name="Recliner", line_no="02", machine="MC-1", user="fitter")
    svc.confirm_installation(i2, line_name="Recliner", line_no="02", machine="MC-2", user="fitter")
    svc.confirm_installation(i4, machine="MC-9", user="fitter")
    _return(s, p1, i1, at(date(2026, 4, 5), 9), qty_good=1)        # April, against a March issue
    return type("Floor", (), {
        "s": s, "taker": taker.name, "group": group, "zed": zed.name, "zed_id": zed.id, "old": s.old_name,
        "p1": p1.part_no, "p1_id": p1.id, "p1_name": p1.part_name, "p2": p2.part_no, "p3": p3.part_no,
        "p4": p4.part_no, "p5": p5.part_no, "p6": p6.part_no, "i1": i1, "i2": i2, "i3": i3, "i4": i4, "i5": i5,
        "i6": i6, "i7": i7})


FIGURES = ("Issues", "Parts", "Qty Issued", "Value", "Qty Returned", "Net Qty", "Net Value")
# Every view's Total over the floor: 6 issues (the cancelled one is not
# consumption), 5 parts, 18 issued, 55 value, 1 back, 17 net, 45 net value.
FLOOR_TOTAL = (6, 5, 18, 55, 1, 17, 45)
SPRING = ("2026-03-01", "2026-04-30")
LONG = "HYDRAULIC CYLINDER SEAL KIT WITH ROD WIPER, GUIDE RINGS AND O-RINGS FOR THE PRESS LINE"


def test_consumption_counts_the_department_that_owns_the_parts_section(make):
    """Consumption belongs to the department owning the part's section — named
    like its group (Tool Room) or like the section (Maintenance) — never to the
    department written on the issue: the store's own people take parts out, the
    store does not consume them (the store's rule, 14 Oct 2026)."""
    s = make.store()
    group = f"Grp {s.code}"
    Section.query.filter_by(id=s.live).update({"group_name": group})
    db.session.add(Section(store_id=s.id, name=f"Idle Sec {s.code}"))
    db.session.commit()
    make.department(name=group)
    make.department(name=f"Idle Sec {s.code}")
    make.department(name=f"Old Sec {s.code}")
    make.department(name=f"Gone {s.code}", active=False)
    store_people = make.department()                 # who takes the parts out — not a consumer
    day = date(2019, 2, 13)
    p1, a = _issue(s, store_people, qty=2, section=s.live, at=_utc(day))
    Part.query.filter_by(id=p1.id).update({"unit_price": 10})
    _issue(s, store_people, qty=3, section=s.old, at=_utc(day))
    p3, c = _issue(s, store_people, qty=4, section=s.live, at=_utc(day))
    _issue(s, store_people, qty=1, at=_utc(day))                        # a part with no section
    db.session.commit()
    _return(s, p3, c, _utc(day, 15), qty_good=1)
    _return(s, p1, a, _utc(day, 16), qty_good=1)                        # the rated one: Net Value drops

    rows = _view(s, "department", "2019-02-13", "2019-02-13")
    by = {(r["Department"], r["Section"]): r for r in rows}
    live = by[(group, s.live_name)]                                     # owned through its group
    assert (live["Issues"], live["Qty Issued"], live["Value"], live["Qty Returned"], live["Net Qty"],
            live["Net Value"]) == (2, 6, 20, 2, 4, 10)
    old = by[(f"Old Sec {s.code}", s.old_name)]                         # owned by its name, though switched off
    assert (old["Qty Issued"], old["Value"], old["Net Value"]) == (3, None, None)   # no rate, so no value
    assert by[("No section", None)]["Qty Issued"] == 1
    # A consuming department with nothing consumed is listed; the taker never is.
    assert by[(f"Idle Sec {s.code}", None)] == {
        "Department": f"Idle Sec {s.code}", "Section": None, "Issues": 0, "Parts": 0,
        "Qty Issued": 0, "Value": 0, "Qty Returned": 0, "Net Qty": 0, "Net Value": 0}
    assert not any(r["Department"] in (store_people.name, f"Gone {s.code}") for r in rows)
    total = rows[-1]
    assert (total["Department"], total["Issues"], total["Parts"], total["Qty Issued"], total["Value"],
            total["Qty Returned"], total["Net Qty"], total["Net Value"]) == ("Total", 4, 4, 10, 20, 2, 8, 10)


def test_consumption_value_unknown_and_zero(make):
    # Issues with no rate: their money is unknown, not 0. No issue at all: 0.
    s, used = make.store(), make.department()
    _issue(s, used, qty=1, at=_utc(date(2019, 2, 20)))
    unknown = _view(s, "department", "2019-02-20", "2019-02-20")[-1]
    assert (unknown["Value"], unknown["Net Value"]) == (None, None)
    none = _view(s, "department", "2019-02-21", "2019-02-21")[-1]
    assert (none["Value"], none["Net Value"]) == (0, 0)


def test_date_view_on_the_plant_clock(make, plant_at):
    f = _consumption_floor(make, plant_at)
    rows = _view(f.s, "day", *SPRING)
    # One row a day, whichever departments used the parts (Department-wise splits them).
    assert _cut(rows, "Date", "Day", *FIGURES) == [
        ("10.03.2026", "Tue", 2, 2, 6, 20, 1, 5, 10),     # Zed's 4 (no rate) and Grp's 2, its 5 Apr return here
        ("01.04.2026", "Wed", 4, 4, 12, 35, 0, 12, 35),   # 31 Mar 20:00 UTC is 1 Apr 01:30; not the cancelled one
        ("Total", None, *FLOOR_TOTAL),
    ]
    assert "Department" not in rows[0]
    # The plant's 31 March ends at 18:30 UTC: the 20:00 UTC issue is April's.
    march = _view(f.s, "day", "2026-03-01", "2026-03-31")
    assert _cut(march, "Date", "Qty Issued") == [("10.03.2026", 6), ("Total", 6)]
    # Only days with issues; a range with none is the Total alone, at 0.
    assert _view(f.s, "day", "2026-03-11", "2026-03-31") == [
        {"Date": "Total", "Day": None, "Issues": 0, "Parts": 0, "Qty Issued": 0,
         "Value": 0, "Qty Returned": 0, "Net Qty": 0, "Net Value": 0}]


def test_week_view(make, plant_at):
    f = _consumption_floor(make, plant_at)
    rows = _view(f.s, "week", *SPRING)
    assert _cut(rows, "Week", *FIGURES) == [
        ("09.03.2026 - 15.03.2026", 2, 2, 6, 20, 1, 5, 10),
        ("30.03.2026 - 05.04.2026", 4, 4, 12, 35, 0, 12, 35),
        ("Total", *FLOOR_TOTAL),
    ]


def test_week_starts_on_monday_on_the_plant_clock_cut_at_the_range(make, plant_at):
    """Sunday 15 Mar 2026 23:30 and Monday 16 Mar 00:30 on the plant clock are
    both the 15th in UTC: the Monday one opens the next week. The range's
    first and last weeks show only the days the range holds."""
    s, taker = make.store(), make.department()
    _issue(s, taker, qty=2, at=plant_at(date(2026, 3, 15), 23, 30))
    _issue(s, taker, qty=5, at=plant_at(date(2026, 3, 16), 0, 30))
    assert plant_at(date(2026, 3, 16), 0, 30).date() == date(2026, 3, 15)
    rows = _view(s, "week", "2026-03-11", "2026-03-17")                     # Wednesday to Tuesday
    assert _cut(rows, "Week", "Issues", "Qty Issued") == [
        ("11.03.2026 - 15.03.2026", 1, 2),
        ("16.03.2026 - 17.03.2026", 1, 5),
        ("Total", 2, 7)]
    whole = _view(s, "week", "2026-03-09", "2026-03-22")
    assert [r["Week"] for r in whole] == ["09.03.2026 - 15.03.2026", "16.03.2026 - 22.03.2026", "Total"]


def test_month_view(make, plant_at):
    f = _consumption_floor(make, plant_at)
    rows = _view(f.s, "month", *SPRING)
    assert _cut(rows, "Month", *FIGURES) == [
        ("Mar 2026", 2, 2, 6, 20, 1, 5, 10),
        ("Apr 2026", 4, 4, 12, 35, 0, 12, 35),
        ("Total", *FLOOR_TOTAL),
    ]
    # April alone: the return made on 5 April belongs to March's issue.
    april = _view(f.s, "month", "2026-04-01", "2026-04-30")
    assert _cut(april, "Month", "Qty Issued", "Qty Returned") == [("Apr 2026", 12, 0), ("Total", 12, 0)]


def test_year_view(make, plant_at):
    f = _consumption_floor(make, plant_at)
    rows = _view(f.s, "year", *SPRING)
    assert _cut(rows, "Year", *FIGURES) == [("2026", *FLOOR_TOTAL), ("Total", *FLOOR_TOTAL)]


def test_period_views_are_one_row_per_period(make, plant_at):
    """One row per date, week, month, year or financial year, however many
    departments used the parts in it: "how much on 10.03" or "in March" is read
    off one row, not added up from one per department (the store, 17 Oct 2026:
    "thoda simple ho jisme dropdown me date wise, month wise, year wise").
    Department-wise still splits it."""
    f = _consumption_floor(make, plant_at)
    other = make.department()
    # A second taker, and a third consumer (a part in no section), on 10 March.
    _issue(f.s, other, qty=7, at=plant_at(date(2026, 3, 10), 16))
    for key in ("day", "week", "month", "year", "fy"):
        out = _table(f.s, key, *SPRING)
        firsts = [r[out["columns"][0]] for r in out["rows"]]
        assert len(firsts) == len(set(firsts)) and "Department" not in out["columns"], key
    march = _view(f.s, "month", *SPRING)[0]
    assert (march["Month"], march["Issues"], march["Parts"], march["Qty Issued"]) == ("Mar 2026", 3, 3, 13)
    split = _view(f.s, "department", "2026-03-01", "2026-03-31")
    assert len(split) == 4 and split[-1]["Qty Issued"] == 13                 # three consumers, then the Total


def test_one_part_across_months_and_years_over_a_long_range(make, plant_at):
    """A part picked, a range of years: its consumption per day, month and
    calendar year. New Year's 01:00 on the plant clock is the old year in UTC
    and counts in the new one."""
    s, taker = make.store(), make.department()
    p, _ = _issue(s, taker, qty=3, stock=50, at=plant_at(date(2023, 6, 15)))
    _issue(s, taker, qty=2, part=p, at=plant_at(date(2024, 1, 1), 1, 0))
    _issue(s, taker, qty=4, part=p, at=plant_at(date(2025, 3, 3)))
    q, _ = _issue(s, taker, qty=1, at=plant_at(date(2024, 5, 5)))
    assert plant_at(date(2024, 1, 1), 1, 0).year == 2023
    span = ("2022-01-01", "2025-12-31")                                     # 1,461 days

    assert _cut(_view(s, "year", *span, part_id=p.id), "Year", "Issues", "Qty Issued") == [
        ("2023", 1, 3), ("2024", 1, 2), ("2025", 1, 4), ("Total", 3, 9)]
    assert _cut(_view(s, "month", *span, part_id=p.id), "Month", "Qty Issued") == [
        ("Jun 2023", 3), ("Jan 2024", 2), ("Mar 2025", 4), ("Total", 9)]
    assert _cut(_view(s, "day", *span, part_id=p.id), "Date", "Qty Issued") == [
        ("15.06.2023", 3), ("01.01.2024", 2), ("03.03.2025", 4), ("Total", 9)]
    # Every part: 2024 holds both, in its one row.
    assert _cut(_view(s, "year", *span), "Year", "Issues", "Parts", "Qty Issued") == [
        ("2023", 1, 1, 3), ("2024", 2, 2, 3), ("2025", 1, 1, 4), ("Total", 4, 2, 10)]
    out = _table(s, "part", *span, part_id=p.id)
    assert _cut(out["rows"], "Part No", "Issues", "Qty Issued", "First Issued", "Last Issued") == [
        (p.part_no, 3, 9, "15.06.2023", "03.03.2025"), ("Total", 3, 9, "15.06.2023", "03.03.2025")]
    assert out["filters"]["part_no"] == p.part_no and out["title"] == (
        f"Issuance & Consumption Report Part-wise {p.part_no} 01.01.2022 to 31.12.2025")
    assert q.part_no not in {r["Part No"] for r in out["rows"]}


def test_range_up_to_five_years_its_end_cut_at_today(make):
    s = make.store()
    out = _table(s, "year", "1990-01-01", "1995-01-04")                    # 1,830 days: the most
    assert out["window"] == {"from": "1990-01-01", "to": "1995-01-04", "days": 1830, "clamped_to_today": False,
                             "ledger_since": None, "coverage": "none"}    # a store with no ledger yet
    with pytest.raises(BadRequestError, match="the most is 1830"):
        _table(s, "year", "1990-01-01", "1995-01-05")
    today = spare_report_service.plant_today()
    ahead = _table(s, "month", (today - timedelta(days=3)).isoformat(), (today + timedelta(days=30)).isoformat())
    assert ahead["window"]["to"] == today.isoformat() and ahead["window"]["clamped_to_today"] is True
    # No range: the screen's default, the last 30 days.
    plain = _table(s, "day", None, None)["window"]
    assert (plain["to"], plain["days"]) == (today.isoformat(), 30)
    for bad in (("2026-13-01", None), ("2026-03-10", "2026-03-01")):
        with pytest.raises(BadRequestError):
            _table(s, "day", *bad)


def _notes(store, fmt, date_from, date_to, drawn=None):
    """The note lines under a downloaded day-wise table: the Excel's after the
    Total and a blank row; the PDF's between the title and the table."""
    buf, _, _ = ConsumptionTableService().export(store.code, fmt, "day", date_from=date_from, date_to=date_to)
    if fmt == "pdf":
        return [p.text for p in drawn[-1][1][1:-2]]
    rows = list(load_workbook(buf).active.iter_rows(values_only=True))
    end = next(i for i, row in enumerate(rows) if row[0] == "Total") + 1
    assert all(set(row) == {None} for row in rows[end:end + 1])
    return [row[0] for row in rows[end + 1:]]


def test_ledger_coverage_and_unrated_issues_said_on_screen_and_in_the_files(make, monkeypatch):
    """Days before the app's ledger were never recorded, so they are not a
    measured zero: the table says where the ledger starts and how much of the
    range it covers, and the Excel / PDF say it under the table. Value leaves
    out issues whose part has no rate: they are counted, and said too."""
    s, taker = make.store(), make.department()
    p, _ = _issue(s, taker, qty=2, at=_utc(date(2017, 5, 10)))          # the store's first ledger row
    q, _ = _issue(s, taker, qty=1, at=_utc(date(2017, 5, 20)))
    drawn = _drawn_pdfs(monkeypatch)
    starts = "The app's ledger starts 10.05.2017; days before it were not recorded"

    before, partly, fully = (_table(s, "day", *span) for span in (
        ("2017-05-01", "2017-05-09"), ("2017-05-01", "2017-05-31"), ("2017-05-10", "2017-05-31")))
    assert [(t["window"]["ledger_since"], t["window"]["coverage"], t["unrated_issues"])
            for t in (before, partly, fully)] == [
        ("2017-05-10", "none", 0), ("2017-05-10", "partial", 2), ("2017-05-10", "full", 2)]

    assert _notes(s, "excel", "2017-05-01", "2017-05-09") == [starts]
    both = [starts, "Value covers rated issues only; 2 issues have no rate"]
    assert _notes(s, "excel", "2017-05-01", "2017-05-31") == both
    assert _notes(s, "pdf", "2017-05-01", "2017-05-31", drawn) == both
    Part.query.filter_by(id=p.id).update({"unit_price": 10})
    db.session.commit()
    assert _notes(s, "excel", "2017-05-10", "2017-05-31") == ["Value covers rated issues only; 1 issue has no rate"]
    Part.query.filter_by(id=q.id).update({"unit_price": 4})
    db.session.commit()
    # Nothing to say: the sheet ends at the Total, the PDF goes from title to table.
    assert _notes(s, "excel", "2017-05-10", "2017-05-31") == []
    assert _notes(s, "pdf", "2017-05-10", "2017-05-31", drawn) == []
    # A store whose ledger has no rows yet.
    empty = make.store()
    assert _notes(empty, "excel", "2017-05-01", "2017-05-31") == [
        "The app's ledger has no rows yet; nothing in this range was recorded"]


def test_part_view(make, plant_at):
    f = _consumption_floor(make, plant_at)
    rows = _view(f.s, "part", *SPRING)
    # Net Value first, unrated parts after every rated one by Net Qty; never the cancelled p4.
    assert [r["Part No"] for r in rows] == [f.p1, f.p3, f.p6, f.p2, f.p5, "Total"]
    assert rows[0] == {
        "Part No": f.p1, "Description": f.p1_name, "Section": f.s.live_name,
        "Department": f.group, "UOM": "NOS", "Issues": 2, "Qty Issued": 5, "Qty Returned": 1,
        "Net Qty": 4, "Rate": 10, "Value": 50, "Net Value": 40,
        "First Issued": "10.03.2026", "Last Issued": "01.04.2026"}
    assert _cut(rows[1:5], "Department", "Rate", "Value", "Net Qty", "Net Value") == [
        (f.old, 5, 5, 1, 5), (f.group, None, None, 6, None), (f.zed, None, None, 4, None),
        ("No section", None, None, 2, None)]
    total = rows[-1]
    assert (total["Rate"], total["Description"]) == (None, None)
    assert _cut([total], "Issues", "Qty Issued", "Value", "Qty Returned", "Net Qty", "Net Value") == [
        (6, 18, 55, 1, 17, 45)]


def test_views_order_by_the_figures_shown(make):
    """Rows showing the same figures fall back to the name. Part B is issued
    0.1 + 0.2 and part A 0.3: summed as floats, B's 0.30000000000000004 sorted
    ahead of A's 0.3 though both read 0.3. The sums are kept to the 2 places
    the cells show, so A comes first by Part No, category and machine."""
    s, taker = make.store(), make.department()
    day = date(2018, 6, 5)
    svc = SpareStockService()
    b, b1 = _issue(s, taker, qty=0.1, at=_utc(day, 9))       # B made first: no lower id to win the tie
    _, b2 = _issue(s, taker, qty=0.2, part=b, at=_utc(day, 10))
    a, a1 = _issue(s, taker, qty=0.3, at=_utc(day, 11))
    Part.query.filter_by(id=b.id).update({"part_no": f"CT-{_TAG}-TIE-B", "unit_price": 1, "sub_category": "Beta"})
    Part.query.filter_by(id=a.id).update({"part_no": f"CT-{_TAG}-TIE-A", "unit_price": 1, "sub_category": "Alpha"})
    db.session.commit()
    for lid, machine in ((b1, "MC-B"), (b2, "MC-B"), (a1, "MC-A")):
        svc.confirm_installation(lid, machine=machine, user="fitter")

    span = ("2018-06-05", "2018-06-05")
    assert _cut(_view(s, "part", *span), "Part No", "Qty Issued", "Net Qty", "Net Value") == [
        (f"CT-{_TAG}-TIE-A", 0.3, 0.3, 0.3), (f"CT-{_TAG}-TIE-B", 0.3, 0.3, 0.3), ("Total", 0.6, 0.6, 0.6)]
    assert _cut(_view(s, "category", *span), "Category", "Net Qty", "Net Value") == [
        ("Alpha", 0.3, 0.3), ("Beta", 0.3, 0.3), (None, 0.6, 0.6)]


def test_category_view(make, plant_at):
    f = _consumption_floor(make, plant_at)
    rows = _view(f.s, "category", *SPRING)
    assert _cut(rows, "Department", "Category", *FIGURES) == [
        (f.zed, "Uncategorised", 1, 1, 4, None, 0, 4, None),
        (f.group, "Seal", 1, 1, 6, None, 0, 6, None),                   # Net Qty 6 before Bearing's 4
        (f.group, "Bearing", 2, 1, 5, 50, 1, 4, 40),
        ("No section", "Uncategorised", 1, 1, 2, None, 0, 2, None),
        (f.old, "Seal", 1, 1, 1, 5, 0, 1, 5),
        ("Total", None, *FLOOR_TOTAL),
    ]


def test_department_view_and_issue_register_on_the_floor(make, plant_at):
    """The department view in master order with Net Value; the Issue Register
    keeps the typed department and names the consumer beside it."""
    f = _consumption_floor(make, plant_at)
    rows = _view(f.s, "department", *SPRING)
    assert _cut(rows, "Department", "Section", *FIGURES) == [
        (f.zed, f.zed, 1, 1, 4, None, 0, 4, None),
        (f.group, f.s.live_name, 3, 2, 11, 50, 1, 10, 40),
        ("No section", None, 1, 1, 2, None, 0, 2, None),
        (f.old, f.old, 1, 1, 1, 5, 0, 1, 5),
        ("Total", None, *FLOOR_TOTAL),
    ]
    register = {r["Issue No"]: r for r in SpareReportService().build(f.s.code, "issue_register", *SPRING)[2]}
    assert (register[f.i1]["Department"], register[f.i1]["Consumer"]) == (f.taker, f.group)
    assert (register[f.i3]["Consumer"], register[f.i4]["Consumer"]) == (f.zed, f.old)
    assert (register[f.i5]["Status"], register[f.i5]["Consumer"]) == ("Cancelled", "No section")


def test_issued_to_department_views(make, plant_at):
    """Issued to Dept-wise and Issued to Dept & Part-wise go by the department
    written on the issue (who the part was handed to), not the consuming one:
    per department, part by part with a subtotal after each department, and
    the Issue list names it beside the consuming one (the store, 27 Oct 2026:
    "aaj kitna part konsa konsa part kis kis depart ko issue kiya")."""
    s = make.store()
    press, weld = make.department(name=f"Press {s.code}"), make.department(name=f"Weld {s.code}")
    day = date(2026, 5, 4)
    a, i1 = _issue(s, press, qty=2, stock=20, at=plant_at(day, 9))
    _issue(s, press, qty=3, part=a, at=plant_at(day, 10))
    b, _ = _issue(s, press, qty=1, stock=5, at=plant_at(day, 11))
    _, i4 = _issue(s, weld, qty=4, part=a, at=plant_at(day, 12))
    Part.query.filter_by(id=a.id).update({"unit_price": 10})
    db.session.commit()
    span = ("2026-05-04", "2026-05-04")

    rows = _view(s, "issued_to", *span)
    assert _cut(rows, "Issued to Dept", "Issues", "Parts", "Qty Issued", "Value") == [
        (press.name, 3, 2, 6, 50), (weld.name, 1, 1, 4, 40), ("Total", 4, 2, 10, 90)]

    out = _table(s, "dept_part", *span)
    assert _cut(out["rows"], "Issued to Dept", "Part No", "Issues", "Qty Issued", "Value") == [
        (press.name, a.part_no, 2, 5, 50), (press.name, b.part_no, 1, 1, None),
        (f"Subtotal {press.name}", "2 parts", 3, 6, 50),
        (weld.name, a.part_no, 1, 4, 40),
        (f"Subtotal {weld.name}", "1 part", 1, 4, 40),
        ("Total", "2 parts", 4, 10, 90)]
    assert out["subtotal_rows"] == [2, 4]

    listed = {r["Issue No"]: r for r in _view(s, "list", *span)}
    assert (listed[i1]["Issued to Dept"], listed[i4]["Issued to Dept"]) == (press.name, weld.name)
    # The department filter is still the consuming one; these parts have no section.
    assert _view(s, "issued_to", *span, department=press.name) == [
        {"Issued to Dept": "Total", **dict.fromkeys(FIGURES, 0), "Value": 0.0, "Net Value": 0.0}]


def test_every_view_value_unknown_zero_and_all_back(make):
    """Issues with no rate: money unknown, not 0. No issue: 0. A rated issue
    that all came back: Net Value 0, not unknown."""
    s, used = make.store(), make.department()
    day = date(2019, 2, 20)
    _issue(s, used, qty=1, at=_utc(day))
    p, lid = _issue(s, used, qty=2, at=_utc(day + timedelta(days=2)))
    Part.query.filter_by(id=p.id).update({"unit_price": 10})
    db.session.commit()
    _return(s, p, lid, _utc(day + timedelta(days=3)), qty_good=2)
    for view in TABLE_VIEWS:
        unknown = _view(s, view, "2019-02-20", "2019-02-20")[-1]
        assert (unknown["Issues"], unknown["Value"], unknown["Net Value"]) == (1, None, None), view
        empty = _view(s, view, "2019-02-21", "2019-02-21")
        assert len(empty) == 1 and (empty[0]["Issues"], empty[0]["Value"], empty[0]["Net Value"]) == (0, 0, 0), view
        back = _view(s, view, "2019-02-22", "2019-02-22")
        # Issued to Dept & Part-wise has the department's subtotal before the Total.
        lines = 3 if view == "dept_part" else 2
        assert [(r["Value"], r["Net Qty"], r["Net Value"]) for r in back] == [(20, 0, 0)] * lines, view
        assert back[-1][_cols(view)[0]] == "Total", view


# ---- the screen's filters ---------------------------------------------------------------------

def test_filters_part_section_department_and_type(make, plant_at):
    f = _consumption_floor(make, plant_at)

    def qty(view="month", **filters):
        return [(r[_cols(view)[0]], r["Qty Issued"]) for r in _view(f.s, view, *SPRING, **filters)]

    assert qty(part_id=f.p1_id) == [("Mar 2026", 2), ("Apr 2026", 3), ("Total", 5)]
    assert qty(section_id=f.s.live) == [("Mar 2026", 2), ("Apr 2026", 9), ("Total", 11)]
    # The department is the CONSUMING one, case and spaces aside...
    assert qty(department=f"  {f.zed.upper()} ") == [("Mar 2026", 4), ("Total", 4)]
    assert qty(department="No section") == [("Apr 2026", 2), ("Total", 2)]          # not the cancelled one
    assert qty(department=f.old) == [("Apr 2026", 1), ("Total", 1)]
    assert qty("department", department=f.group) == [(f.group, 11), ("Total", 11)]
    # ... never the one typed on the issue.
    assert qty(department=f.taker) == [("Total", 0)]
    # The type is the part's sub_category, trimmed; Uncategorised = none.
    assert qty(part_type="seal") == [("Apr 2026", 7), ("Total", 7)]
    assert qty("department", part_type="seal") == [(f.group, 6), (f.old, 1), ("Total", 7)]
    assert qty(part_type="Uncategorised") == [("Mar 2026", 4), ("Apr 2026", 2), ("Total", 6)]
    # Filters combine.
    assert qty(section_id=f.s.live, part_type="Bearing") == [("Mar 2026", 2), ("Apr 2026", 3), ("Total", 5)]
    out = _table(f.s, "day", *SPRING, part_id=f.p1_id, section_id=f.s.live, department=f" {f.group} ", part_type=" Bearing ")
    assert out["filters"] == {"part_id": f.p1_id, "part_no": f.p1, "part_name": f.p1_name,
                              "section_id": f.s.live, "section_name": f.s.live_name,
                              "department": f.group, "type": "Bearing"}
    assert out["title"] == (f"Issuance & Consumption Report Date-wise {f.p1} {f.s.live_name} {f.group} Bearing "
                            "01.03.2026 to 30.04.2026")


def _cols(view, report="consumption"):
    return ConsumptionTableService._view(ConsumptionTableService.REPORTS[report], view).columns


def test_department_view_lists_idle_consumers_only_when_not_narrowed(make, plant_at):
    """With nothing narrowing it, the department view lists each consuming
    department, used or not. Narrowed to a part, a section or a type, a zero
    says nothing: only the departments with figures are listed."""
    f = _consumption_floor(make, plant_at)
    quiet = ("2026-03-11", "2026-03-31")
    assert _cut(_view(f.s, "department", *quiet), "Department", "Issues") == [
        (f.zed, 0), (f.group, 0), ("Total", 0)]
    assert _cut(_view(f.s, "department", *quiet, department=f.zed), "Department", "Issues") == [
        (f.zed, 0), ("Total", 0)]
    for narrowed in ({"part_id": f.p1_id}, {"section_id": f.s.live}, {"part_type": "Seal"}):
        assert _cut(_view(f.s, "department", *quiet, **narrowed), "Department", "Issues") == [("Total", 0)]
    by_part = _view(f.s, "department", *SPRING, part_id=f.p1_id)
    assert _cut(by_part, "Department", "Section", "Qty Issued") == [
        (f.group, f.s.live_name, 5), ("Total", None, 5)]                   # no zero row for Zed


def test_a_part_or_section_of_another_store_is_404(make):
    s, other = make.store(), make.store()
    elsewhere = _part(other, other.live)
    with pytest.raises(NotFoundError):
        _table(s, "day", "2026-03-01", "2026-03-31", part_id=elsewhere.id)
    with pytest.raises(NotFoundError):
        _table(s, "day", "2026-03-01", "2026-03-31", section_id=other.live)


def test_unknown_view_report_and_format(make):
    s = make.store()
    for view in (None, "", "hour", "consumption_by_month", "machine"):
        with pytest.raises(BadRequestError, match="view must be one of list, day, week, month, year, fy, "
                                                  "part, department, issued_to, dept_part, person, category"):
            _table(s, view, "2026-03-01", "2026-03-31")
    # The one report has every view, whatever an old link names it.
    for report in (None, "", "consumption", "issuance"):
        for view in ("list", "person", "category"):
            assert _table(s, view, "2026-03-01", "2026-03-31", report=report)["report"] == "consumption"
    for report in ("sales", "Issuance"):
        with pytest.raises(BadRequestError, match="report must be one of consumption"):
            _table(s, "day", "2026-03-01", "2026-03-31", report=report)
    for fmt in (None, "csv", "docx"):
        with pytest.raises(BadRequestError, match="format must be one of excel, pdf"):
            ConsumptionTableService().export(s.code, fmt, "day")


# ---- the API ------------------------------------------------------------------------------------

def test_table_endpoint(client, make, plant_at):
    f = _consumption_floor(make, plant_at)
    c = _as(client, make.user(stores=(f.s.code,), perms=VIEW))
    r = c.get(f"{URL}?store_code={f.s.code}&view=month&from=2026-03-01&to=2026-04-30")
    assert r.status_code == 200, r.get_json()
    body = r.get_json()["data"]
    assert set(body) == {"report", "report_title", "view", "label", "title", "columns", "rows", "window",
                         "unrated_issues", "filters", "basis", "views", "group", "groups", "subtotal_rows",
                         "cancelled_rows", "pack_title", "issues"}
    assert (body["report"], body["report_title"]) == ("consumption", "Issuance & Consumption Report")   # no report named
    assert (body["view"], body["label"], body["title"]) == (
        "month", "Month-wise", "Issuance & Consumption Report Month-wise 01.03.2026 to 30.04.2026")
    assert body["columns"] == ["Month", *FIGURES]
    # The floor's ledger starts with its first issue, 10 March: the range is counted in part.
    assert body["window"] == {"from": "2026-03-01", "to": "2026-04-30", "days": 61, "clamped_to_today": False,
                              "ledger_since": "2026-03-10", "coverage": "partial"}
    assert body["unrated_issues"] == 3                                      # i3, i6, i7; not the cancelled i5
    assert body["issues"] == 6
    assert [(row["Month"], row["Qty Issued"]) for row in body["rows"]] == [
        ("Mar 2026", 6), ("Apr 2026", 12), ("Total", 18)]
    assert body["rows"][0]["Value"] == 20                                   # Zed's 4 have no rate: not in Value
    assert [v["key"] for v in body["views"]] == VIEWS
    assert set(body["basis"]) == {"consumption", "returns", "value", "period", "list", "person", "issued_to"}
    assert (body["group"], body["subtotal_rows"], body["cancelled_rows"]) == (None, [], [])
    assert [g["key"] for g in body["groups"]] == ["day", "month", "year", "fy"]
    assert body["pack_title"] == "Issuance & Consumption Report Full pack 01.03.2026 to 30.04.2026"
    # A link from the two-report days (report=issuance) opens the same report.
    issuance = c.get(f"{URL}?store_code={f.s.code}&report=issuance&view=month&from=2026-03-01&to=2026-04-30"
                     ).get_json()["data"]
    assert issuance == body

    columns = {
        "list": ["Date", "Time", "Issue No", "Reference", "Part No", "Description", "Section", "Department",
                 "Issued to Dept", "Issued To", "Qty Issued", "Qty Returned", "Net Qty", "Rate", "Value", "Net Value",
                 "Status"],
        "day": ["Date", "Day", *FIGURES],
        "week": ["Week", *FIGURES],
        "month": ["Month", *FIGURES],
        "year": ["Year", *FIGURES],
        "fy": ["Financial Year", *FIGURES],
        "part": ["Part No", "Description", "Section", "Department", "UOM", "Issues", "Qty Issued",
                 "Qty Returned", "Net Qty", "Rate", "Value", "Net Value", "First Issued", "Last Issued"],
        "department": ["Department", "Section", *FIGURES],
        "issued_to": ["Issued to Dept", *FIGURES],
        "dept_part": ["Issued to Dept", "Part No", "Description", "UOM", "Issues", "Qty Issued", "Qty Returned",
                      "Net Qty", "Rate", "Value", "Net Value"],
        "person": ["Issued To", "Emp Code", "Department", *FIGURES],
        "category": ["Department", "Category", *FIGURES],
    }
    for view, expected in columns.items():
        body = c.get(URL, query_string={
            "store_code": f.s.code, "view": view, "from": "2026-03-01", "to": "2026-04-30",
            "part_id": f.p1_id, "section_id": f.s.live, "department": f.group, "type": "Bearing",
        }).get_json()["data"]
        assert body["columns"] == expected, view
        assert body["rows"][-1][expected[0]] == "Total" and body["rows"][-1]["Qty Issued"] == 5, view
        assert body["title"].startswith(f"Issuance & Consumption Report {body['label']} {f.p1} "), view
    assert list(columns) == VIEWS


@pytest.mark.parametrize("query", [
    "",                                            # no view
    "view=hour",
    "view=day&from=2026-13-01",                    # not a date
    "view=day&from=2026-03-10&to=2026-03-01",      # backwards
    "view=year&from=1990-01-01&to=1995-01-05",     # 1,831 days
    "view=day&part_id=abc",
    "view=day&section_id=1.5",
    "view=list&group=week",                        # the Issue list groups by day, month, year or fy
    "report=sales&view=day",
    "report=Issuance&view=day",                    # the old name, exactly as the old links wrote it
])
def test_table_endpoint_rejects_bad_input(client, make, query):
    s = make.store()
    c = _as(client, make.user(role="ADMIN", stores=()))
    r = c.get(f"{URL}?store_code={s.code}&{query}")
    assert r.status_code == 400, query
    assert c.get(f"{URL}/export?store_code={s.code}&format=excel&{query}").status_code == 400, query


def test_table_endpoint_long_range_and_404(client, make):
    s, other = make.store(), make.store()
    c = _as(client, make.user(role="ADMIN", stores=()))
    assert c.get(f"{URL}?store_code={s.code}&view=year&from=1990-01-01&to=1995-01-04").status_code == 200
    elsewhere = _part(other, other.live)
    assert c.get(f"{URL}?store_code={s.code}&view=day&part_id={elsewhere.id}").status_code == 404
    assert c.get(f"{URL}/export?store_code={s.code}&view=day&format=pdf&part_id={elsewhere.id}").status_code == 404
    assert c.get(f"{URL}?view=day").status_code == 400                                       # no store


def test_table_endpoint_permission_and_store_access(client, make):
    s = make.store()
    query = f"store_code={s.code}&view=month&from=2026-03-01&to=2026-03-31"
    no_right = _as(client, make.user(stores=(s.code,)))                       # the store, but no consumption right
    assert no_right.get(f"{URL}?{query}").status_code == 403
    assert no_right.get(f"{URL}/export?{query}&format=excel").status_code == 403
    reports_only = _as(client, make.user(stores=(s.code,), perms={"reports": {"view": True}}))
    assert reports_only.get(f"{URL}?{query}").status_code == 403
    elsewhere = _as(client, make.user(stores=("MAINTENANCE",), perms=VIEW))  # the right, not this store
    assert elsewhere.get(f"{URL}?{query}").status_code == 403
    assert elsewhere.get(f"{URL}/export?{query}&format=pdf").status_code == 403
    granted = _as(client, make.user(stores=(s.code,), perms=VIEW))
    assert granted.get(f"{URL}?{query}").status_code == 200
    assert granted.get(f"{URL}/export?{query}&format=excel").status_code == 200
    # The Full pack: the same right, the same store. (_as signs the one test
    # client in as each user in turn.)
    assert granted.get(f"{URL}/pack?{query}").status_code == 200
    for user in (make.user(stores=(s.code,)), make.user(stores=(s.code,), perms={"reports": {"view": True}}),
                 make.user(stores=("MAINTENANCE",), perms=VIEW)):
        assert _as(client, user).get(f"{URL}/pack?{query}").status_code == 403


LEDGER_NOTE = "The app's ledger starts 10.03.2026; days before it were not recorded"


def _sheet(resp):
    """(the sheet's rows as values, the sheet) of a downloaded workbook."""
    ws = load_workbook(io.BytesIO(resp.get_data())).active
    return list(ws.iter_rows(values_only=True)), ws


def test_export_excel_reads_back_as_shown(client, make, plant_at):
    """Each view's sheet is the table on screen, header in row 1 and the Total
    last; under it, after a blank row and outside the filtered range, the notes
    the screen shows beside it — the range reaches back before the floor's
    ledger, and three of its issues have no rate."""
    f = _consumption_floor(make, plant_at)
    c = _as(client, make.user(role="ADMIN", stores=()))
    for view in TABLE_VIEWS:                     # the Issue list's own: test_issue_list_excel_and_pdf
        query = f"store_code={f.s.code}&view={view}&from=2026-03-01&to=2026-04-30"
        shown = c.get(f"{URL}?{query}").get_json()["data"]
        resp = c.get(f"{URL}/export?{query}&format=excel")
        assert resp.status_code == 200, (view, resp.get_json() if resp.is_json else None)
        assert resp.mimetype == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        label = shown["label"].replace(" / ", " ")                         # "/" cannot be in a file name
        assert _filename(resp) == f"Issuance & Consumption Report {label} 01.03.2026 to 30.04.2026.xlsx", view
        table, ws = _sheet(resp)
        end = len(shown["rows"]) + 1
        assert list(table[0]) == shown["columns"], view
        assert [list(row) for row in table[1:end]] == [[r[col] for col in shown["columns"]] for r in shown["rows"]], view
        assert table[end - 1][0] == "Total", view
        assert ws.auto_filter.ref.endswith(str(end)) and ws.freeze_panes == "A2", view
        assert set(table[end]) == {None}, view                              # a blank row, then the notes
        assert [row[0] for row in table[end + 1:]] == [
            LEDGER_NOTE, "Value covers rated issues only; 3 issues have no rate"], view
        assert all(set(row[1:]) == {None} for row in table[end + 1:]), view
        assert ws.cell(row=end + 2, column=1).font.i, view

    one = c.get(f"{URL}/export?store_code={f.s.code}&view=month&from=2026-03-01&to=2026-04-30"
                f"&part_id={f.p1_id}&format=excel")
    assert _filename(one) == f"Issuance & Consumption Report Month-wise {f.p1} 01.03.2026 to 30.04.2026.xlsx"
    rows, _ = _sheet(one)
    assert rows[0][:4] == ("Month", "Issues", "Parts", "Qty Issued")
    assert [(r[0], r[3]) for r in rows[1:]] == [
        ("Mar 2026", 2), ("Apr 2026", 3), ("Total", 5), (None, None), (LEDGER_NOTE, None)]   # p1 has a rate: one note
    single = c.get(f"{URL}/export?store_code={f.s.code}&view=day&from=2026-04-01&to=2026-04-01&format=excel")
    assert _filename(single) == "Issuance & Consumption Report Date-wise 01.04.2026.xlsx"


def test_export_pdf_titled_and_fitted(client, make, plant_at, monkeypatch):
    """Each view as a PDF titled like its file; the wide Part-wise table and the
    Issue list, with a long description, fitted to the page. A fitted cell may break
    onto more lines, so its words are compared."""
    f = _consumption_floor(make, plant_at)
    Part.query.filter_by(part_no=f.p1).update({"part_name": LONG})
    db.session.commit()
    drawn = _drawn_pdfs(monkeypatch)
    c = _as(client, make.user(role="ADMIN", stores=()))
    for view in VIEWS:
        query = f"store_code={f.s.code}&view={view}&from=2026-03-01&to=2026-04-30&part_id={f.p1_id}"
        shown = c.get(f"{URL}?{query}").get_json()["data"]
        resp = c.get(f"{URL}/export?{query}&format=pdf")
        assert resp.status_code == 200 and resp.mimetype == "application/pdf", view
        assert resp.get_data()[:4] == b"%PDF", view
        assert _filename(resp) == f"{shown['title'].replace(' / ', ' ')}.pdf", view
        doc, story = drawn[-1]
        # The title is markup: "Issuance & Consumption" is written "&amp;" and prints "&".
        assert story[0].text == escape(shown["title"]) == escape(
            f"Issuance & Consumption Report {shown['label']} {f.p1} 01.03.2026 to 30.04.2026"), view
        # Under the title, ahead of the figures: p1 has a rate, so only the ledger's start.
        assert [p.text for p in story[1:-2]] == [LEDGER_NOTE], view
        table = story[-1]
        frame = doc.pageTemplates[0].frames[0]
        assert table.wrap(frame._aW, frame._aH)[0] <= frame._aW + 1e-6, view
        # A fitted cell may break onto more lines, even inside a long word:
        # its characters are compared, line breaks and spaces aside.
        cells = [[_squeeze(cell) for cell in row] for row in table._cellvalues]
        assert cells == [[_squeeze(col) for col in shown["columns"]]] + [
            [_squeeze("" if r[col] is None else r[col]) for col in shown["columns"]] for r in shown["rows"]], view
        if view == "part":
            assert doc.leftMargin == pdf_io.FIT_MARGIN
            assert {st.fontsize for row in table._cellStyles for st in row} == {pdf_io.FIT_SIZE}


def test_issue_register_still_renders_with_its_consumer(make, plant_at, monkeypatch):
    """The Issue Register stays on the Reports page, its Consumer column beside
    the typed Department, in every format; wide, so its PDF is fitted."""
    f = _consumption_floor(make, plant_at)
    Part.query.filter_by(part_no=f.p1).update({"part_name": LONG})
    db.session.commit()
    drawn = _drawn_pdfs(monkeypatch)
    rows = SpareReportService().build(f.s.code, "issue_register", *SPRING)[2]
    for fmt, ext in (("excel", "xlsx"), ("csv", "csv"), ("pdf", "pdf")):
        buf, name, _ = ReportService().export("issue_register", fmt, store_code=f.s.code,
                                              date_from=SPRING[0], date_to=SPRING[1])
        assert name == f"Issue Register 01.03.2026 to 30.04.2026.{ext}"
        data = buf.getvalue()
        if fmt == "excel":
            table = list(load_workbook(io.BytesIO(data)).active.iter_rows(values_only=True))
        elif fmt == "csv":
            table = list(csv.reader(io.StringIO(data.decode("utf-8-sig"))))
        else:
            doc, story = drawn[-1]
            assert doc.leftMargin == pdf_io.FIT_MARGIN
            table = [["".join(str(cell).split()) for cell in row] for row in story[-1]._cellvalues]
        assert "Consumer" in list(table[0]) and len(table) == len(rows) + 1, fmt


def test_no_none_or_nan_cells_in_exports(client, make):
    s, taker = make.store(), make.department()
    _part(s)                                                    # never issued, no section, no rate
    _issue(s, taker, qty=2, at=_utc(date(2026, 3, 4)))          # waiting: no line, machine, die
    c = _as(client, make.user(role="ADMIN", stores=()))
    bad = {"None", "none", "nan", "NaN", "null"}
    for report, view in [*(("consumption", v) for v in VIEWS), ("issuance", "list")]:
        query = f"store_code={s.code}&report={report}&view={view}&from=2026-03-01&to=2026-03-31"
        xlsx = c.get(f"{URL}/export?{query}&format=excel")
        cells = [v for row in load_workbook(io.BytesIO(xlsx.get_data())).active.iter_rows(values_only=True)
                 for v in row]
        assert not any(isinstance(v, str) and v.strip() in bad for v in cells), (report, view)
        assert c.get(f"{URL}/export?{query}&format=pdf").status_code == 200, (report, view)
    for report in ("issuance", "consumption"):
        pack = c.get(f"{URL}/pack?store_code={s.code}&report={report}&from=2026-03-01&to=2026-03-31")
        cells = [v for ws in load_workbook(io.BytesIO(pack.get_data())) for row in ws.iter_rows(values_only=True)
                 for v in row]
        assert not any(isinstance(v, str) and v.strip() in bad for v in cells), report


# ---- the dashboard, the TV board and the consumption Excel add up to the table ------------

@pytest.fixture()
def plant_clock(plant_at, monkeypatch):
    """plant_at for the dashboard / TV / Excel figures too: SpareStockService
    reads the plant clock off consumption_analytics_service."""
    from app.services import consumption_analytics_service
    monkeypatch.setattr(consumption_analytics_service, "_local_offset", lambda: IST)
    return plant_at


def _sum(rows, key="value"):
    return sum(r[key] for r in rows)


def test_dashboard_tv_and_excel_cut_on_plant_days_as_the_table(make, plant_clock):
    """The dashboard's donuts, trend and Top Consumed, the TV board's
    this-month departments and the consumption Excel cut a range on plant-clock
    days, as the table does, so they equal its Total: an issue at 01:30 plant
    time (20:00 UTC the day before) is that morning's — counted on a range's
    first day, never on the day after its last (review, 15 Oct 2026). Months
    too: 01 Apr 01:30 is April's."""
    s = make.store()
    owner, taker = make.department(name=s.live_name), make.department()
    p, _ = _issue(s, taker, qty=3, section=s.live, stock=50, at=plant_clock(date(2026, 3, 10), 1, 30))
    _issue(s, taker, qty=2, part=p, at=plant_clock(date(2026, 3, 11), 23, 59))
    _issue(s, taker, qty=7, part=p, at=plant_clock(date(2026, 3, 12), 1, 30))       # the day after the range
    svc, rng = SpareStockService(), ("2026-03-10", "2026-03-11")

    total = _table(s, "department", *rng)["rows"][-1]["Qty Issued"]
    assert total == 5
    assert svc.consumption_by_department(s.code, None, None, *rng) == [{"name": owner.name, "value": 5.0}]
    assert _sum(svc.consumption_by_type(s.code, None, None, *rng)) == total
    assert _sum(svc.top_consumed(s.code, date_from=rng[0], date_to=rng[1]), "qty") == total
    assert [(t["d"], t["qty"]) for t in svc.consumption_trend(s.code, date_from=rng[0], date_to=rng[1])] == [
        ("10 Mar", 3.0), ("11 Mar", 2.0)]
    assert [(t["d"], t["out"]) for t in svc.movement_trend(s.code, date_from=rng[0], date_to=rng[1])] == [
        ("10 Mar", 3.0), ("11 Mar", 2.0)]
    sheet = load_workbook(svc.consumption_report_excel(s.code, date_from=rng[0], date_to=rng[1]))["By Department"]
    assert list(sheet.iter_rows(values_only=True)) == [("Department", "Qty Issued"), (owner.name, 5)]

    _issue(s, taker, qty=4, part=p, at=plant_clock(date(2026, 4, 1), 1, 30))        # 31 Mar 20:00 UTC
    assert svc.consumption_by_period(s.code, "month") == [{"period": "2026-03", "qty": 12.0},
                                                          {"period": "2026-04", "qty": 4.0}]
    assert svc.monthly_consumption(s.code) == [{"name": "2026-03", "value": 12.0}, {"name": "2026-04", "value": 4.0}]

    # A rolling last-N-days window ends today on the plant clock: six days
    # back at 01:00 plant time is inside the last 7 days, not the UTC day before.
    today = (datetime.utcnow() + IST).date()
    _issue(s, taker, qty=6, part=p, at=plant_clock(today - timedelta(days=6), 1, 0))
    assert svc.consumption_by_department(s.code, days=7) == [{"name": owner.name, "value": 6.0}]


def test_a_cancelled_issue_is_consumed_nowhere(make):
    """A cancelled issue was not consumed — on the screen, and so on every
    dashboard / TV / Excel figure: the three donuts, the trend and Top Consumed
    total alike, the consumption Excel's five sheets sum alike, and the TV
    board's department shares, which divide by this month's total
    (comparison.current), add up to 100% (review, 15 Oct 2026)."""
    from app.services.spare_dashboard_service import SpareDashboardService
    s = make.store()
    make.department(name=s.live_name)
    taker = make.department()
    p, _ = _issue(s, taker, qty=3, section=s.live, stock=50, machine="MC-A")
    _issue(s, taker, qty=2, part=p)
    _issue(s, taker, qty=1, stock=5)                                                 # in no section
    _, gone = _issue(s, taker, qty=4, part=p, machine="MC-X")
    SpareStockLedger.query.filter_by(id=gone).update({"status": "CANCELLED"})
    db.session.commit()
    svc = SpareStockService()

    assert _table(s, "department", None, None)["rows"][-1]["Qty Issued"] == 6
    consumption = SpareDashboardService()._consumption(s.code, None)
    for split in ("by_department", "by_type", "this_month_by_department"):
        assert _sum(consumption[split]) == 6, split
    assert "by_machine" not in consumption
    assert consumption["comparison"]["current"]["value"] == _sum(consumption["this_month_by_department"])
    assert _sum(svc.top_consumed(s.code, days=7), "qty") == 6
    assert _sum(svc.consumption_trend(s.code, days=7), "qty") == 6
    wb = load_workbook(svc.consumption_report_excel(s.code))
    assert {ws.title: sum(r[1] for r in ws.iter_rows(min_row=2, values_only=True)) for ws in wb} == dict.fromkeys(
        ("By Department", "By Category", "Month-wise", "Year-wise"), 6)


def test_reports_page_no_longer_offers_consumption(client, make):
    """The screen is the one place for consumption: the Reports page lists no
    consumption report and its old downloads are gone."""
    c = _as(client, make.user(role="ADMIN", stores=()))
    keys = [e["key"] for e in c.get("/api/v1/reports/catalog?store_code=MAINTENANCE").get_json()["data"]]
    assert "issue_register" in keys and not any(k.startswith("consumption") for k in keys)
    for key in ("consumption_by_department", "consumption_by_date", "consumption_by_month",
                "consumption_by_part", "consumption_by_machine", "consumption_by_category"):
        assert c.get(f"/api/v1/reports/{key}/excel?store_code=MAINTENANCE").status_code == 404, key


# ---- the presets, the Issue list, the financial year, the Full pack ----------------------------
# "issuance and consumption ka bna de but mail nhi karenge bas excel/pdf download
# ka option" (the store, 17 Oct 2026): yesterday, last month and the financial
# year (April - March) as presets, every issue listed with subtotals, and one
# workbook of it all — downloads only. One report since 18 Oct 2026.

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
LIST_COLUMNS = ("Date", "Time", "Issue No", "Reference", "Part No", "Description", "Section", "Department",
                "Issued to Dept", "Issued To", "Qty Issued", "Qty Returned", "Net Qty", "Rate", "Value", "Net Value",
                "Status")
LIST_FIGURES = ("Qty Issued", "Qty Returned", "Net Qty", "Rate", "Value", "Net Value")
ISSUED = ("Issues", "Parts", "Qty Issued", "Value")
TOTAL_FIGURES = ("Qty Issued", "Value", "Qty Returned", "Net Qty", "Net Value")
CANCELLED_NOTE = "1 cancelled issue listed in grey, left out of every subtotal and the Total"
UNRATED_NOTE = "Value covers rated issues only; 3 issues have no rate"


@pytest.mark.parametrize("today, expected", [
    (date(2026, 10, 17), {"yesterday": ("2026-10-16", "2026-10-16"), "last_month": ("2026-09-01", "2026-09-30"),
                          "this_fy": ("2026-04-01", "2026-10-17"), "last_fy": ("2025-04-01", "2026-03-31")}),
    # 1 April: a financial year one day old; the last one ended yesterday.
    (date(2026, 4, 1), {"yesterday": ("2026-03-31", "2026-03-31"), "last_month": ("2026-03-01", "2026-03-31"),
                        "this_fy": ("2026-04-01", "2026-04-01"), "last_fy": ("2025-04-01", "2026-03-31")}),
    # 31 March: still the old financial year, on its last day.
    (date(2026, 3, 31), {"yesterday": ("2026-03-30", "2026-03-30"), "last_month": ("2026-02-01", "2026-02-28"),
                         "this_fy": ("2025-04-01", "2026-03-31"), "last_fy": ("2024-04-01", "2025-03-31")}),
    # New Year's Day: yesterday and last month are last year's; the financial year runs on.
    (date(2027, 1, 1), {"yesterday": ("2026-12-31", "2026-12-31"), "last_month": ("2026-12-01", "2026-12-31"),
                        "this_fy": ("2026-04-01", "2027-01-01"), "last_fy": ("2025-04-01", "2026-03-31")}),
    # A leap February.
    (date(2028, 3, 10), {"yesterday": ("2028-03-09", "2028-03-09"), "last_month": ("2028-02-01", "2028-02-29"),
                         "this_fy": ("2027-04-01", "2028-03-10"), "last_fy": ("2026-04-01", "2027-03-31")}),
])
def test_presets_windows(today, expected):
    assert {k: (v["from"], v["to"]) for k, v in presets(today).items()} == expected


def test_presets_go_by_the_plant_clock(client, make, plant_at, monkeypatch):
    """00:30 on 1 April at the plant is still 31 March in UTC: the presets go by
    the plant's day, and the filter bar gets them with its lists."""
    monkeypatch.setattr(spare_report_service, "utcnow", lambda: plant_at(date(2026, 4, 1), 0, 30))
    assert plant_at(date(2026, 4, 1), 0, 30).date() == date(2026, 3, 31)
    assert presets() == {
        "yesterday": {"from": "2026-03-31", "to": "2026-03-31"},
        "last_month": {"from": "2026-03-01", "to": "2026-03-31"},
        "this_fy": {"from": "2026-04-01", "to": "2026-04-01"},
        "last_fy": {"from": "2025-04-01", "to": "2026-03-31"}}
    s = make.store()
    c = _as(client, make.user(stores=(s.code,), perms=VIEW))
    body = c.get(f"/api/v1/consumption-analytics/options?store_code={s.code}").get_json()["data"]
    assert body["presets"] == presets() and {"sections", "types", "departments"} <= set(body)
    # A minute before midnight on 31 March: the old financial year's last day.
    monkeypatch.setattr(spare_report_service, "utcnow", lambda: plant_at(date(2026, 3, 31), 23, 59))
    assert presets()["this_fy"] == {"from": "2025-04-01", "to": "2026-03-31"}
    with pytest.raises(BadRequestError, match="range must be one of yesterday, last_month, this_fy, last_fy"):
        preset_window("last_week", date(2026, 4, 1))


def test_person_wise_on_the_floor(make, plant_at):
    """Person-wise carries the whole figures — what left the store and what was
    really used — and every department the person's parts went to: the
    consuming ones, never the department typed on the issue. Nobody was written
    on the floor's issues."""
    f = _consumption_floor(make, plant_at)
    assert _cut(_view(f.s, "person", *SPRING), "Issued To", "Emp Code", "Department", *FIGURES) == [
        ("Not recorded", None, f"{f.group}, {f.zed}, {f.old}, No section", *FLOOR_TOTAL),
        ("Total", None, None, *FLOOR_TOTAL)]


def test_every_view_names_the_consuming_department_never_the_taker(make):
    """An issue typed to the store's own people for a Maintenance-section part
    is Maintenance's in every view that names a department — Department-wise,
    the Issue list, Person-wise, Part-wise, Line / Machine, Category — and in
    the Department filter (the store's rule, 14 Oct 2026; "issuance me store
    dikha rha h jabki store to issue karta h" — 18 Oct 2026)."""
    s = make.store()
    maint = make.department(name=s.live_name)                # owns the live section by its name
    taker = make.department(name=f"Stores team {s.code}")   # hands parts out: consumes nothing
    p, _ = _issue(s, taker, qty=4, section=s.live, at=_utc(date(2019, 3, 5)))
    Part.query.filter_by(id=p.id).update({"unit_price": 25})
    db.session.commit()
    span = ("2019-03-05", "2019-03-05")

    assert _cut(_view(s, "department", *span), "Department", "Section", "Qty Issued", "Net Qty", "Net Value") == [
        (maint.name, s.live_name, 4, 4, 100), ("Total", None, 4, 4, 100)]
    assert _view(s, "list", *span)[0]["Department"] == maint.name
    for view in ("person", "part", "category"):
        rows = _view(s, view, *span)
        assert rows[0]["Department"] == maint.name and taker.name not in {r["Department"] for r in rows}, view

    def qty(dept):
        return _view(s, "month", *span, department=dept)[-1]["Qty Issued"]

    assert (qty(maint.name), qty(taker.name)) == (4, 0)


def test_every_view_ends_on_the_same_total(make, plant_at):
    """Every view of the range — the Issue list and Person-wise too — ends on
    the same Qty Issued, Value, Qty Returned, Net Qty and Net Value, under the
    same part / section / type."""
    f = _consumption_floor(make, plant_at)
    for key in VIEWS:
        total = _view(f.s, key, *SPRING)[-1]
        assert tuple(total[k] for k in TOTAL_FIGURES) == (18, 55, 1, 17, 45), key
    for narrowed in ({"part_id": f.p1_id}, {"section_id": f.s.live}, {"part_type": "Seal"}, {}):
        totals = {key: tuple(_view(f.s, key, *SPRING, **narrowed)[-1][k] for k in TOTAL_FIGURES) for key in VIEWS}
        assert len(set(totals.values())) == 1, (narrowed, totals)


def test_returns_are_netted_in_every_view_the_issue_list_too(make, plant_at):
    """p1's 2 issued on 10 March, 1 back on 5 April: every view shows the 2 that
    left and the 1 really used — Part-wise, and the issue's own line on the
    Issue list."""
    f = _consumption_floor(make, plant_at)
    march = ("2026-03-01", "2026-03-31")
    part = next(r for r in _view(f.s, "part", *march) if r["Part No"] == f.p1)
    assert (part["Qty Issued"], part["Value"], part["Qty Returned"], part["Net Qty"], part["Net Value"]) == (
        2, 20, 1, 1, 10)
    line = next(r for r in _view(f.s, "list", *march) if r["Issue No"] == f.i1)
    assert _cut([line], *LIST_FIGURES) == [(2, 1, 1, 10, 20, 10)]


def test_issue_list_on_the_floor(make, plant_at):
    """Every issue, oldest first, in the Issue Register's words — Issued To as
    written, Department the consuming one —, what came back against each
    issue beside it, a subtotal after each plant day (a range of 61 days) and
    the Total last. The cancelled issue (i5) is listed — marked Cancelled, with
    its quantity and rate and nothing else — and no subtotal or total counts
    it."""
    f = _consumption_floor(make, plant_at)
    SpareStockLedger.query.filter_by(id=f.i1).update({"reference": "REQ-0001", "issued_to": "Ravi Kumar",
                                                       "issued_to_mobile": "9876543210"})
    db.session.commit()
    out = _table(f.s, "list", *SPRING)
    assert out["columns"] == list(LIST_COLUMNS)
    assert (out["title"], out["group"], out["label"]) == (
        "Issuance & Consumption Report Issue list 01.03.2026 to 30.04.2026", "day", "Issue list")
    rows = out["rows"]
    assert _cut(rows, "Date", "Time", "Issue No", "Part No", "Section", "Department", *LIST_FIGURES) == [
        ("10.03.2026", "09:00", f.i1, f.p1, f.s.live_name, f.group, 2, 1, 1, 10, 20, 10),   # 1 back on 5 Apr
        ("10.03.2026", "15:00", f.i3, f.p2, f.zed, f.zed, 4, 0, 4, None, None, None),       # no rate: no value
        ("Subtotal 10.03.2026", None, "2 issues", None, None, None, 6, 1, 5, None, 20, 10),
        ("01.04.2026", "01:30", f.i2, f.p1, f.s.live_name, f.group, 3, 0, 3, 10, 30, 30),   # 31 Mar 20:00 UTC
        ("01.04.2026", "10:00", f.i4, f.p3, f.old, f.old, 1, 0, 1, 5, 5, 5),
        ("01.04.2026", "11:00", f.i5, f.p4, None, "No section", 5, None, None, 2, None, None),   # cancelled
        ("01.04.2026", "12:00", f.i6, f.p5, None, "No section", 2, 0, 2, None, None, None),
        ("01.04.2026", "13:00", f.i7, f.p6, f.s.live_name, f.group, 6, 0, 6, None, None, None),
        ("Subtotal 01.04.2026", None, "4 issues + 1 cancelled", None, None, None, 12, 0, 12, None, 35, 35),
        ("Total", None, "6 issues + 1 cancelled", None, None, None, 18, 1, 17, None, 55, 45),
    ]
    assert _cut(rows, "Reference", "Issued To", "Status") == [
        ("REQ-0001", "Ravi Kumar", "Installed"),
        (None, None, "Issued"),
        (None, None, None),
        (None, None, "Installed"),
        (None, None, "Installed"),
        (None, None, "Cancelled"),
        (None, None, "Issued"),
        (None, None, "Issued"),
        (None, None, None),
        (None, None, None),
    ]
    assert "Line / Machine / Die" not in rows[0]       # nothing records one since 27 Oct 2026
    assert rows[0]["Description"] == f.p1_name
    assert (out["subtotal_rows"], out["cancelled_rows"], out["unrated_issues"], out["issues"]) == ([2, 8], [5], 3, 6)
    # Date-wise never sees the cancelled issue either: the same Total.
    assert _cut([_view(f.s, "day", *SPRING)[-1]], *TOTAL_FIGURES) == _cut([rows[-1]], *TOTAL_FIGURES)


def _known(values):
    """A column's money as a subtotal adds it: the known values, None when none is."""
    known = [v for v in values if v is not None]
    return round(sum(known), 2) if known else None


@pytest.mark.parametrize("group, view, key", [
    ("day", "day", "Date"), ("month", "month", "Month"), ("year", "year", "Year"), ("fy", "fy", "Financial Year")])
def test_issue_list_subtotals_agree_with_the_period_views(make, plant_at, group, view, key):
    f = _consumption_floor(make, plant_at)
    listed = _table(f.s, "list", *SPRING, group=group)
    assert listed["group"] == group                                     # asked for: a link's own grouping
    subtotals = [listed["rows"][i] for i in listed["subtotal_rows"]]
    shown = _view(f.s, view, *SPRING)
    periods = {}
    for r in shown[:-1]:
        periods.setdefault(r[key], []).append(r)
    assert [s["Date"] for s in subtotals] == [f"Subtotal {p}" for p in periods]
    for s, (period, rows) in zip(subtotals, periods.items()):
        assert int(s["Issue No"].split()[0]) == sum(r["Issues"] for r in rows), period
        assert (s["Qty Issued"], s["Net Qty"], s["Value"], s["Net Value"]) == (
            round(sum(r["Qty Issued"] for r in rows), 2), round(sum(r["Net Qty"] for r in rows), 2),
            _known(r["Value"] for r in rows), _known(r["Net Value"] for r in rows)), period
    assert _cut([listed["rows"][-1]], *TOTAL_FIGURES) == _cut([shown[-1]], *TOTAL_FIGURES)


@pytest.mark.parametrize("days, group, label", [
    (1, "day", "Subtotal 01.01.2018"), (62, "day", "Subtotal 01.01.2018"), (63, "month", "Subtotal Jan 2018"),
    (731, "month", "Subtotal Jan 2018"), (732, "year", "Subtotal 2018"), (1830, "year", "Subtotal 2018")])
def test_issue_list_subtotals_follow_the_range_length(make, days, group, label):
    """No toggle any more ("thoda simple ho" — the store, 17 Oct 2026): the
    Issue list is subtotalled by day up to 62 days, by month up to two years
    (731 days), by year past that — on screen, in its files and in the Full
    pack; a link's own group= still stands."""
    s, taker = make.store(), make.department()
    _issue(s, taker, qty=2, at=_utc(date(2018, 1, 1)))
    first, last = date(2018, 1, 1), date(2018, 1, 1) + timedelta(days=days - 1)
    out = _table(s, "list", first.isoformat(), last.isoformat())
    assert (out["window"]["days"], out["group"]) == (days, group)
    assert [out["rows"][i]["Date"] for i in out["subtotal_rows"]] == [label]
    assert _table(s, "list", first.isoformat(), last.isoformat(), group="fy")["group"] == "fy"
    buf, _, _ = ConsumptionTableService().pack(s.code, date_from=first.isoformat(), date_to=last.isoformat())
    wb = load_workbook(buf)
    assert label in [r[0] for r in wb["Issue list"].iter_rows(values_only=True)]
    summary = dict((k, v) for k, v in wb["Summary"].iter_rows(values_only=True) if v is not None)
    assert summary["Issue list subtotals"] == f"By {group}"


def test_issue_list_agrees_with_the_issue_register(make, plant_at):
    """The same issues as the Reports page's Issue Register for the same range,
    in the same order, with its date and time, reference, part, section, status
    and quantity — and the Register's Consumer as the Department."""
    f = _consumption_floor(make, plant_at)
    SpareStockLedger.query.filter_by(id=f.i4).update({"reference": "DOC-77"})
    db.session.commit()
    out = _table(f.s, "list", *SPRING, group="month")
    assert out["report"] == "consumption"
    skip = set(out["subtotal_rows"]) | {len(out["rows"]) - 1}
    issues = [r for i, r in enumerate(out["rows"]) if i not in skip]
    register = SpareReportService().build(f.s.code, "issue_register", *SPRING)[2]
    assert [r["Issue No"] for r in issues] == [r["Issue No"] for r in register] == [
        f.i1, f.i3, f.i2, f.i4, f.i5, f.i6, f.i7]
    for mine, theirs in zip(issues, register):
        assert f"{mine['Date']} {mine['Time']}" == theirs["Date & Time"], mine["Issue No"]
        assert _cut([mine], "Reference", "Part No", "Description", "Section", "Department", "Status",
                    "Qty Issued") == (
            _cut([theirs], "Reference", "Part No", "Description", "Section", "Consumer", "Status", "Qty Issued")), mine
    assert issues[3]["Reference"] == "DOC-77"


def test_issue_list_filters(make, plant_at):
    f = _consumption_floor(make, plant_at)

    def listed(**filters):
        out = _table(f.s, "list", *SPRING, **filters)
        skip = set(out["subtotal_rows"]) | {len(out["rows"]) - 1}
        return [r["Issue No"] for i, r in enumerate(out["rows"]) if i not in skip], out["rows"][-1]["Issue No"]

    assert listed(part_id=f.p1_id) == ([f.i1, f.i2], "2 issues")
    assert listed(section_id=f.s.live) == ([f.i1, f.i2, f.i7], "3 issues")
    # The department is the CONSUMING one, case and spaces aside — the
    # cancelled one listed, not counted...
    assert listed(department=f" {f.zed.upper()} ") == ([f.i3], "1 issue")
    assert listed(department=f.group) == ([f.i1, f.i2, f.i7], "3 issues")
    assert listed(department="No section") == ([f.i5, f.i6], "1 issue + 1 cancelled")
    # ... never the one written on the issue.
    assert listed(department=f.taker) == ([], "0 issues")
    assert listed(part_type="seal") == ([f.i4, f.i7], "2 issues")
    assert listed(section_id=f.s.live, part_type="Bearing") == ([f.i1, f.i2], "2 issues")
    assert _table(f.s, "list", "2026-03-11", "2026-03-31")["rows"] == [{
        **dict.fromkeys(LIST_COLUMNS), "Date": "Total", "Issue No": "0 issues", "Qty Issued": 0,
        "Qty Returned": 0, "Net Qty": 0, "Value": 0, "Net Value": 0}]


def test_person_wise(make):
    """Who the parts were handed to: one employee picked from the master is one
    row whatever was typed, with the latest name, code and mobile and every
    department their parts went to (the consuming one); a name written by hand
    is one row, case and spaces aside; "Not recorded" (nobody written) last."""
    from app.models.employee import Employee
    s, taker, other = make.store(), make.department(), make.department()
    maint = make.department(name=s.live_name)
    emp = Employee(mobile=f"6{uuid.uuid4().int % 10 ** 9:09d}", name=f"Ravi {_TAG}",
                   employee_code=f"E-{_TAG}-{_n()}")
    db.session.add(emp)
    db.session.commit()
    day = date(2019, 4, 2)
    p, a = _issue(s, taker, qty=2, section=s.live, at=_utc(day, 9), employee_id=emp.id)
    q, b = _issue(s, other, qty=3, at=_utc(day, 10), employee_id=emp.id, issued_to="Ravi K")
    _issue(s, taker, qty=1, at=_utc(day, 11), issued_to=" sunil ")
    _issue(s, taker, qty=4, at=_utc(day, 12), issued_to="Sunil")
    _issue(s, taker, qty=5, at=_utc(day, 13))
    Part.query.filter(Part.id.in_([p.id, q.id])).update({"unit_price": 10}, synchronize_session=False)
    db.session.commit()
    span = ("2019-04-02", "2019-04-02")

    rows = _view(s, "person", *span)
    assert _cut(rows, "Issued To", "Emp Code", "Department", *ISSUED) == [
        ("Ravi K", emp.employee_code, f"{maint.name}, No section", 2, 2, 5, 50),
        ("Sunil", None, "No section", 2, 2, 5, None),
        ("Not recorded", None, "No section", 1, 1, 5, None),
        ("Total", None, None, 5, 5, 15, 50)]
    listed = {r["Issue No"]: r for r in _view(s, "list", *span)}
    assert (listed[a]["Issued To"], listed[a]["Department"]) == (f"Ravi {_TAG}", maint.name)
    assert (listed[b]["Issued To"], listed[b]["Department"]) == ("Ravi K", "No section")


def test_the_filter_bar_offers_the_consuming_departments_only(client, make):
    """One report, one Department: the filter bar offers the consuming
    departments — never one only written on issues (the taker) — and no list of
    written departments any more."""
    s = make.store()
    maint = make.department(name=s.live_name)
    taker = make.department(name=f"Stores team {s.code}")
    _issue(s, taker, qty=2, section=s.live, at=_utc(date(2019, 5, 6), 9))
    c = _as(client, make.user(stores=(s.code,), perms=VIEW))
    body = c.get(f"/api/v1/consumption-analytics/options?store_code={s.code}").get_json()["data"]
    assert "issue_departments" not in body
    assert maint.name in body["departments"] and taker.name not in body["departments"]


def test_old_links_open_the_one_report(client, make, plant_at):
    """Links from before the merge keep working: no report named (before 17
    Oct 2026) or report=issuance (17 - 18 Oct) is this report, view for view;
    a link's group= still subtotals the list; the Department filter is the
    consuming one on the Issue list too (an old /issuance link's "taken by"
    department is dropped by the screen's redirect)."""
    f = _consumption_floor(make, plant_at)
    c = _as(client, make.user(role="ADMIN", stores=()))
    span = "from=2026-03-01&to=2026-04-30"
    for view in VIEWS:
        bodies = [c.get(f"{URL}?store_code={f.s.code}&view={view}{r}&{span}").get_json()["data"]
                  for r in ("", "&report=issuance", "&report=consumption")]
        assert bodies[0] == bodies[1] == bodies[2] and bodies[0]["report"] == "consumption", view
        assert bodies[0]["title"].startswith("Issuance & Consumption Report "), view

    def issues(out):
        skip = set(out["subtotal_rows"]) | {len(out["rows"]) - 1}
        return [(r["Issue No"], r["Department"]) for i, r in enumerate(out["rows"]) if i not in skip]

    old = c.get(URL, query_string={"store_code": f.s.code, "report": "issuance", "view": "list", "department": f.zed,
                                   "from": "2026-03-01", "to": "2026-04-30"}).get_json()["data"]
    assert issues(old) == [(f.i3, f.zed)] and old["rows"][-1]["Issue No"] == "1 issue"
    assert old["title"] == f"Issuance & Consumption Report Issue list {f.zed} 01.03.2026 to 30.04.2026"
    old_file = c.get(f"{URL}/export", query_string={"store_code": f.s.code, "view": "list", "format": "excel",
                                                    "department": f.zed, "from": "2026-03-01", "to": "2026-04-30"})
    assert _filename(old_file) == f"Issuance & Consumption Report Issue list {f.zed} 01.03.2026 to 30.04.2026.xlsx"
    rows, _ = _sheet(old_file)
    assert [r[2] for r in rows[1:4]] == [f.i3, "1 issue", "1 issue"]   # the issue, its day's subtotal, the Total
    monthly = c.get(f"{URL}?store_code={f.s.code}&view=list&group=month&{span}").get_json()["data"]
    assert [monthly["rows"][i]["Date"] for i in monthly["subtotal_rows"]] == ["Subtotal Mar 2026", "Subtotal Apr 2026"]
    for report in ("", "&report=issuance"):
        resp, wb = _pack(c, f"store_code={f.s.code}{report}&{span}")
        assert _filename(resp) == "Issuance & Consumption Report Full pack 01.03.2026 to 30.04.2026.xlsx"
        assert wb.sheetnames == PACK_SHEETS


def test_financial_year_view_cuts_at_the_plants_1_april(make, plant_at):
    f = _consumption_floor(make, plant_at)
    assert _cut(_view(f.s, "fy", *SPRING), "Financial Year", *FIGURES) == [
        ("FY 2025-26", 2, 2, 6, 20, 1, 5, 10),
        ("FY 2026-27", 4, 4, 12, 35, 0, 12, 35),                       # 31 Mar 20:00 UTC is 1 Apr at the plant
        ("Total", *FLOOR_TOTAL),
    ]
    # 23:59 on 31 March and 00:01 on 1 April at the plant — both 31 March in UTC.
    s, taker = make.store(), make.department()
    _issue(s, taker, qty=2, at=plant_at(date(2026, 3, 31), 23, 59))
    _issue(s, taker, qty=5, at=plant_at(date(2026, 4, 1), 0, 1))
    assert plant_at(date(2026, 4, 1), 0, 1).date() == date(2026, 3, 31)
    span = ("2025-04-01", "2026-04-30")
    assert _cut(_view(s, "fy", *span), "Financial Year", "Qty Issued") == [
        ("FY 2025-26", 2), ("FY 2026-27", 5), ("Total", 7)]
    assert _cut(_view(s, "year", *span), "Year", "Qty Issued") == [("2026", 7), ("Total", 7)]   # calendar: one year
    out = _table(s, "list", *span, group="fy")
    assert [out["rows"][i]["Date"] for i in out["subtotal_rows"]] == ["Subtotal FY 2025-26", "Subtotal FY 2026-27"]
    # The financial-year presets of 1 April split them the same way.
    for preset, qty in (("last_fy", 2), ("this_fy", 5)):
        first, last = preset_window(preset, date(2026, 4, 1))
        assert _view(s, "day", first.isoformat(), last.isoformat())[-1]["Qty Issued"] == qty, preset


def test_issue_list_excel_and_pdf(client, make, plant_at, monkeypatch):
    """The Issue list downloads as shown, in each grouping: subtotals and the
    Total bold, the cancelled issue grey, the notes under it — the cancelled one
    too. Its seventeen columns are fitted to the PDF page, the bold rows
    measured bold so they fit their columns."""
    f = _consumption_floor(make, plant_at)
    Part.query.filter_by(part_no=f.p1).update({"part_name": LONG})
    db.session.commit()
    drawn = _drawn_pdfs(monkeypatch)
    c = _as(client, make.user(role="ADMIN", stores=()))
    for group in ("day", "month", "year", "fy"):
        query = f"store_code={f.s.code}&view=list&group={group}&from=2026-03-01&to=2026-04-30"
        shown = c.get(f"{URL}?{query}").get_json()["data"]
        assert shown["title"] == "Issuance & Consumption Report Issue list 01.03.2026 to 30.04.2026", group
        n = len(shown["rows"])
        strong = {*shown["subtotal_rows"], n - 1}

        xlsx = c.get(f"{URL}/export?{query}&format=excel")
        assert xlsx.status_code == 200 and _filename(xlsx) == f"{shown['title']}.xlsx", group
        table, ws = _sheet(xlsx)
        assert list(table[0]) == shown["columns"]
        assert [list(r) for r in table[1:n + 1]] == [[r[col] for col in shown["columns"]] for r in shown["rows"]]
        assert {i for i in range(n) if ws.cell(row=i + 2, column=1).font.b} == strong, group
        assert [ws.cell(row=i + 2, column=5).font.color.rgb[-6:] for i in shown["cancelled_rows"]] == ["94A3B8"]
        assert [row[0] for row in table[n + 2:]] == [LEDGER_NOTE, UNRATED_NOTE, CANCELLED_NOTE], group

        pdf = c.get(f"{URL}/export?{query}&format=pdf")
        assert pdf.status_code == 200 and pdf.get_data()[:4] == b"%PDF", group
        assert _filename(pdf) == f"{shown['title']}.pdf"
        doc, story = drawn[-1]
        assert story[0].text == escape(shown["title"])
        assert [p.text for p in story[1:-2]] == [LEDGER_NOTE, UNRATED_NOTE, CANCELLED_NOTE]
        table = story[-1]
        frame = doc.pageTemplates[0].frames[0]
        assert table.wrap(frame._aW, frame._aH)[0] <= frame._aW + 1e-6, group
        bold = {i - 1 for i, row in enumerate(table._cellStyles) if row[0].fontname == pdf_io.BOLD}
        assert bold == strong, group
        for i in strong:
            for text, width in zip(table._cellvalues[i + 1], table._colWidths):
                for line in str(text).split("\n"):
                    assert stringWidth(line, pdf_io.BOLD, pdf_io.FIT_SIZE) <= width - 2 * pdf_io.FIT_PAD + 1e-6, (
                        group, line)


PACK_SHEETS = ["Summary", "Issue list", "Date-wise", "Month-wise", "Year-wise", "Part-wise", "Department-wise",
               "Issued to Dept-wise", "Issued to Dept & Part-wise", "Person-wise", "Category-wise"]


def _pack(c, query):
    resp = c.get(f"{URL}/pack?{query}")
    assert resp.status_code == 200, resp.get_json() if resp.is_json else None
    assert resp.mimetype == XLSX
    return resp, load_workbook(io.BytesIO(resp.get_data()))


def _pack_sheets_as_shown(c, wb, f, sheets, span, figures, totals):
    """Each sheet of the Full pack is the screen's view of the same range and
    filters, its Total `totals` and its notes those of the screen."""
    for name, view in sheets:
        shown = c.get(f"{URL}?store_code={f.s.code}&view={view}&{span}").get_json()["data"]
        rows = list(wb[name].iter_rows(values_only=True))
        n = len(shown["rows"])
        assert list(rows[0]) == shown["columns"], name
        assert [list(r) for r in rows[1:n + 1]] == [[r[col] for col in shown["columns"]] for r in shown["rows"]], name
        total = dict(zip(rows[0], rows[n]))
        assert rows[n][0] == "Total" and tuple(total[k] for k in figures) == totals, name
        notes = [r[0] for r in rows[n + 2:]]
        assert notes == [LEDGER_NOTE, UNRATED_NOTE] + ([CANCELLED_NOTE] if view == "list" else []), name
        assert wb[name].freeze_panes == "A2" and wb[name].auto_filter.ref.endswith(str(n + 1)), name


def test_full_pack(client, make, plant_at):
    """ONE workbook of the range and filters: a Summary, then each view's sheet
    exactly as the screen shows it — the Issue list first, subtotalled as on
    screen (by day: 61 days), Year-wise in financial years (the range holds 1
    April). Every sheet's Total is the same, and the Summary's."""
    f = _consumption_floor(make, plant_at)
    c = _as(client, make.user(role="ADMIN", stores=()))
    span = "from=2026-03-01&to=2026-04-30"
    resp, wb = _pack(c, f"store_code={f.s.code}&{span}")
    assert _filename(resp) == "Issuance & Consumption Report Full pack 01.03.2026 to 30.04.2026.xlsx"
    assert wb.sheetnames == PACK_SHEETS
    _pack_sheets_as_shown(c, wb, f, (
        ("Issue list", "list"), ("Date-wise", "day"), ("Month-wise", "month"), ("Year-wise", "fy"),
        ("Part-wise", "part"), ("Department-wise", "department"),
        ("Issued to Dept-wise", "issued_to"), ("Issued to Dept & Part-wise", "dept_part"), ("Person-wise", "person"),
        ("Category-wise", "category")),
        span, TOTAL_FIGURES, (18, 55, 1, 17, 45))
    listed = wb["Issue list"]
    assert [listed.cell(row=r, column=1).value for r in (4, 10, 11)] == [
        "Subtotal 10.03.2026", "Subtotal 01.04.2026", "Total"]
    assert all(listed.cell(row=r, column=1).font.b for r in (4, 10, 11))
    assert not listed.cell(row=2, column=1).font.b
    assert listed.cell(row=7, column=3).value == f.i5 and listed.cell(row=7, column=3).font.color.rgb[-6:] == "94A3B8"

    summary = list(wb["Summary"].iter_rows(values_only=True))
    assert summary[0] == ("Item", "Value")
    items = {k: v for k, v in summary[1:] if v is not None}
    assert {k: items[k] for k in ("Store", "Report", "From", "To", "Days", "Part", "Section",
                                  "Consuming department", "Category", "Year-wise sheet",
                                  "Issue list subtotals")} == {
        "Store": f"Consumption Store {f.s.code} ({f.s.code})", "Report": "Issuance & Consumption Report", "From": "01.03.2026",
        "To": "30.04.2026", "Days": 61, "Part": "All parts", "Section": "All sections",
        "Consuming department": "All departments", "Category": "All categories",
        "Year-wise sheet": "Financial years, 1 April to 31 March", "Issue list subtotals": "By day"}
    assert tuple(items[k] for k in ("Issues", "Cancelled issues (listed, not counted)", "Parts", "Qty Issued",
                                    "Value (today's rate)", "Qty Returned", "Net Qty",
                                    "Net Value (today's rate)")) == (6, 1, 5, 18, 55, 1, 17, 45)
    notes = [k for k, v in summary[1:] if k and v is None]
    assert notes[:4] == [LEDGER_NOTE, UNRATED_NOTE, CANCELLED_NOTE, "How it is counted:"]
    assert notes[4:] == [BASIS[k] for k in ConsumptionTableService.REPORTS["consumption"].basis]
    assert len(notes) == 11 and wb["Summary"].cell(row=len(summary), column=1).font.i


def test_full_pack_filtered_and_its_years(client, make, plant_at):
    """Filters narrow every sheet and are named in the file; a range holding no
    1 April is cut in calendar years; a financial year is one FY row."""
    f = _consumption_floor(make, plant_at)
    c = _as(client, make.user(role="ADMIN", stores=()))
    for report in ("consumption", "issuance"):
        resp, wb = _pack(c, f"store_code={f.s.code}&report={report}&from=2026-03-01&to=2026-03-31&part_id={f.p1_id}")
        assert _filename(resp) == f"Issuance & Consumption Report Full pack {f.p1} 01.03.2026 to 31.03.2026.xlsx"
        year = list(wb["Year-wise"].iter_rows(values_only=True))
        assert year[0][:2] == ("Year", "Issues") and year[1][:2] == ("2026", 1) and year[2][0] == "Total"
        summary = {k: v for k, v in wb["Summary"].iter_rows(values_only=True) if v is not None}
        assert (summary["Part"], summary["Issues"], summary["Qty Issued"]) == (f"{f.p1} - {f.p1_name}", 1, 2)
        assert summary["Year-wise sheet"] == "Calendar years, January to December"
        # Every sheet narrowed to the part: its one March issue, 2 issued.
        for name in PACK_SHEETS[1:]:
            rows = list(wb[name].iter_rows(values_only=True))
            total = dict(zip(rows[0], next(r for r in rows if r[0] == "Total")))
            assert total["Qty Issued"] == 2, (report, name)
        assert [r[0] for r in wb["Part-wise"].iter_rows(min_row=2, max_row=3, values_only=True)] == [f.p1, "Total"]

    resp, wb = _pack(c, f"store_code={f.s.code}&from=2025-04-01&to=2026-03-31")
    assert _filename(resp) == "Issuance & Consumption Report Full pack 01.04.2025 to 31.03.2026.xlsx"
    assert [r[:3] for r in wb["Year-wise"].iter_rows(values_only=True)][:3] == [
        ("Financial Year", "Issues", "Parts"), ("FY 2025-26", 2, 2), ("Total", 2, 2)]
    # A whole financial year (365 days): the Issue list by month.
    assert [r[0] for r in wb["Issue list"].iter_rows(values_only=True) if str(r[0]).startswith("Subtotal")] == [
        "Subtotal Mar 2026"]
    # A range the screen refuses is refused here too, and so is an unknown report.
    assert c.get(f"{URL}/pack?store_code={f.s.code}&from=2026-04-30&to=2026-03-01").status_code == 400
    assert c.get(f"{URL}/pack?store_code={f.s.code}&report=sales").status_code == 400


# ---- the store never takes an issue -------------------------------------------------------------

@pytest.mark.parametrize("name, store", [
    ("Store", True), ("  store ", True), ("SPARE  STORE", True), ("Spare Store", True), ("Tool Room", False),
    ("Storeroom", False), ("Stores team", False), ("", False), (None, False)])
def test_is_store_department(name, store):
    assert is_store_department(name) is store


def test_the_store_never_takes_an_issue(make):
    """The store hands parts out, so an issue to the store itself is refused —
    before a part leaves the shelf ("issuance me store dikha rha h jabki store to
    issue karta h" — the store, 18 Oct 2026). The Store department stays in the
    master for the store's own mails."""
    s = make.store()
    p = _part(s, qty=10)
    for name in ("Store", " store ", "Spare Store"):
        with pytest.raises(BadRequestError, match="The store hands parts out"):
            SpareStockService().issue(p.id, 1, name)
    assert SpareStockLedger.query.filter_by(part_id=p.id, txn_type="ISSUE").count() == 0
    ok = make.department(name=f"Stores team {s.code}")       # a name that only starts like it
    SpareStockService().issue(p.id, 1, ok.name)
    assert SpareStockLedger.query.filter_by(part_id=p.id, txn_type="ISSUE").count() == 1


def test_live_board_issue_month_reads_the_report(make, plant_at):
    """The Live Board's Issue & Consumption panel (the store, 22 Oct 2026:
    "kitna issue hua and kahan consume hua wo data mile") is the report's own
    department and machine views: the same Total, each department once (its
    sections summed), and where the parts went — the line / machine recorded on
    Confirm Installation, the most used first."""
    from app.services.spare_dashboard_service import SpareDashboardService
    f = _consumption_floor(make, plant_at)
    out = SpareDashboardService._issue_month(f.s.code, None, None, *SPRING)
    t = out["total"]
    assert (t["issues"], t["qty"], t["value"], t["returned"], t["net_qty"], t["net_value"]) == (6, 18, 55, 1, 17, 45)
    depts = {d["name"]: d for d in out["departments"]}
    assert (depts[f.group]["qty"], depts[f.group]["returned"], depts[f.group]["net_qty"],
            depts[f.group]["value"]) == (11, 1, 10, 50)
    assert depts[f.zed]["value"] is None                          # no rate: unknown, never 0
    assert out["departments"][0]["name"] == f.group               # the most issued first
    assert "places" not in out                                    # no "Used at" since 28 Oct 2026
    assert out["unrated_issues"] == _table(f.s, "department", *SPRING)["unrated_issues"]
    # A section group is read as its department.
    grouped = SpareDashboardService._issue_month(f.s.code, None, [f.s.live], *SPRING)
    assert [d["name"] for d in grouped["departments"]] == [f.group] and grouped["total"]["qty"] == 11
