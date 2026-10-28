"""The issue counter's people come from the Maintenance and Tool Room rosters
(the store, 27 Oct 2026): everyone on duty today, with a shift badge, found by
code or name; kept on the Employee master (read only here); no mobile needed."""
from datetime import date

import pytest

from app.extensions import db
from app.models.department import Department
from app.models.employee import Employee
from app.models.part import Part
from app.services import roster_service
from app.services.employee_service import EmployeeService
from app.services.roster_service import NOT_MARKED, RosterService
from app.services.spare_stock_service import SpareStockService
from app.utils.exceptions import BadRequestError

TODAY = date(2026, 10, 27)


def _person(i, name, code, active=True):
    return {"id": str(i), "name": name, "code": code, "designation": "Technician", "contact": None, "active": active}


@pytest.fixture()
def rosters(monkeypatch):
    """Two fake rosters the test edits: {source: (people, shifts, marked) or an exception}."""
    data = {
        "MAINTENANCE": ([_person(1, "AMAN", "R483"), _person(2, "HEMANT", "R455"), _person(3, "OLD MAN", "R100", False),
                         _person(4, "ON LEAVE", "R101")],
                        {"1": "A", "2": "G", "4": None}, True),
        "TOOL_ROOM": ([_person(7, "Dinanath", "R147"), _person(8, "Kamlesh", "R131")], {}, False),
    }

    def read(roster, today):
        got = data[roster.key]
        if isinstance(got, Exception):
            raise got
        return got

    monkeypatch.setattr(RosterService, "read", staticmethod(read))
    roster_service.reset_cache()
    yield data
    roster_service.reset_cache()


def test_today_on_duty_with_shift_badges_found_by_code_or_name(rosters):
    out = RosterService().on_duty()
    got = [(r["name"], r["employee_code"], r["department"], r["shift"]) for r in out["rows"]]
    assert ("AMAN", "R483", "Maintenance", "A") in got and ("HEMANT", "R455", "Maintenance", "G") in got
    assert all(name not in {n for n, *_ in got} for name in ("OLD MAN", "ON LEAVE"))
    # No attendance marked yet in the Tool Room: all its people, said so.
    assert ("Dinanath", "R147", "Tool Room", NOT_MARKED) in got
    assert [r["name"] for r in out["rows"]].index("AMAN") < [r["name"] for r in out["rows"]].index("HEMANT")
    assert [r["name"] for r in RosterService().on_duty(q="r45")["rows"]] == ["HEMANT"]
    assert [r["name"] for r in RosterService().on_duty(q="kaml")["rows"]] == ["Kamlesh"]
    assert {s["source"]: (s["ok"], s["on_duty"]) for s in out["rosters"]} == {"MAINTENANCE": (True, 2), "TOOL_ROOM": (True, 2)}
    # Kept on the Employee master, no mobile; the one removed in the roster is inactive here.
    aman = Employee.query.filter_by(source="MAINTENANCE", external_id="1").one()
    assert (aman.mobile, aman.is_active) == (None, True)
    assert Employee.query.filter_by(source="MAINTENANCE", external_id="3").one().is_active is False


def test_roster_changes_follow_and_a_failed_read_keeps_the_people(rosters):
    RosterService().on_duty()
    people, shifts, _ = rosters["MAINTENANCE"]
    rosters["MAINTENANCE"] = ([p for p in people if p["id"] != "2"] + [_person(9, "NEW JOINER", "R777")],
                              {**shifts, "9": "B"}, True)
    out = RosterService().on_duty(force=True)
    names = {r["name"] for r in out["rows"]}
    assert "NEW JOINER" in names and "HEMANT" not in names
    assert Employee.query.filter_by(source="MAINTENANCE", external_id="2").one().is_active is False
    rosters["TOOL_ROOM"] = ConnectionError("server not reachable")
    out = RosterService().on_duty(force=True)
    tool = next(s for s in out["rosters"] if s["source"] == "TOOL_ROOM")
    assert tool["ok"] is False and "server not reachable" in tool["error"]
    assert Employee.query.filter_by(source="TOOL_ROOM", external_id="7").one().is_active is True
    assert ("Dinanath", "Shift not known") in {(r["name"], r["shift"]) for r in out["rows"]}


def test_a_roster_person_is_read_only_here_and_takes_parts_without_a_mobile(rosters):
    RosterService().on_duty()
    aman = Employee.query.filter_by(source="MAINTENANCE", external_id="1").one()
    with pytest.raises(BadRequestError, match="Maintenance roster"):
        EmployeeService().update(aman.id, {"name": "X"})
    # A person added here needs no mobile either.
    dept = Department.query.filter_by(name="Maintenance").first()
    if dept is None:
        dept = Department(name="Maintenance", is_active=True)
        db.session.add(dept)
        db.session.commit()
    added = EmployeeService().create({"name": "Contract Fitter", "department": dept.name})
    assert added["mobile"] is None and added["source"] is None
    part = Part(part_no="ROSTER-P1", part_name="ROSTER TEST BEARING", uom="NOS", part_type="OTHER",
                store_code="MAINTENANCE")
    db.session.add(part)
    db.session.commit()
    SpareStockService().set_quantity(part.id, 5, txn_type="OPENING")
    out = SpareStockService().issue(part.id, 1, dept.name, employee_id=aman.id, user="store")
    assert (out["issue"]["issued_to"], out["issue"].get("issued_to_code")) == ("AMAN", "R483")


def test_the_background_read_keeps_the_master_up_to_date(rosters, app):
    """28 Oct 2026: "employee master autoupdate hota rhe" — the poller's read
    is forced, so a change in the roster reaches the Employee master even
    while the last on-screen read is still fresh."""
    RosterService().on_duty()
    rosters["MAINTENANCE"][0].append(_person(9, "NEW JOINER", "R900"))
    rosters["MAINTENANCE"][1]["9"] = "B"
    assert RosterService().poll_once() is True
    new = Employee.query.filter_by(source="MAINTENANCE", external_id="9").one()
    assert (new.name, new.employee_code, new.is_active) == ("NEW JOINER", "R900", True)
    out = RosterService().on_duty(q="R900")
    assert [r["name"] for r in out["rows"]] == ["NEW JOINER"] and out["read_at"]


def test_the_poller_is_off_at_0(app):
    app.config["ROSTER_POLL_SECONDS"] = 0
    RosterService.start_poller(app)
    assert roster_service._poller["started"] is False
