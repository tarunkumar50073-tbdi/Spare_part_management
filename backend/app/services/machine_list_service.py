"""The plant's lines and machines for the issue form (the store, 13 Nov 2026:
"scan me jab part issue karte h to usme kis line par kis m/c par issue hua wo
bhi banana h").

Read from the department databases on the plant's PostgreSQL server, READ ONLY,
found the same way as the issue counter's rosters (roster_service):
  maintenance_db  maintenance_machines (zone_name, line_name, machine_no = the
                  machine code, machine_name, is_active, serial_no): every
                  machine of the plant, 282 on 13 Nov 2026;
  tool_room_db    tool_room_machines + tool_room_lines: the presses, Press-1..27
                  on Line 1-3 (no code column; the name is the code).

His choice (13 Nov 2026): Line + Machine are optional on the issue; an issue to
the Tool Room offers the presses, every other department the maintenance list.
The issue keeps the line (line_name) and the machine code (machine) as they
were picked; a machine list that cannot be read leaves the issue as it was.
"""
import logging
import threading
import time

from sqlalchemy import text

from app.services.roster_service import ROSTERS, _engine, _url

logger = logging.getLogger("dxstore.machines")

# The machine lists change a few times a year; read again at most this often.
CACHE_SECONDS = 600

_lock = threading.Lock()
_cache = {}


def _read_maintenance(conn):
    rows = conn.execute(text(
        "SELECT zone_name, line_name, machine_no, machine_name FROM maintenance_machines "
        "WHERE is_active IS NOT FALSE AND COALESCE(TRIM(machine_no), '') <> '' "
        "ORDER BY zone_name, line_name, serial_no NULLS LAST, machine_no"))
    return [(r.zone_name, r.line_name, r.machine_no, r.machine_name) for r in rows]


def _read_tool_room(conn):
    rows = conn.execute(text(
        "SELECT l.line_name, m.machine_name FROM tool_room_machines m "
        "LEFT JOIN tool_room_lines l ON l.id = m.line_id "
        "WHERE m.is_active IS NOT FALSE ORDER BY l.line_number NULLS LAST, m.machine_number, m.id"))
    return [("Tool Room", r.line_name, r.machine_name, r.machine_name) for r in rows]


READERS = {"MAINTENANCE": _read_maintenance, "TOOL_ROOM": _read_tool_room}


def source_for(department):
    """Which list a department's issue offers: the presses for the Tool Room
    (Press / General Tool Room too), the plant's machines for the rest."""
    return "TOOL_ROOM" if "tool" in (department or "").lower() else "MAINTENANCE"


def _clean(v):
    return " ".join(str(v).split()) if v is not None else ""


def group(rows):
    """[(zone, line, code, name)] -> lines in order, each with its machines.
    A blank line is "Other"; a name the same as the code is not repeated."""
    lines, index = [], {}
    for zone, line, code, name in rows:
        code = _clean(code)[:60]
        if not code:
            continue
        line = _clean(line).strip("_ ") or "Other"
        key = (_clean(zone), line)
        if key not in index:
            index[key] = {"zone": _clean(zone).strip("_ ") or None, "line": line[:60], "machines": []}
            lines.append(index[key])
        name = _clean(name)
        index[key]["machines"].append({"code": code, "name": name if name and name != code else None})
    return lines


class MachineListService:

    def lines(self, department, force=False):
        """{source, ok, error, lines: [{zone, line, machines: [{code, name}]}]}
        for an issue to `department`."""
        source = source_for(department)
        with _lock:
            hit = _cache.get(source)
            if hit and not force and time.monotonic() - hit["at"] < CACHE_SECONDS:
                return hit["data"]
        roster = next(r for r in ROSTERS if r.key == source)
        try:
            url = _url(roster)
            if url is None:
                raise RuntimeError(f"The {roster.department} machine list is not set up")
            with _engine(url).connect() as conn:
                if conn.dialect.name == "postgresql":
                    conn.execute(text("SET TRANSACTION READ ONLY"))
                data = {"source": source, "ok": True, "error": None, "lines": group(READERS[source](conn))}
        except Exception as exc:                              # unreachable, not set up, renamed table
            logger.warning("machine list %s not read: %s: %s", source, type(exc).__name__, exc)
            stale = (_cache.get(source) or {}).get("data")
            if stale:
                return stale
            return {"source": source, "ok": False, "error": f"{type(exc).__name__}: {str(exc)[:160]}",
                    "lines": []}
        with _lock:
            _cache[source] = {"at": time.monotonic(), "data": data}
        return data
