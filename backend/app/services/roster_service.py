"""Who is on duty today — the issue counter's list of people (the store, 27 Oct
2026: "user k employee detail tool room and maintenance k db me h wahan se leni
h wo detail shift wise hi leni h ... jab koi material lene aayega to hum uske
code number ya naam se usme search karenge and wo select kar lenge").

Two rosters on the plant's PostgreSQL server, READ ONLY — nothing is ever
written there:
  maintenance_db  maintenance_employee (id, name, emp_code, designation, contact,
                  removed_on) and the daily maintenance_attendance_board (day,
                  staff_id, slot: A / B / G on duty; WO / LEAVE / WFH not here);
  tool_room_db    tool_room_attendance_members (id, name, emp_code, designation,
                  contact, in_attendance) and the daily tool_room_attendance
                  (att_date, member_id, status: A_SHIFT / B_SHIFT / G_SHIFT / P /
                  HALF_DAY / GATE_PASS on duty; LEAVE / PL / WEEKLY_OFF / W/OFF /
                  HOLIDAY not here).

The store chose (27 Oct 2026): everyone on duty TODAY is listed, with the
shift as a badge — no shift timings needed; a new person is added in the
Maintenance / Tool Room app and appears here by himself.

Each roster person is kept on the Employee master (source + external_id), so
an issue names him exactly as one typed in by hand (employee_id, code, mobile
at issue time) and Person-wise reports keep working. The roster decides who is
active: someone removed there is made inactive here, never deleted (past
issues point at him). A roster nobody has marked attendance on yet today lists
all its people, marked "Attendance not marked", rather than nobody.

The Employee master keeps up by itself (the store, 28 Oct 2026: "employee
master autoupdate hota rhe"): a background read every ROSTER_POLL_SECONDS
(300 = 5 minutes; 0 = off), one machine at a time (a PostgreSQL advisory lock
— the laptop and the server may both run it), besides the read the issue
screen and the Employee Master page ask for.

The databases are found from DATABASE_URL (same server and login, another
database) unless ROSTER_MAINTENANCE_DB_URL / ROSTER_TOOL_ROOM_DB_URL say
otherwise; "off" switches a roster off. On anything but PostgreSQL there is no
roster unless a URL is given.
"""
import logging
import threading
import time
from collections import namedtuple
from datetime import date, datetime, timezone

from flask import current_app
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from app.extensions import db
from app.models.employee import Employee, normalise_mobile

logger = logging.getLogger("dxstore.roster")

# key = Employee.source; department = the Department master name the people
# belong to; database = the default database name on the same server.
Roster = namedtuple("Roster", "key department database config read")

# A day's attendance mark -> the badge shown, for the marks that mean "on duty".
MAINTENANCE_DUTY = {"A": "A", "B": "B", "G": "G"}
TOOL_ROOM_DUTY = {"A_SHIFT": "A", "B_SHIFT": "B", "G_SHIFT": "G", "P": "Present",
                  "HALF_DAY": "Half day", "GATE_PASS": "Gate pass"}
NOT_MARKED = "Attendance not marked"
# A roster that could not be read: its people stay pickable, shift unknown.
UNKNOWN = "Shift not known"
# The list is read again at most this often (seconds); the rosters change a few
# times a shift, and the issue screen asks on every person search.
CACHE_SECONDS = 60
# How the badge sorts: shifts first, the rest after.
SHIFT_ORDER = {"A": 0, "B": 1, "G": 2, "Present": 3, "Half day": 4, "Gate pass": 5, NOT_MARKED: 9, UNKNOWN: 10}

_engines = {}
_lock = threading.Lock()
_cache = {"at": 0.0, "day": None, "duty": {}, "status": [], "read_at": None}
# One background roster read at a time across machines.
POLL_LOCK_KEY = 0x524F5354
_poller = {"started": False}


def _text(v, limit=None):
    t = str(v).strip() if v is not None else ""
    return (t[:limit] if limit else t) or None


def _read_maintenance(conn, today):
    people = [{"id": str(r.id), "name": r.name, "code": r.emp_code, "designation": r.designation,
               "contact": r.contact, "active": r.removed_on is None}
              for r in conn.execute(text("SELECT id, name, emp_code, designation, contact, removed_on "
                                         "FROM maintenance_employee"))]
    marks = {str(r.staff_id): (r.slot or "").strip().upper()
             for r in conn.execute(text("SELECT staff_id, slot FROM maintenance_attendance_board WHERE day = :d"),
                                   {"d": today})}
    return people, {k: MAINTENANCE_DUTY.get(v) for k, v in marks.items()}, bool(marks)


def _read_tool_room(conn, today):
    people = [{"id": str(r.id), "name": r.name, "code": r.emp_code, "designation": r.designation,
               "contact": r.contact, "active": r.in_attendance is not False}
              for r in conn.execute(text("SELECT id, name, emp_code, designation, contact, in_attendance "
                                         "FROM tool_room_attendance_members"))]
    marks = {str(r.member_id): (r.status or "").strip().upper()
             for r in conn.execute(text("SELECT member_id, status FROM tool_room_attendance WHERE att_date = :d"),
                                   {"d": today})}
    return people, {k: TOOL_ROOM_DUTY.get(v) for k, v in marks.items()}, bool(marks)


ROSTERS = (
    Roster("MAINTENANCE", "Maintenance", "maintenance_db", "ROSTER_MAINTENANCE_DB_URL", _read_maintenance),
    Roster("TOOL_ROOM", "Tool Room", "tool_room_db", "ROSTER_TOOL_ROOM_DB_URL", _read_tool_room),
)
SOURCES = tuple(r.key for r in ROSTERS)


def _url(roster):
    """The roster database's URL, or None when there is none to read."""
    import os
    given = current_app.config.get(roster.config) or os.environ.get(roster.config)
    if given:
        return None if given.strip().lower() == "off" else given.strip()
    main = make_url(current_app.config.get("SQLALCHEMY_DATABASE_URI") or "")
    if not main.drivername.startswith("postgresql"):
        return None
    return main.set(database=roster.database).render_as_string(hide_password=False)


def _engine(url):
    eng = _engines.get(url)
    if eng is None:
        eng = _engines[url] = create_engine(url, pool_pre_ping=True, pool_size=2, max_overflow=1,
                                            connect_args={"connect_timeout": 5})
    return eng


class RosterService:

    @staticmethod
    def read(roster, today):
        """(people, {external id: shift badge or None}, attendance marked today?)
        of one roster — read only, in a read-only transaction."""
        url = _url(roster)
        if url is None:
            raise RuntimeError(f"The {roster.department} roster is not set up")
        with _engine(url).connect() as conn:
            if conn.dialect.name == "postgresql":
                conn.execute(text("SET TRANSACTION READ ONLY"))
            return roster.read(conn, today)

    def refresh(self, force=False, today=None):
        """Read both rosters (at most once a minute unless forced) and bring
        the Employee master in line with them. A roster that cannot be read
        keeps its people as they were, with no shift, and says why."""
        today = today or date.today()
        with _lock:
            fresh = time.monotonic() - _cache["at"] < CACHE_SECONDS and _cache["day"] == today
            if fresh and not force:
                return _cache
            duty, status = {}, []
            for roster in ROSTERS:
                try:
                    people, shifts, marked = self.read(roster, today)
                except Exception as exc:                         # unreachable, not set up, renamed table
                    logger.warning("roster %s not read: %s: %s", roster.key, type(exc).__name__, exc)
                    status.append({"source": roster.key, "department": roster.department, "ok": False,
                                   "error": f"{type(exc).__name__}: {str(exc)[:160]}", "people": None,
                                   "on_duty": None, "marked": None})
                    continue
                self._mirror(roster, people)
                for p in people:
                    shift = shifts.get(p["id"]) if marked else NOT_MARKED
                    if shift and p["active"]:
                        duty[(roster.key, p["id"])] = shift
                status.append({"source": roster.key, "department": roster.department, "ok": True, "error": None,
                               "people": sum(1 for p in people if p["active"]),
                               "on_duty": sum(1 for k in duty if k[0] == roster.key), "marked": marked})
            db.session.commit()
            _cache.update(at=time.monotonic(), day=today, duty=duty, status=status,
                          read_at=datetime.now(timezone.utc).isoformat())
            return _cache

    def poll_once(self):
        """The background read: both rosters again (forced), unless another
        machine is reading them right now. True when it read."""
        if db.engine.dialect.name != "postgresql":
            self.refresh(force=True)
            return True
        conn = db.engine.connect()
        try:
            if not conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": POLL_LOCK_KEY}).scalar():
                return False
            try:
                self.refresh(force=True)
            finally:
                conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": POLL_LOCK_KEY})
                conn.commit()
            return True
        finally:
            conn.close()

    @staticmethod
    def start_poller(app):
        """Start the background roster read once per process; no-op when
        ROSTER_POLL_SECONDS is 0. Opens its own app context per read."""
        interval = app.config.get("ROSTER_POLL_SECONDS", 0)
        if not interval or interval <= 0 or _poller["started"]:
            return
        _poller["started"] = True

        def loop():
            time.sleep(10)  # let the app finish starting
            while True:
                try:
                    with app.app_context():
                        RosterService().poll_once()
                except Exception:  # noqa: BLE001 — never let the poller thread die
                    logger.exception("roster poll failed")
                time.sleep(interval)

        threading.Thread(target=loop, name="roster-poller", daemon=True).start()

    @staticmethod
    def _mirror(roster, people):
        """The roster's people on the Employee master: added, updated, or made
        inactive when the roster no longer has them. A code or mobile already
        another person's here is left off (logged), never taken from him."""
        mine = {e.external_id: e for e in Employee.query.filter_by(source=roster.key)}
        seen = set()
        for p in people:
            ext = p["id"]
            seen.add(ext)
            emp = mine.get(ext)
            me = emp.id if emp is not None else -1
            name = _text(p["name"], 80) or f"#{ext}"
            code = _text(p["code"], 30)
            if code and Employee.query.filter(Employee.employee_code == code, Employee.id != me).first():
                logger.warning("roster %s: code %s is another employee's here — left off %s", roster.key, code, name)
                code = None
            mobile = normalise_mobile(p["contact"])
            if mobile and Employee.query.filter(Employee.mobile == mobile, Employee.id != me).first():
                mobile = None
            want = {"name": name, "employee_code": code, "department": roster.department,
                    "designation": _text(p["designation"], 60), "mobile": mobile, "is_active": bool(p["active"])}
            if emp is None:
                emp = Employee(source=roster.key, external_id=ext, created_by="ROSTER", **want)
                db.session.add(emp)
                db.session.flush()
                continue
            if any(getattr(emp, k) != v for k, v in want.items()):
                for k, v in want.items():
                    setattr(emp, k, v)
                emp.updated_by = "ROSTER"
        for ext, emp in mine.items():
            if ext not in seen and emp.is_active:
                emp.is_active = False
                emp.updated_by = "ROSTER"

    def on_duty(self, q=None, force=False):
        """Today's people to pick from: everyone on duty in either roster (or
        all of a roster with no attendance marked yet), each with his shift
        badge; `q` matches the employee code or the name. With the rosters,
        how each was read."""
        state = self.refresh(force=force)
        duty = state["duty"]
        down = {s["source"] for s in state["status"] if not s["ok"]}
        rows = []
        for emp in Employee.query.filter(Employee.source.in_(SOURCES), Employee.is_active.is_(True)):
            shift = duty.get((emp.source, emp.external_id)) or (UNKNOWN if emp.source in down else None)
            if shift:
                rows.append({**emp.to_dict(), "shift": shift})
        text_ = (q or "").strip().lower()
        if text_:
            rows = [r for r in rows if text_ in (r["name"] or "").lower()
                    or text_ in (r["employee_code"] or "").lower()]
        rows.sort(key=lambda r: (SHIFT_ORDER.get(r["shift"], 8), (r["name"] or "").lower()))
        return {"rows": rows, "date": (state["day"] or date.today()).isoformat(), "rosters": state["status"],
                "read_at": state.get("read_at"),
                "poll_seconds": current_app.config.get("ROSTER_POLL_SECONDS", 0)}


def reset_cache():
    """Forget the last read (tests, and a forced refresh)."""
    with _lock:
        _cache.update(at=0.0, day=None, duty={}, status=[], read_at=None)
