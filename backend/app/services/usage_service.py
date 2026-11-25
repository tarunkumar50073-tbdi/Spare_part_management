"""Where an issued spare was used - read from the departments' own apps.

21 Nov 2026 ("unhone wo part consume kar liya to mujhe consumption pta kaise
chalega" ... "haan 2 wala bana de"): the store issues a part; the Maintenance and
Tool Room apps record where it went. This reads those records, READ ONLY, and
puts them beside the store's issues:

* Maintenance - maintenance_db.maintenance_spare: part_no, spare_qty,
  used_date, zone / line / machine_no / machine_name, slip_id (the Maintenance
  app's own slip, not the store's issue). No store issue number is kept there,
  so a use is matched to an issue of that part to Maintenance by date, oldest
  issue first, and shown as an approximate match.
* Tool Room - tool_room_db.tool_room_spare_issue_use: issue_no (the store's
  issue: issue_register.issue_no = the issue's row id, or its slip number),
  qty, zone / line / machine_no, used_by_name, used_at. Exact match.

Nothing here writes, and a department database that cannot be read (no login
rights, not reachable) gives no rows - never an error to the store's screens.
The database is found as the roster finds it (ROSTER_*_DB_URL, else the store
database's server with the department's database name).
"""
import logging
from collections import defaultdict
from datetime import date, datetime

from sqlalchemy import bindparam, text

logger = logging.getLogger("dxstore.usage")

MAINTENANCE_SELECT = """
    SELECT id, upper(trim(part_no)) AS part_no, spare_qty, used_date, created_at, zone, line,
           machine_no, machine_name, slip_id, source{issue_col}
    FROM maintenance_spare WHERE upper(trim(part_no)) IN :parts
"""
# The column the Maintenance app may add for the store's issue number (25 Nov
# 2026: "wo khud dekh lenge"). Whichever of these it has is read, and a use
# that names an issue is matched to it exactly, not by part + date.
ISSUE_COLUMNS = ("store_issue_no", "issue_slip_no", "store_issue_slip_no", "dx_issue_no", "erp_issue_no",
                 "issue_no")
COLUMNS_SQL = text("SELECT column_name FROM information_schema.columns WHERE table_name = 'maintenance_spare'")

TOOL_ROOM_SQL = text("""
    SELECT id, trim(issue_no::text) AS issue_no, qty, zone, line, machine_no, used_by_name, used_by, used_at
    FROM tool_room_spare_issue_use WHERE trim(issue_no::text) IN :keys
""").bindparams(bindparam("keys", expanding=True))


def _num(v):
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return 0.0


def _day(v):
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    try:
        return datetime.fromisoformat(str(v).strip()[:19]).date()
    except ValueError:
        return None


def _where(zone, line, machine, name=None):
    parts = [p for p in (line or zone, machine) if p and str(p).strip()]
    text_ = " / ".join(str(p).strip() for p in parts) or "—"
    if name and str(name).strip():
        text_ += f" ({str(name).strip()})"
    return text_


def _read(roster_key, sql, **params):
    """Rows from a department database, or [] when it cannot be read."""
    from app.services.roster_service import ROSTERS, _engine, _url
    roster = next(r for r in ROSTERS if r.key == roster_key)
    try:
        url = _url(roster)
        if not url:
            return []
        with _engine(url).connect() as conn:
            conn.exec_driver_sql("SET TRANSACTION READ ONLY")
            return list(conn.execute(sql, params).mappings())
    except Exception:  # noqa: BLE001 - a department app's database never breaks the store's screens
        logger.warning("usage: %s not read", roster.database, exc_info=True)
        return []


def maintenance_uses(part_nos):
    """[{dept, part_no, qty, day, at, where, ref, source}] for these parts."""
    parts = sorted({str(p).strip().upper() for p in part_nos if p})
    if not parts:
        return []
    have = {r["column_name"] for r in _read("MAINTENANCE", COLUMNS_SQL)}
    col = next((c for c in ISSUE_COLUMNS if c in have), None)
    sql = text(MAINTENANCE_SELECT.format(issue_col=f", trim({col}::text) AS issue_ref" if col else "")
               ).bindparams(bindparam("parts", expanding=True))
    out = []
    for r in _read("MAINTENANCE", sql, parts=parts):
        qty = _num(r["spare_qty"])
        if qty <= 0:
            continue
        out.append({"dept": "Maintenance", "part_no": r["part_no"], "qty": qty,
                    "day": _day(r["used_date"]) or _day(r["created_at"]),
                    "at": r["created_at"] or r["used_date"],
                    "where": _where(r["zone"], r["line"], r["machine_no"], r["machine_name"]),
                    "ref": f"Maintenance slip {r['slip_id']}" if r["slip_id"] else None,
                    "by": None, "issue_id": None, "exact": False, "source": "maintenance_spare",
                    "key": (r.get("issue_ref") or None)})
    return out


def tool_room_uses(issue_keys):
    """Uses recorded against the store's issues (keys: row id or slip no., as text)."""
    keys = sorted({str(k).strip() for k in issue_keys if k is not None and str(k).strip()})
    if not keys:
        return []
    out = []
    for r in _read("TOOL_ROOM", TOOL_ROOM_SQL, keys=keys):
        qty = _num(r["qty"])
        if qty <= 0:
            continue
        out.append({"dept": "Tool Room", "key": r["issue_no"], "qty": qty, "day": _day(r["used_at"]),
                    "at": r["used_at"], "where": _where(r["zone"], r["line"], r["machine_no"]),
                    "ref": None, "by": r["used_by_name"] or r["used_by"], "issue_id": None, "exact": True,
                    "source": "tool_room_spare_issue_use"})
    return out


def usage_for_issues(issues, returned=None, part_nos=()):
    """{issue id: {"used", "where", "days", "exact", "uses"}} for these ISSUE ledger
    rows, plus the uses not matched to any of them. `returned`: {issue id: qty
    back}, so a use is never put on what came back.

    Tool Room uses name their issue. A Maintenance use is put on the oldest
    issue of its part to Maintenance given on or before its day that still has
    room (issued - returned - already used); what fits on none stays unmatched."""
    returned = returned or {}
    issues = [i for i in issues if i is not None]
    by_key = {}
    for i in issues:
        by_key[str(i.id)] = i
        if getattr(i, "issue_no", None):
            by_key[str(i.issue_no).strip()] = i
    out = defaultdict(lambda: {"used": 0.0, "where": [], "days": [], "exact": True, "uses": []})
    room = {i.id: max(abs(_num(i.qty_delta)) - _num(returned.get(i.id)), 0.0) for i in issues}
    unmatched = []

    def put(issue, use, qty, exact):
        d = out[issue.id]
        d["used"] = round(d["used"] + qty, 2)
        if use["where"] not in d["where"]:
            d["where"].append(use["where"])
        if use["day"] and use["day"] not in d["days"]:
            d["days"].append(use["day"])
        d["exact"] = d["exact"] and exact
        d["uses"].append({**use, "qty": qty, "issue_id": issue.id, "exact": exact})
        room[issue.id] = round(room[issue.id] - qty, 2)

    for use in tool_room_uses(by_key.keys()):
        issue = by_key.get(use["key"])
        if issue is None:
            unmatched.append(use)
        else:
            put(issue, use, use["qty"], True)

    parts = {i.part_id: (i.part.part_no if i.part else None) for i in issues}
    wanted = set(parts.values()) | {str(p).strip().upper() for p in part_nos if p}
    for use in sorted(maintenance_uses(wanted), key=lambda u: (u["day"] or date.min, str(u["at"]))):
        named = by_key.get(use.get("key") or "")
        if named is not None:
            put(named, use, use["qty"], True)       # the Maintenance app named the issue
            continue
        left = use["qty"]
        mine = sorted((i for i in issues
                       if (parts.get(i.part_id) or "").upper() == use["part_no"]
                       and "MAINT" in (i.department or "").upper()
                       and (use["day"] is None or (_day(i.created_at) or date.min) <= use["day"])),
                      key=lambda i: (i.created_at, i.id))
        for issue in mine:
            if left <= 0:
                break
            take = min(left, room.get(issue.id, 0.0))
            if take > 0:
                put(issue, use, take, False)
                left = round(left - take, 2)
        if left > 0:
            unmatched.append({**use, "qty": left})
    return dict(out), unmatched


def usage_for_part(part, issues, returned=None):
    """The part's uses for its history, each with the issue it was matched to
    (or none) - also when the store has no issue of it to match."""
    matched, unmatched = usage_for_issues(issues, returned, part_nos=[part.part_no])
    rows = [u for d in matched.values() for u in d["uses"]] + unmatched
    return sorted(rows, key=lambda u: (u["day"] or date.min, str(u["at"])), reverse=True)
