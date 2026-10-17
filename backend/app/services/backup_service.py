"""Daily automatic database backup.

The store asked on 16 Oct 2026 for "Roz ka automatic backup". Until then a copy
of the database was only ever taken by hand, right before a change (the
C:/dx_store_data/backup_before_*.db files), so a damaged disk or a bad edit on
an ordinary day had nothing recent to go back to. This worker takes the copy on
its own, once a day.

- When: every day at BACKUP_TIME on the plant clock ("HH:MM", default 23:00).
  A server that was down or restarting at that hour catches up as soon as it is
  up again: the backup is due whenever the latest BACKUP_TIME that has passed
  has no backup made after it. So a start-up after 23:00 with no backup today
  takes one at once, and so does the next morning's start after a night the
  laptop was off; an ordinary restart (every backend save reloads the server)
  finds the night's file and does nothing.
- How: SQLite's online backup API, read from a READ-ONLY connection — one
  consistent copy while the app keeps working (WAL: writers are not blocked)
  and the source is never written. The copy is made under a temp name, checked
  with PRAGMA integrity_check, and only then renamed to its real name, so a
  half-written or damaged file never looks like a backup.
- Where: a "backups" folder beside the database file, taken from the database
  URL — the TEST instance and the test suite back up their own databases, never
  the plant's. Named <database>_YYYY-MM-DD.db by plant date
  (dx_store_2026-10-16.db for the plant's dx_store.db, dx_store_TEST_... for the
  test copy); a second AUTOMATIC backup on the same day replaces that day's file.
  BACKUP_DIR names another folder instead: another drive, or a network share
  (\\\\server\\share\\... — opened in the form SQLite accepts, see _ro_uri).
- "Back up now" (Settings > System status) writes a file of its own,
  <database>_YYYY-MM-DD_HHMMSS_manual.db. It is the copy taken on the spot
  before a big change, so it must still be there after that night's automatic
  copy, which already has the change in it: the nightly run never replaces it,
  never prunes it and never counts it as the night's backup. The newest
  BACKUP_KEEP_MANUAL (default 10) of these are kept.
- Keeps the newest BACKUP_KEEP_DAYS (default 30) of this database's OWN dated
  files. The hand-made backup_before_* copies, the other database's backups and
  anything else in the folder are never touched.
- A backup dated in the future (the laptop clock was ahead when it was made) is
  not taken as the latest backup — it would hold the automatic backup off until
  that date — and is not ranked when pruning, so it never pushes a genuine
  recent backup out. It is left on disk and listed on System status.
- BACKUP_ENABLED=0 switches the automatic backup off ("Back up now" on Settings
  still works). Nothing to back up for an in-memory or non-SQLite database.

The last result is kept in memory for Settings > System status; after a restart
the newest file on disk tells the rest — no table, no schema change.
"""
import logging
import os
import re
import shutil
import sqlite3
import stat
import threading
import time as clock
from datetime import datetime, time, timedelta, timezone
from urllib.parse import quote

from flask import current_app
from sqlalchemy.engine import make_url

from app.extensions import db

logger = logging.getLogger("dxstore.backup")

BACKUP_DIR_NAME = "backups"
DEFAULT_TIME = "23:00"
DEFAULT_KEEP_DAYS = 30
KEEP_DAYS_RANGE = (1, 3650)
DEFAULT_KEEP_MANUAL = 10
KEEP_MANUAL_RANGE = (1, 365)
FIRST_TICK_SECONDS = 30      # let the server finish booting first
TICK_SECONDS = 60
# After a failed automatic backup, wait this long before the worker tries again,
# so a full disk is not hit (and logged) every minute.
RETRY_MINUTES = 30
# Never fill the disk the live database writes to: refuse a copy that would leave
# less than this free.
MIN_FREE_BYTES = 256 * 1024 * 1024
PARTIAL_SUFFIX = ".partial"
# The two kinds of backup file: the daily one (the worker) and the "Back up now"
# copy, which has its own name so the nightly run can never replace it.
DAILY = "daily"
MANUAL = "manual"
# A file's time on disk may run a little ahead of this clock (a network share
# stamps files with the file server's own clock); only a backup further ahead
# than this is taken as made by a clock that was wrong.
CLOCK_SKEW = timedelta(minutes=10)

_TIME_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")
_TRUE = ("1", "true", "yes", "on")
_FALSE = ("0", "false", "no", "off")

# Warnings already given in this process (see _warn_once).
_warned = set()


class BackupError(Exception):
    """A backup that could not be made; the message is shown to the admin."""


def _warn_once(text, *args):
    """A warning given once per process. The settings are read on every worker
    tick (once a minute) and every System status load: a typo in .env, or a
    backup dated in the future, is worth one line in the log, not one a minute."""
    key = text % args if args else text
    if key in _warned:
        return
    _warned.add(key)
    logger.warning(text, *args)


# ---- plant clock + settings ----

def _plant_now():
    """The plant clock: the server's local time (the same clock the reports
    measure with consumption_analytics_service._local_offset)."""
    return datetime.now()


def _utc_iso(ts):
    """A POSIX timestamp as naive-UTC ISO, the app's convention for times sent
    to the browser (lib/format.js parseServerTime shows it in plant time)."""
    return datetime.fromtimestamp(ts, timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds")


def _as_bool(value, default):
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower() if value is not None else ""
    if text in _TRUE:
        return True
    if text in _FALSE:
        return False
    return default


def _as_time(value):
    """"HH:MM" -> (hour, minute); anything else falls back to 23:00 with a
    warning — a typo in .env must not stop the server or the backup."""
    text = str(value).strip() if value is not None else ""
    m = _TIME_RE.match(text)
    if not m:
        if text:
            _warn_once("BACKUP_TIME %r is not HH:MM — using %s", text, DEFAULT_TIME)
        m = _TIME_RE.match(DEFAULT_TIME)
    return int(m.group(1)), int(m.group(2))


def _as_count(value, name, default, bounds):
    """A whole number from .env within `bounds`; anything else falls back to
    `default` with a (one-time) warning."""
    try:
        n = int(str(value).strip())
    except (TypeError, ValueError):
        if value not in (None, ""):
            _warn_once("%s %r is not a number — keeping %s", name, value, default)
        return default
    lo, hi = bounds
    if not lo <= n <= hi:
        _warn_once("%s %s is outside %s-%s — keeping %s", name, n, lo, hi, default)
        return default
    return n


def backup_settings(config=None):
    """The effective backup settings. app.config wins (tests set it there),
    else the environment (.env), else the defaults."""
    cfg = config if config is not None else current_app.config

    def pick(key):
        return cfg[key] if key in cfg else os.getenv(key)

    hour, minute = _as_time(pick("BACKUP_TIME"))
    folder = (pick("BACKUP_DIR") or "").strip() or None
    return {
        "enabled": _as_bool(pick("BACKUP_ENABLED"), True),
        "hour": hour,
        "minute": minute,
        "time": f"{hour:02d}:{minute:02d}",
        "keep_days": _as_count(pick("BACKUP_KEEP_DAYS"), "BACKUP_KEEP_DAYS",
                               DEFAULT_KEEP_DAYS, KEEP_DAYS_RANGE),
        "keep_manual": _as_count(pick("BACKUP_KEEP_MANUAL"), "BACKUP_KEEP_MANUAL",
                                 DEFAULT_KEEP_MANUAL, KEEP_MANUAL_RANGE),
        "dir": folder,
    }


# ---- where the database and its backups are ----

def database_file(url=None):
    """The database's file path, or None for an in-memory / non-SQLite one.
    Read from the engine's URL by default: Flask-SQLAlchemy has already turned
    a relative sqlite path into the real one there."""
    if url is None:
        url = db.engine.url
    elif isinstance(url, str):
        url = make_url(url)
    if not url.drivername.startswith("sqlite"):
        return None
    path = url.database or ""
    if path.startswith("file:"):     # sqlite:///file:...?uri=true
        if "mode=memory" in path or url.query.get("mode") == "memory":
            return None
        path = path[len("file:"):].split("?", 1)[0]
    if not path or path == ":memory:":
        return None
    return os.path.abspath(path)


def backup_folder(db_path, override=None):
    """The "backups" folder beside the database, unless BACKUP_DIR names one."""
    folder = override or os.path.join(os.path.dirname(db_path), BACKUP_DIR_NAME)
    return os.path.normpath(os.path.abspath(folder))


def _stem(db_path):
    return os.path.splitext(os.path.basename(db_path))[0]


def backup_name(db_path, day):
    """The daily backup: <database>_YYYY-MM-DD.db (plant date)."""
    return f"{_stem(db_path)}_{day:%Y-%m-%d}.db"


def manual_name(db_path, moment):
    """A "Back up now" copy: <database>_YYYY-MM-DD_HHMMSS_manual.db (plant
    clock) — a name the daily backup never uses, so that night's automatic
    copy cannot replace it."""
    return f"{_stem(db_path)}_{moment:%Y-%m-%d_%H%M%S}_{MANUAL}.db"


def _own_files(db_path, kind=DAILY):
    """Exactly this database's backups of one kind: <stem>_YYYY-MM-DD.db
    (daily) or <stem>_YYYY-MM-DD_HHMMSS_manual.db (Back up now). Nothing else in
    the folder ever matches — not backup_before_*, not the other database's
    <stem>_TEST_... files, not a .partial, not the other kind."""
    stem = re.escape(_stem(db_path))
    if kind == MANUAL:
        return re.compile(rf"^{stem}_(\d{{4}}-\d{{2}}-\d{{2}})_\d{{6}}_{MANUAL}\.db$")
    return re.compile(rf"^{stem}_(\d{{4}}-\d{{2}}-\d{{2}})\.db$")


def _own_partials(db_path):
    """Leftovers of a copy that was cut off (a server stopped mid-backup), of
    either kind: the temp file and the journal SQLite may have left beside it."""
    return re.compile(rf"^{re.escape(_stem(db_path))}_\d{{4}}-\d{{2}}-\d{{2}}(_\d{{6}}_{MANUAL})?\.db"
                      rf"{re.escape(PARTIAL_SUFFIX)}(-journal|-wal|-shm)?$")


def list_backups(db_path, folder=None, kind=DAILY):
    """This database's backups of one kind in the folder, newest first:
    [{file, path, day, size_bytes, mtime}]. A folder not made yet is simply
    empty; any other trouble reading it (no permission on a share, BACKUP_DIR
    naming a file) is raised as the OSError it is, for the caller to report."""
    folder = folder or backup_folder(db_path)
    pattern = _own_files(db_path, kind)
    try:
        names = os.listdir(folder)
    except FileNotFoundError:
        return []
    out = []
    for name in names:
        m = pattern.match(name)
        if not m:
            continue
        path = os.path.join(folder, name)
        try:
            st = os.stat(path)
        except FileNotFoundError:     # pruned between the listing and now
            continue
        if not stat.S_ISREG(st.st_mode):
            continue
        out.append({"file": name, "path": path, "day": m.group(1),
                    "size_bytes": st.st_size, "mtime": st.st_mtime})
    # A daily file is ranked by its date; a manual one by its date + time, both
    # in its name.
    out.sort(key=(lambda b: b["file"]) if kind == MANUAL else (lambda b: b["day"]), reverse=True)
    return out


def _in_future(backup, now):
    """Made by a clock that was ahead: dated after today, or stamped on disk
    further ahead of `now` than a file server's clock could be (CLOCK_SKEW)."""
    return (backup["day"] > now.date().isoformat()
            or datetime.fromtimestamp(backup["mtime"]) > now + CLOCK_SKEW)


# ---- when it is due ----

def last_slot(now, hour, minute):
    """The latest BACKUP_TIME that has already passed at `now` (plant clock):
    today's if it is past that time, else yesterday's."""
    today = datetime.combine(now.date(), time(hour, minute))
    return today if now >= today else today - timedelta(days=1)


def is_due(db_path, folder, hour, minute, now=None):
    """True when no daily backup of this database was made after the latest
    BACKUP_TIME that has passed. Judged from the files' own time on disk, so
    a restart (or a crash) can neither lose nor repeat the day's backup. A
    "Back up now" copy does not stand in for the night's backup, and a file
    dated in the future is passed over — taken as the latest it would hold the
    automatic backup off until that date came."""
    now = now or _plant_now()
    slot = last_slot(now, hour, minute)
    made = []
    for b in list_backups(db_path, folder):
        if _in_future(b, now):
            _warn_once("backup: %s is dated in the future (was the clock ahead when it was made?) "
                       "— not counted as a backup", b["file"])
            continue
        made.append(datetime.fromtimestamp(b["mtime"]))
    return not made or max(made) < slot


# ---- making one ----

def _ro_uri(path):
    """A read-only SQLite URI for a file path (Windows drive letters kept).
    A network path (\\\\server\\share\\...) needs four slashes: SQLite reads
    "file://server/..." as a URI authority and refuses it, while
    "file:////server/share/..." opens the share."""
    path = path.replace("\\", "/")
    if path.startswith("//"):
        path = "//" + path
    return "file:" + quote(path, safe="/:") + "?mode=ro"


def _copy(src_path, dst_path):
    """One consistent copy through SQLite's online backup API. The source is
    opened read-only, so this can never write to the live database."""
    src = sqlite3.connect(_ro_uri(src_path), uri=True, timeout=30)
    try:
        dst = sqlite3.connect(dst_path)
        try:
            src.backup(dst)
            # A plain rollback-journal file, not WAL: the backup then opens on
            # its own in any SQLite tool, with no -wal / -shm beside it.
            dst.execute("PRAGMA journal_mode=DELETE").fetchall()
        finally:
            dst.close()
    finally:
        src.close()


def _integrity(path):
    """PRAGMA integrity_check of a file, opened read-only: ['ok'] when sound."""
    con = sqlite3.connect(_ro_uri(path), uri=True)
    try:
        return [row[0] for row in con.execute("PRAGMA integrity_check").fetchall()]
    finally:
        con.close()


def _remove_quietly(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
    except OSError:
        logger.warning("backup: could not remove %s", path, exc_info=True)


def _clear_partials(db_path, folder):
    pattern = _own_partials(db_path)
    for name in os.listdir(folder):
        if pattern.match(name):
            _remove_quietly(os.path.join(folder, name))


def prune(db_path, folder, keep, kind=DAILY, today=None):
    """Delete this database's backups of one kind beyond the newest `keep`.
    Returns the names removed. Only files _own_files matches are candidates,
    and only those dated today or earlier are ranked: a file dated in the
    future (the clock was ahead) would otherwise always count as the newest and
    push a genuine recent backup out. It is left alone."""
    today = (today or _plant_now().date()).isoformat()
    current = [b for b in list_backups(db_path, folder, kind) if b["day"] <= today]
    removed = []
    for old in current[keep:]:
        try:
            os.remove(old["path"])
            removed.append(old["file"])
        except OSError:
            logger.warning("backup: could not delete old backup %s", old["path"], exc_info=True)
    return removed


def make_backup(db_path, folder=None, keep_days=DEFAULT_KEEP_DAYS, now=None,
                manual=False, keep_manual=DEFAULT_KEEP_MANUAL):
    """Copy, verify, rename, prune. Never raises: a failure comes back as
    {"ok": False, "error": ...} and leaves no half-made file behind, and the
    older backups are only pruned after a good new one is in place.

    manual=True is a "Back up now" copy: its own name (manual_name), and only
    the manual copies beyond the newest `keep_manual` are pruned. A daily one
    prunes only the dailies beyond `keep_days` — each kind leaves the other be."""
    started = clock.monotonic()
    now = now or _plant_now()
    folder = folder or backup_folder(db_path)
    name = manual_name(db_path, now) if manual else backup_name(db_path, now.date())
    final = os.path.join(folder, name)
    partial = final + PARTIAL_SUFFIX
    result = {"ok": False, "file": name, "folder": folder, "size_bytes": None, "at": None,
              "error": None, "pruned": [], "kind": MANUAL if manual else DAILY,
              "keep_days": keep_days, "keep_manual": keep_manual, "seconds": None}
    try:
        if not os.path.isfile(db_path):
            raise BackupError(f"Database file not found: {db_path}")
        os.makedirs(folder, exist_ok=True)
        _clear_partials(db_path, folder)
        wal = db_path + "-wal"
        need = os.path.getsize(db_path) + (os.path.getsize(wal) if os.path.isfile(wal) else 0)
        free = shutil.disk_usage(folder).free
        if free - need < MIN_FREE_BYTES:
            raise BackupError(f"Not enough free disk space in {folder} "
                              f"({free // (1024 * 1024)} MB free, the copy needs about {need // (1024 * 1024)} MB)")
        _copy(db_path, partial)
        check = _integrity(partial)
        if check != ["ok"]:
            raise BackupError("The copy failed its integrity check: " + "; ".join(check[:3]))
        os.replace(partial, final)
    except Exception as exc:  # noqa: BLE001 — reported to the caller, never raised
        for leftover in (partial, partial + "-journal", partial + "-wal", partial + "-shm"):
            _remove_quietly(leftover)
        result["error"] = str(exc) if isinstance(exc, BackupError) else f"{type(exc).__name__}: {exc}"
        result["at"] = _utc_iso(clock.time())
        result["seconds"] = round(clock.monotonic() - started, 2)
        return result

    st = os.stat(final)
    result.update(ok=True, size_bytes=st.st_size, at=_utc_iso(st.st_mtime))
    try:
        if manual:
            result["pruned"] = prune(db_path, folder, keep_manual, MANUAL, today=now.date())
        else:
            result["pruned"] = prune(db_path, folder, keep_days, DAILY, today=now.date())
    except Exception:  # noqa: BLE001 — the new backup is good; pruning waits for the next one
        logger.exception("backup: pruning old backups failed")
    result["seconds"] = round(clock.monotonic() - started, 2)
    return result


def _folder_error(folder, exc):
    return f"Cannot read the backup folder {folder} ({type(exc).__name__}: {exc})"


def _describe(backup):
    if not backup:
        return None
    return {"file": backup["file"], "size_bytes": backup["size_bytes"], "at": _utc_iso(backup["mtime"])}


# ---- the service: Settings + the worker ----

class BackupService:
    # Class-level: shared by the worker thread and the request threads.
    _lock = threading.Lock()          # one copy at a time (worker vs "Back up now")
    _last = None                      # the last attempt in this process
    _last_auto_failure = None         # monotonic time of the last failed automatic try
    _worker_started = False
    _thread = None

    def _where(self):
        """(settings, database file or None, backup folder or None)."""
        s = backup_settings()
        path = database_file()
        return s, path, (backup_folder(path, s["dir"]) if path else None)

    def run(self, trigger="MANUAL", user=None, now=None):
        """Make one backup now — the daily file for the worker (AUTO), a
        "Back up now" copy of its own otherwise. Returns the result dict;
        never raises."""
        try:
            s, path, folder = self._where()
        except Exception as exc:  # noqa: BLE001
            logger.exception("backup: could not read the backup settings")
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "trigger": trigger}
        if not path:
            return {"ok": False, "trigger": trigger,
                    "error": "This database is not a file (in-memory or not SQLite) — nothing to back up"}
        if not BackupService._lock.acquire(blocking=False):
            return {"ok": False, "busy": True, "trigger": trigger,
                    "error": "A backup is already running — try again in a minute"}
        try:
            result = make_backup(path, folder, s["keep_days"], now=now,
                                 manual=trigger != "AUTO", keep_manual=s["keep_manual"])
        finally:
            BackupService._lock.release()
        result.update(trigger=trigger, by=user)
        BackupService._last = result
        if result["ok"]:
            logger.info("backup (%s) saved %s, %s bytes, %ss; pruned %s", trigger, result["file"],
                        result["size_bytes"], result["seconds"], result["pruned"] or "none")
        else:
            logger.error("backup (%s) FAILED: %s", trigger, result["error"])
        return result

    def tick(self, now=None):
        """One worker check: back up if due. Returns the result, or None when
        nothing was done."""
        s, path, folder = self._where()
        if not s["enabled"] or not path:
            return None
        failed = BackupService._last_auto_failure
        if failed is not None and clock.monotonic() - failed < RETRY_MINUTES * 60:
            return None
        try:
            due = is_due(path, folder, s["hour"], s["minute"], now=now)
        except OSError as exc:
            # The folder cannot even be read (no permission on a share,
            # BACKUP_DIR naming a file): a failed automatic backup like any
            # other — shown on System status and retried after the same wait,
            # not a traceback in the log every minute.
            result = {"ok": False, "file": None, "folder": folder, "size_bytes": None,
                      "at": _utc_iso(clock.time()), "error": _folder_error(folder, exc),
                      "pruned": [], "kind": DAILY, "trigger": "AUTO", "by": None}
            BackupService._last = result
            BackupService._last_auto_failure = clock.monotonic()
            logger.error("backup (AUTO) FAILED: %s", result["error"])
            return result
        if not due:
            return None
        result = self.run(trigger="AUTO", now=now)
        if result.get("busy"):
            return result
        BackupService._last_auto_failure = None if result["ok"] else clock.monotonic()
        return result

    def status(self):
        """What Settings > System status shows: the switch, the time, how many
        are kept, the last attempt (this process), the newest good daily backup
        and "Back up now" copy on disk (they survive a restart), and any file
        dated in the future. A folder that cannot be read is reported in
        `error` with the box still available, so "Back up now" stays at hand."""
        s, path, folder = self._where()
        out = {"enabled": s["enabled"], "time": s["time"], "keep_days": s["keep_days"],
               "keep_manual": s["keep_manual"], "available": bool(path), "folder": folder,
               "count": 0, "newest": None, "manual_count": 0, "newest_manual": None,
               "future_dated": [], "error": None, "last": None}
        if not path:
            return out
        last = BackupService._last
        if last:
            out["last"] = {k: last.get(k) for k in
                           ("ok", "file", "size_bytes", "at", "error", "trigger", "by", "kind")}
        try:
            daily = list_backups(path, folder)
            manual = list_backups(path, folder, MANUAL)
        except OSError as exc:
            out["error"] = _folder_error(folder, exc)
            return out
        now = _plant_now()
        out["count"], out["manual_count"] = len(daily), len(manual)
        out["future_dated"] = sorted(b["file"] for b in daily + manual if _in_future(b, now))

        def newest(files):
            return max((b for b in files if not _in_future(b, now)), key=lambda b: b["mtime"], default=None)

        out["newest"] = _describe(newest(daily))
        out["newest_manual"] = _describe(newest(manual))
        return out

    @classmethod
    def start_worker(cls, app):
        """Start the "db-backup" thread, once per process, only when the
        automatic backup is on and the database is a file. Errors are logged;
        they never stop the server or the thread."""
        if cls._worker_started:
            return
        with app.app_context():
            s = backup_settings()
            path = database_file()
        if not s["enabled"]:
            logger.info("backup: automatic daily backup is switched off (BACKUP_ENABLED)")
            return
        if not path:
            return
        cls._worker_started = True

        def loop():
            delay = FIRST_TICK_SECONDS
            while True:
                clock.sleep(delay)
                delay = TICK_SECONDS
                try:
                    with app.app_context():
                        cls().tick()
                except Exception:  # noqa: BLE001 — never let the worker thread die
                    logger.exception("backup worker tick crashed")

        cls._thread = threading.Thread(target=loop, name="db-backup", daemon=True)
        cls._thread.start()
        logger.info("backup: daily backup of %s at %s into %s, keeping %s days",
                    path, s["time"], backup_folder(path, s["dir"]), s["keep_days"])
