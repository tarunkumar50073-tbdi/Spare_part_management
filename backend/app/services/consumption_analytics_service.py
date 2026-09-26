"""Consumption Analytics — what the Spare store issued over a chosen window,
set against the same-length window just before it.

Consumption is GROSS issued quantity: the ISSUE ledger rows, quantity =
-qty_delta. Returns are not netted off (a part issued and later sent back still
counts as issued), and the response says so in `basis`. Value is quantity x the
part's CURRENT unit rate — the ledger stores no rate per movement — so it is
labelled as valued at today's rate, never presented as a historical cost.

Days are plant-clock calendar days. created_at is stored in UTC, so each row is
dated after shifting it by the server's local offset; a UTC cut would put every
issue made before 05:30 on the previous day.

The ledger only goes back to the app's first write (`ledger_since`). A window,
a bucket or a baseline week before that is NOT a measured zero: the response
marks it (`complete`, `coverage`) and withholds any % change or spike reading
that would be built on it.

Two queries — every ISSUE row the window, its previous window and the spike
look-back touch, and the store's first ledger date — then one Python pass. No
SQLite-only strftime/date(), so it reads the same on any database.
"""
import statistics
from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import func, or_

from app.extensions import db
from app.models.department import Department
from app.models.part import Part
from app.models.spare_stock import SpareStockLedger
from app.models.store import Section, Store
from app.utils.exceptions import BadRequestError, NotFoundError

DEFAULT_DAYS = 30
MAX_DAYS = 400
GRANULARITIES = ("day", "week", "month")
TOP_PARTS = 10

# Spike rule: a part's last full week against the weeks before it.
SPIKE_WEEKS = 12
SPIKE_MIN_WEEKS = 8
SPIKE_SIGMA = 3

UNCATEGORISED = "Uncategorised"

# An issue with no machine yet is usually one the fitter has not confirmed —
# Stage 2 is where the machine gets recorded — not missing data.
AWAITING_STATUSES = ("PENDING_USER_CONFIRMATION", "ISSUED_BY_STORE")
AWAITING_MACHINE = "Awaiting fitter's confirmation"
NO_MACHINE = "Not recorded"

BASIS = {
    "quantity": "Gross issued quantity (ISSUE rows). Returns are not netted off.",
    "value": "Issued quantity x each part's current unit rate (valued at today's rate); "
             "parts with no rate are left out of the value.",
    "day": "Plant-clock calendar day of the issue.",
    "machine": f"'{AWAITING_MACHINE}' = issued, and the fitter has not yet confirmed the machine "
               f"(Stage 2); '{NO_MACHINE}' = confirmed or closed with no machine given.",
}


def _local_offset():
    """The server's UTC offset — the plant clock. Measured, not hardcoded, the
    same way SpareStockService reads its shift start."""
    return datetime.now().astimezone().utcoffset() or timedelta(0)


def _utc_naive(ts):
    """created_at comes back naive (SQLite, already UTC) or aware (other DBs);
    both become naive UTC so they compare and shift alike."""
    if ts is None:
        return None
    if isinstance(ts, str):
        ts = datetime.fromisoformat(ts)
    if ts.tzinfo is not None:
        ts = ts.astimezone(timezone.utc).replace(tzinfo=None)
    return ts


def _parse_day(value, name):
    if value in (None, ""):
        return None
    try:
        return date.fromisoformat(str(value).strip())
    except ValueError:
        raise BadRequestError(f"'{name}' must be a date as YYYY-MM-DD") from None


def _pct(now, base):
    """None, not a number, when there is no base to divide by."""
    if not base:
        return None
    return round((now - base) / base * 100, 1)


def _money(v):
    return round(v, 2)


def _weeks_ending(end, today=None):
    """The SPIKE_WEEKS Monday–Sunday weeks up to the last FULL week on or before
    `end`, oldest first — a week still running is not compared to whole ones.
    `today` is still being issued against, so a week can only end before it."""
    last_day = min(end, today - timedelta(days=1)) if today is not None else end
    last_sunday = last_day - timedelta(days=(last_day.weekday() + 1) % 7)
    return [(last_sunday - timedelta(days=6 + 7 * i), last_sunday - timedelta(days=7 * i))
            for i in reversed(range(SPIKE_WEEKS))]


def _buckets(start, end, granularity):
    """[(first_day, last_day)] covering the window. Weeks run Monday–Sunday and
    months are calendar months, so the first and last bucket may be partial."""
    out = []
    cur = start
    while cur <= end:
        if granularity == "day":
            nxt = cur + timedelta(days=1)
        elif granularity == "week":
            nxt = cur + timedelta(days=7 - cur.weekday())
        else:
            nxt = (cur.replace(day=1) + timedelta(days=32)).replace(day=1)
        out.append((cur, min(nxt - timedelta(days=1), end)))
        cur = nxt
    return out


def _bucket_label(first, granularity):
    # A week is named by its first day in the window; `from`/`to` carry the span.
    return first.strftime("%b %Y") if granularity == "month" else first.strftime("%d %b")


def _coverage(first, last, since):
    """How much of [first, last] the app's ledger was recording for."""
    if since is None or last < since:
        return "none"
    return "full" if first >= since else "partial"


def detect_spikes(weekly, weeks, since):
    """Parts whose last full week is out of line with the weeks before it.

    `weekly` is {part_id: {"info": {...}, "weeks": [qty per week]}} over
    `weeks` (oldest first, from _weeks_ending). Only weeks the ledger fully
    covers take part — a week before the ledger existed is unknown, not zero —
    and at least SPIKE_MIN_WEEKS of them are needed, or nothing is claimed.
    Flag: last week > mean + 3 x stdev of the prior weeks, and mean > 0 (a part
    never issued before has no baseline to spike above)."""
    covered = [i for i, (first, _) in enumerate(weeks) if since is not None and first >= since]
    if len(covered) < SPIKE_MIN_WEEKS:
        start = since.isoformat() if since else None
        return {
            "available": False,
            "reason": (f"needs {SPIKE_MIN_WEEKS}+ weeks of issue history; the app's ledger starts {start}"
                       if start else
                       f"needs {SPIKE_MIN_WEEKS}+ weeks of issue history; the app's ledger has no rows yet"),
            "ledger_since": start,
            "weeks_available": len(covered),
            "items": [],
        }

    last = covered[-1]
    base_idx = covered[:-1]
    items = []
    for pid, rec in weekly.items():
        series = rec["weeks"]
        base = [series[i] for i in base_idx]
        mean = statistics.fmean(base)
        if mean <= 0:
            continue
        sd = statistics.stdev(base) if len(base) > 1 else 0.0
        threshold = mean + SPIKE_SIGMA * sd
        now = series[last]
        if now > threshold:
            items.append({
                **rec["info"],
                "part_id": pid,
                "last_week_qty": round(now, 2),
                "mean": round(mean, 2),
                "stdev": round(sd, 2),
                "threshold": round(threshold, 2),
                "times_mean": round(now / mean, 1),
                "weekly": [round(series[i], 2) for i in covered],
            })
    items.sort(key=lambda s: (-s["times_mean"], -s["last_week_qty"]))
    return {
        "available": True,
        "rule": f"last full week > mean + {SPIKE_SIGMA} x stdev of the prior weeks, and mean > 0",
        "last_week": {"from": weeks[last][0].isoformat(), "to": weeks[last][1].isoformat()},
        "baseline_weeks": len(base_idx),
        "weeks": [weeks[i][0].isoformat() for i in covered],
        "items": items,
    }


class _Totals:
    __slots__ = ("qty", "lines", "value", "unvalued_lines", "parts")

    def __init__(self):
        self.qty = 0.0
        self.lines = 0
        self.value = 0.0
        self.unvalued_lines = 0
        self.parts = set()

    def add(self, pid, qty, value):
        self.qty += qty
        self.lines += 1
        self.parts.add(pid)
        if value is None:
            self.unvalued_lines += 1
        else:
            self.value += value

    def value_out(self):
        # Every line on a part with no rate: the value is unknown, not ₹0.
        if self.lines and self.unvalued_lines == self.lines:
            return None
        return _money(self.value)

    def out(self):
        return {"qty": round(self.qty, 2), "lines": self.lines, "parts": len(self.parts),
                "value": self.value_out(), "unvalued_lines": self.unvalued_lines}


def _ranked(groups):
    rows = [{"name": name, "key": key, **t.out()} for (name, key), t in groups.items()]
    rows.sort(key=lambda r: (-r["qty"], r["name"]))
    return rows


class ConsumptionAnalyticsService:

    def analytics(self, store_code, date_from=None, date_to=None, granularity=None,
                  section_id=None, department=None, part_type=None, part_id=None):
        offset = _local_offset()
        today = (datetime.now(timezone.utc).replace(tzinfo=None) + offset).date()
        start, end, clamped = self._window(date_from, date_to, today)
        days = (end - start).days + 1
        gran = self._granularity(granularity, days)
        prev_end = start - timedelta(days=1)
        prev_start = prev_end - timedelta(days=days - 1)
        weeks = _weeks_ending(end, today)

        department = (department or "").strip() or None
        part_type = (part_type or "").strip() or None
        part = self._part(store_code, part_id) if part_id is not None else None
        section = self._section(store_code, section_id) if section_id is not None else None

        rows = self._issue_rows(store_code, min(prev_start, weeks[0][0]), max(end, weeks[-1][1]), offset,
                                section_id, department, part_type, part_id)
        since = self._ledger_since(store_code, offset)

        buckets = _buckets(start, end, gran)
        slot = {}
        for i, (first, last) in enumerate(buckets):
            d = first
            while d <= last:
                slot[d] = i
                d += timedelta(days=1)
        series_cur = [_Totals() for _ in buckets]
        series_prev = [_Totals() for _ in buckets]
        cur, prev = _Totals(), _Totals()
        by_part, by_dept, by_section, by_type, by_machine = {}, {}, {}, {}, {}
        info = {}
        week_of = {}
        for i, (first, last) in enumerate(weeks):
            d = first
            while d <= last:
                week_of[d] = i
                d += timedelta(days=1)
        weekly = {}

        for (pid, delta, created, dept, machine, status, pno, pname, uom, rate,
             sec_id, sub_cat, sec_name, day) in rows:
            qty = -float(delta or 0)
            rate = float(rate) if rate is not None else None
            value = qty * rate if rate is not None else None
            if pid not in info:
                info[pid] = {"part_no": pno, "part_name": pname, "uom": uom, "unit_price": rate}

            if start <= day <= end:
                cur.add(pid, qty, value)
                series_cur[slot[day]].add(pid, qty, value)
                by_part.setdefault(pid, _Totals()).add(pid, qty, value)
                d_name = (dept or "").strip()
                by_dept.setdefault((d_name or "Not recorded", d_name or None), _Totals()).add(pid, qty, value)
                by_section.setdefault((sec_name or "Unassigned", sec_id), _Totals()).add(pid, qty, value)
                t_name = (sub_cat or "").strip() or UNCATEGORISED
                by_type.setdefault((t_name, t_name), _Totals()).add(pid, qty, value)
                m_name = (machine or "").strip()
                m_label = m_name or (AWAITING_MACHINE if status in AWAITING_STATUSES else NO_MACHINE)
                by_machine.setdefault((m_label, m_name or None), _Totals()).add(pid, qty, value)
            elif prev_start <= day <= prev_end:
                prev.add(pid, qty, value)
                # Laid over the current bucket the same distance into the window.
                series_prev[slot[day + timedelta(days=days)]].add(pid, qty, value)

            w = week_of.get(day)
            if w is not None:
                rec = weekly.get(pid)
                if rec is None:
                    rec = weekly[pid] = {"info": {"part_no": pno, "part_name": pname, "uom": uom},
                                         "weeks": [0.0] * len(weeks)}
                rec["weeks"][w] += qty

        cur_out, prev_out = cur.out(), prev.out()
        cur_cov = _coverage(start, end, since)
        prev_cov = _coverage(prev_start, prev_end, since)
        comparable = prev_cov == "full"
        prev_out["change_pct"] = {k: (_pct(cur_out[k], prev_out[k]) if comparable else None)
                                  for k in ("qty", "lines", "parts")}
        # Lines with no rate drop out of the value, so two windows with different
        # unrated shares would move by which parts carry a rate, not by usage.
        unrated = cur.unvalued_lines or prev.unvalued_lines
        prev_out["change_pct"]["value"] = (_pct(cur_out["value"], prev_out["value"])
                                           if comparable and not unrated else None)
        if since is None:
            note = "the app's ledger has no rows yet"
        elif not comparable:
            note = (f"the previous window ({prev_start.isoformat()} to {prev_end.isoformat()}) "
                    f"starts before the app's ledger ({since.isoformat()}), so there is no fair comparison")
        elif not prev_out["qty"]:
            note = "nothing was issued in the previous window, so no % change is shown"
        else:
            note = None
        prev_out["change_note"] = note
        prev_out["value_note"] = (
            f"{cur.unvalued_lines} of {cur.lines} issue lines in this window and {prev.unvalued_lines} "
            f"of {prev.lines} in the previous one are on parts with no rate, so the values are not like for like"
            if note is None and unrated else None)
        prev_out["coverage"] = prev_cov
        cur_out["coverage"] = cur_cov

        top = []
        for pid, t in sorted(by_part.items(), key=lambda kv: (-kv[1].qty, info[kv[0]]["part_no"]))[:TOP_PARTS]:
            p = info[pid]
            top.append({
                "part_id": pid, "part_no": p["part_no"], "name": p["part_name"], "uom": p["uom"],
                "qty": round(t.qty, 2), "lines": t.lines,
                "unit_price": p["unit_price"],
                "value": _money(t.value) if p["unit_price"] is not None else None,
                "share_pct": round(t.qty / cur.qty * 100, 1) if cur.qty else None,
            })

        series = []
        for i, (first, last) in enumerate(buckets):
            pf, pl = first - timedelta(days=days), last - timedelta(days=days)
            c, p = series_cur[i], series_prev[i]
            series.append({
                "key": first.isoformat(),
                "label": _bucket_label(first, gran),
                "from": first.isoformat(), "to": last.isoformat(),
                "previous_from": pf.isoformat(), "previous_to": pl.isoformat(),
                "qty": round(c.qty, 2), "lines": c.lines, "value": c.value_out(),
                "previous_qty": round(p.qty, 2), "previous_value": p.value_out(),
                "coverage": _coverage(first, last, since),
                "previous_coverage": _coverage(pf, pl, since),
            })

        return {
            "store_code": store_code,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            # A window ending today holds a day still in progress.
            "window": {"from": start.isoformat(), "to": end.isoformat(), "days": days,
                       "granularity": gran, "today": today.isoformat(), "clamped_to_today": clamped,
                       "ends_today": end == today},
            "previous_window": {"from": prev_start.isoformat(), "to": prev_end.isoformat(), "days": days},
            "filters": {
                "section_id": section_id,
                "section_name": section.name if section else None,
                "department": department,
                "type": part_type,
                "part_id": part_id,
                "part_no": part.part_no if part else None,
                "part_name": part.part_name if part else None,
            },
            "ledger_since": since.isoformat() if since else None,
            "basis": BASIS,
            "current": cur_out,
            "previous": prev_out,
            "series": series,
            "top_parts": top,
            "issued_parts": len(by_part),
            "by_department": _ranked(by_dept),
            "by_section": _ranked(by_section),
            "by_type": _ranked(by_type),
            "by_machine": _ranked(by_machine),
            "spikes": detect_spikes(weekly, weeks, since),
        }

    def options(self, store_code):
        """What the filter bar can offer: the store's sections, its part types
        (sub_category, with part counts) and the departments issues are booked
        to — the department master plus any name already on an ISSUE row."""
        sections = [
            {"id": sid, "name": name} for sid, name in
            db.session.query(Section.id, Section.name)
            .join(Store, Store.id == Section.store_id)
            .filter(Store.code == store_code, Section.is_active.is_(True))
            .order_by(Section.sort_order, Section.name)
        ]
        types = {}
        for sub, n in (db.session.query(Part.sub_category, func.count(Part.id))
                       .filter(Part.store_code == store_code, Part.is_active.is_(True))
                       .group_by(Part.sub_category)):
            name = (sub or "").strip() or UNCATEGORISED
            types[name] = types.get(name, 0) + n
        depts = {(n or "").strip() for (n,) in
                 db.session.query(Department.name).filter(Department.is_active.is_(True))}
        depts |= {(n or "").strip() for (n,) in
                  db.session.query(SpareStockLedger.department).distinct()
                  .join(Part, Part.id == SpareStockLedger.part_id)
                  .filter(Part.store_code == store_code, SpareStockLedger.txn_type == "ISSUE")}
        return {
            "sections": sections,
            "types": sorted(({"name": k, "parts": v} for k, v in types.items()),
                            key=lambda t: (-t["parts"], t["name"])),
            "departments": sorted(d for d in depts if d),
        }

    # ---------------------------------------------------------------- helpers

    @staticmethod
    def _window(date_from, date_to, today):
        start = _parse_day(date_from, "from")
        end = _parse_day(date_to, "to")
        clamped = False
        end = end or today
        # Days that have not happened yet would chart as zeros nobody measured.
        if end > today:
            end, clamped = today, True
        start = start or end - timedelta(days=DEFAULT_DAYS - 1)
        if start > end:
            raise BadRequestError("'from' must be on or before 'to' (and not after today)")
        span = (end - start).days + 1
        if span > MAX_DAYS:
            raise BadRequestError(f"The window is {span} days; the most is {MAX_DAYS}")
        return start, end, clamped

    @staticmethod
    def _granularity(value, days):
        if value in (None, ""):
            return "day" if days <= 62 else "week" if days <= 190 else "month"
        if value not in GRANULARITIES:
            raise BadRequestError(f"granularity must be one of {', '.join(GRANULARITIES)}")
        return value

    @staticmethod
    def _part(store_code, part_id):
        p = Part.query.filter(Part.id == part_id, Part.store_code == store_code).first()
        if p is None:
            raise NotFoundError(f"Part {part_id} is not in store '{store_code}'")
        return p

    @staticmethod
    def _section(store_code, section_id):
        s = (Section.query.join(Store, Store.id == Section.store_id)
             .filter(Section.id == section_id, Store.code == store_code).first())
        if s is None:
            raise NotFoundError(f"Section {section_id} is not in store '{store_code}'")
        return s

    @staticmethod
    def _issue_rows(store_code, first_day, last_day, offset, section_id, department, part_type, part_id):
        """Every ISSUE row between two plant days, with the part facts the
        breakdowns need — one query. Each row gains its plant day last."""
        lo = datetime.combine(first_day, time.min) - offset
        hi = datetime.combine(last_day + timedelta(days=1), time.min) - offset
        L = SpareStockLedger
        q = (db.session.query(L.part_id, L.qty_delta, L.created_at, L.department, L.machine, L.status,
                              Part.part_no, Part.part_name, Part.uom, Part.unit_price,
                              Part.section_id, Part.sub_category, Section.name)
             .join(Part, Part.id == L.part_id)
             .outerjoin(Section, Section.id == Part.section_id)
             .filter(Part.store_code == store_code, L.txn_type == "ISSUE",
                     L.created_at >= lo, L.created_at < hi))
        if section_id is not None:
            q = q.filter(Part.section_id == section_id)
        if department:
            q = q.filter(func.lower(func.trim(L.department)) == department.lower())
        if part_type:
            match = func.lower(func.trim(Part.sub_category)) == part_type.lower()
            if part_type.lower() == UNCATEGORISED.lower():
                match = or_(match, Part.sub_category.is_(None), func.trim(Part.sub_category) == "")
            q = q.filter(match)
        if part_id is not None:
            q = q.filter(L.part_id == part_id)
        out = []
        for r in q:
            ts = _utc_naive(r[2])
            out.append((*r, (ts + offset).date()))
        return out

    @staticmethod
    def _ledger_since(store_code, offset):
        """The plant day of the store's first ledger row of any kind — from then
        on a day with no ISSUE row is a measured zero; before it, unknown."""
        first = (db.session.query(func.min(SpareStockLedger.created_at))
                 .join(Part, Part.id == SpareStockLedger.part_id)
                 .filter(Part.store_code == store_code).scalar())
        first = _utc_naive(first)
        return (first + offset).date() if first else None
