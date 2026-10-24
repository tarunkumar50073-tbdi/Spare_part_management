"""The Live Board's Stock Value Trend (management.value_trend): what the stock
was worth at the end of each day / week / month / year, worked back from
today's stock through the ledger at today's rate (the store, 24 Oct 2026:
"graph me dikhe ki inventory ka trand kya chal rha h month wise year wise").

Every case works on a section made for it, so the shared test database's other
parts never enter the figures."""
from datetime import datetime, time, timedelta

import pytest

from app.extensions import db
from app.models.base import utcnow
from app.models.part import Part
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.models.store import Section, Store
from app.services.consumption_analytics_service import _local_offset
from app.services.spare_management_service import SpareManagementService

STORE = "MAINTENANCE"
_seq = {"n": 0}


@pytest.fixture(autouse=True)
def mgmt_cache_off(app):
    before = app.config.get("SPARE_MGMT_CACHE_TTL")
    app.config["SPARE_MGMT_CACHE_TTL"] = 0
    try:
        yield
    finally:
        if before is None:
            app.config.pop("SPARE_MGMT_CACHE_TTL", None)
        else:
            app.config["SPARE_MGMT_CACHE_TTL"] = before


def _n():
    _seq["n"] += 1
    return _seq["n"]


def _today():
    return (utcnow().replace(tzinfo=None) + _local_offset()).date()


def _plant(day, clock=time(12)):
    """A plant-clock moment as the naive UTC instant the database stores."""
    return datetime.combine(day, clock) - _local_offset()


def _section():
    store = Store.query.filter_by(code=STORE).first()
    s = Section(store_id=store.id, name=f"VT {_n()}")
    db.session.add(s)
    db.session.commit()
    return s


def _part(sec, qty, rate, made):
    p = Part(part_no=f"VT-{_n()}", part_name="Value trend part", uom="NO", part_type="OTHER",
             store_code=STORE, section_id=sec.id, location="R1-S1-B1", unit_price=rate)
    db.session.add(p)
    db.session.commit()
    db.session.add(SpareStock(part_id=p.id, qty_on_hand=qty, created_at=_plant(made)))
    db.session.commit()
    return p


def _move(part, delta, txn_type, day):
    db.session.add(SpareStockLedger(part_id=part.id, qty_delta=delta, balance_after=0,
                                    txn_type=txn_type, created_at=_plant(day)))
    db.session.commit()


def _trend(sec):
    return SpareManagementService().management(STORE, section_id=sec.id)["value_trend"]


def _point(series, day):
    return next(p for p in series if p["key"] == day.isoformat())


def test_value_is_worked_back_through_the_ledger_at_todays_rate():
    today = _today()
    sec = _section()
    # A: opened at 12 twenty days ago, 2 issued three days ago -> 10 today, ₹100 each.
    a = _part(sec, 10, 100, today - timedelta(days=20))
    _move(a, 12, "OPENING", today - timedelta(days=20))
    _move(a, -2, "ISSUE", today - timedelta(days=3))
    # B: 4 loaded from Excel ten days ago, no ledger row, ₹50 each.
    _part(sec, 4, 50, today - timedelta(days=10))
    # C: stock but no rate — left out, counted.
    _part(sec, 5, None, today - timedelta(days=20))

    t = _trend(sec)
    assert t["value"] == 10 * 100 + 4 * 50                       # today: the Stock Value tile's Σ stock × rate
    assert t["since"] == (today - timedelta(days=20)).isoformat()
    assert t["unrated_parts"] == 1 and t["rate"] == "today"
    day = t["series"]["day"]
    assert _point(day, today - timedelta(days=20))["value"] == 1200    # A's opening only
    assert _point(day, today - timedelta(days=11))["value"] == 1200    # B not in yet
    assert _point(day, today - timedelta(days=10))["value"] == 1400    # B's load joins
    assert _point(day, today - timedelta(days=4))["value"] == 1400
    assert _point(day, today - timedelta(days=3))["value"] == 1200     # A's issue
    assert day[-1]["value"] == t["value"] and day[-1]["key"] == today.isoformat()
    # Nothing before the first stock on record: the line starts there.
    assert day[0]["key"] == (today - timedelta(days=20)).isoformat()
    # The load is named, so its step is not read as buying.
    assert t["loads"] == [{"date": (today - timedelta(days=10)).isoformat(), "parts": 1, "value": 200.0}]
    # Every view ends on today's value.
    for view in ("week", "month", "year"):
        assert t["series"][view][-1]["value"] == t["value"]
    assert t["series"]["year"][-1]["key"] == str(today.year)


def test_week_and_month_points_close_on_their_last_day():
    today = _today()
    sec = _section()
    start = today - timedelta(days=70)
    a = _part(sec, 3, 10, start)
    _move(a, 8, "OPENING", start)
    _move(a, -5, "ISSUE", today - timedelta(days=1))
    weeks = _trend(sec)["series"]["week"]
    assert all(p["from"] <= p["to"] for p in weeks)
    monday = today - timedelta(days=today.weekday())
    this_week = weeks[-1]
    assert this_week["from"] == monday.isoformat() and this_week["to"] == today.isoformat()
    # A week that closed before yesterday's issue still holds all 8.
    closed = [p for p in weeks if p["to"] < (today - timedelta(days=1)).isoformat()]
    assert closed and all(p["value"] == 80 for p in closed)
    months = _trend(sec)["series"]["month"]
    assert months[-1]["to"] == today.isoformat() and months[-1]["value"] == 30


def test_a_section_with_nothing_rated_has_no_trend():
    sec = _section()
    _part(sec, 5, None, _today())
    assert _trend(sec) is None
    assert _trend(_section()) is None
