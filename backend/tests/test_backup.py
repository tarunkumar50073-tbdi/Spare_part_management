"""Daily automatic database backup (the store's "Roz ka automatic backup",
16 Oct 2026): the copy is made, verified and named by plant date; old dated
copies are pruned beyond the keep count while backup_before_* and every other
file stay; the catch-up rule; the off switch; "Back up now" on Settings; and a
failure is reported, never raised.

Every backup here is of a scratch database in tmp_path, or of the suite's own
temp database into tmp_path — never the plant's."""
import os
import sqlite3
import time as clock
from datetime import datetime, timedelta

import pytest

from app.extensions import db
from app.models.user import User
from app.services import backup_service as bs
from app.services.backup_service import BackupService


def _source(tmp_path, name="src.db", rows=5, wal=True):
    """A small database in WAL mode, like the plant's."""
    path = str(tmp_path / name)
    con = sqlite3.connect(path)
    if wal:
        con.execute("PRAGMA journal_mode=WAL").fetchall()
    con.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
    con.executemany("INSERT INTO t (v) VALUES (?)", [(f"row{i}",) for i in range(rows)])
    con.commit()
    con.close()
    return path


def _touch(path, when, content=b"x"):
    with open(path, "wb") as fh:
        fh.write(content)
    ts = when.timestamp()
    os.utime(path, (ts, ts))


@pytest.fixture()
def fresh_state(monkeypatch):
    """Reset the class-level memory so one test's last result or back-off does
    not leak into the next."""
    monkeypatch.setattr(BackupService, "_last", None)
    monkeypatch.setattr(BackupService, "_last_auto_failure", None)


# ---- making one ----

def test_backup_is_made_verified_and_named_by_plant_date(tmp_path):
    src = _source(tmp_path)
    # A writer in the middle of a transaction: the copy must be consistent —
    # the committed rows, not the half-done insert.
    writer = sqlite3.connect(src)
    writer.execute("BEGIN IMMEDIATE")
    writer.execute("INSERT INTO t (v) VALUES ('uncommitted')")
    try:
        result = bs.make_backup(src, now=datetime(2026, 10, 16, 23, 0, 5))
    finally:
        writer.rollback()
        writer.close()

    folder = tmp_path / "backups"           # beside the database
    assert result["ok"] is True and result["error"] is None
    assert result["file"] == "src_2026-10-16.db"
    assert result["folder"] == str(folder)
    copy = folder / "src_2026-10-16.db"
    assert copy.is_file() and result["size_bytes"] == copy.stat().st_size
    con = sqlite3.connect(str(copy))
    try:
        assert con.execute("SELECT COUNT(*) FROM t").fetchone()[0] == 5
        assert con.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        # A self-contained file: rollback journal, not WAL.
        assert con.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
    finally:
        con.close()
    # Nothing half-made left behind, and the source was not touched.
    assert sorted(os.listdir(folder)) == ["src_2026-10-16.db"]
    assert sqlite3.connect(src).execute("SELECT COUNT(*) FROM t").fetchone()[0] == 5


def test_default_date_is_the_plant_clock_today(tmp_path):
    src = _source(tmp_path, "dx_store.db")
    result = bs.make_backup(src)
    assert result["ok"] and result["file"] == f"dx_store_{datetime.now():%Y-%m-%d}.db"


def test_same_day_backup_replaces_that_days_file(tmp_path):
    src = _source(tmp_path, rows=2)
    bs.make_backup(src, now=datetime(2026, 10, 16, 9, 0))
    con = sqlite3.connect(src)
    con.execute("INSERT INTO t (v) VALUES ('later')")
    con.commit()
    con.close()
    result = bs.make_backup(src, now=datetime(2026, 10, 16, 23, 0))
    assert result["ok"]
    files = os.listdir(tmp_path / "backups")
    assert files == ["src_2026-10-16.db"]
    copy = sqlite3.connect(str(tmp_path / "backups" / "src_2026-10-16.db"))
    assert copy.execute("SELECT COUNT(*) FROM t").fetchone()[0] == 3
    copy.close()


def test_prune_keeps_the_newest_and_never_touches_other_files(tmp_path):
    src = _source(tmp_path, "dx_store.db")
    folder = tmp_path / "backups"
    folder.mkdir()
    old = [f"dx_store_2026-10-{d:02d}.db" for d in range(10, 16)]   # six older dailies
    others = [
        "backup_before_mail_engine_2026-10-13.db",   # hand-made, must stay
        "dx_store_TEST_2026-10-01.db",                # the TEST copy's backup
        "dx_store_2026-10-01.db.bak",
        "dx_store_2026-10-01.db.old",
        "notes.txt",
        "dx_store_latest.db",
    ]
    for name in old + others:
        (folder / name).write_bytes(b"x")

    result = bs.make_backup(src, keep_days=3, now=datetime(2026, 10, 16, 23, 0))
    assert result["ok"]
    left = sorted(os.listdir(folder))
    kept = ["dx_store_2026-10-14.db", "dx_store_2026-10-15.db", "dx_store_2026-10-16.db"]
    assert left == sorted(kept + others)
    assert sorted(result["pruned"]) == [f"dx_store_2026-10-{d:02d}.db" for d in range(10, 14)]


def test_leftover_partial_from_a_cut_off_copy_is_cleared(tmp_path):
    src = _source(tmp_path)
    folder = tmp_path / "backups"
    folder.mkdir()
    (folder / "src_2026-10-15.db.partial").write_bytes(b"half")
    (folder / "src_2026-10-15.db.partial-journal").write_bytes(b"half")
    (folder / "other_2026-10-15.db.partial").write_bytes(b"not ours")
    assert bs.make_backup(src, now=datetime(2026, 10, 16, 23, 0))["ok"]
    assert sorted(os.listdir(folder)) == ["other_2026-10-15.db.partial", "src_2026-10-16.db"]


# ---- failures are reported, not raised ----

def test_missing_database_is_reported_not_raised(tmp_path):
    result = bs.make_backup(str(tmp_path / "nope.db"))
    assert result["ok"] is False and "not found" in result["error"]


def test_corrupt_source_is_reported_and_leaves_no_file(tmp_path):
    src = tmp_path / "broken.db"
    src.write_bytes(b"this is not a database" * 100)
    result = bs.make_backup(str(src), now=datetime(2026, 10, 16, 23, 0))
    assert result["ok"] is False and result["error"]
    assert os.listdir(tmp_path / "backups") == []


def test_failed_integrity_check_keeps_no_copy_and_prunes_nothing(tmp_path, monkeypatch):
    src = _source(tmp_path)
    folder = tmp_path / "backups"
    folder.mkdir()
    for d in range(1, 6):
        (folder / f"src_2026-10-{d:02d}.db").write_bytes(b"x")
    monkeypatch.setattr(bs, "_integrity", lambda path: ["row 7 missing from index ix_t"])
    result = bs.make_backup(src, keep_days=2, now=datetime(2026, 10, 16, 23, 0))
    assert result["ok"] is False and "integrity check" in result["error"]
    assert result["pruned"] == []
    # No new file under the real name, no temp file, the older five untouched.
    assert sorted(os.listdir(folder)) == [f"src_2026-10-{d:02d}.db" for d in range(1, 6)]


# ---- the catch-up rule ----

def test_due_rule(tmp_path):
    src = _source(tmp_path)
    folder = str(tmp_path / "backups")
    os.makedirs(folder)
    at = (23, 0)

    # No backup at all: due at once, whatever the hour (first start-up).
    assert bs.is_due(src, folder, *at, now=datetime(2026, 10, 16, 10, 0))

    path = os.path.join(folder, "src_2026-10-15.db")
    _touch(path, datetime(2026, 10, 15, 23, 0, 4))
    # Last night's is there and tonight's hour has not come: nothing to do —
    # an ordinary restart during the day takes no extra copy.
    assert not bs.is_due(src, folder, *at, now=datetime(2026, 10, 16, 10, 0))
    assert not bs.is_due(src, folder, *at, now=datetime(2026, 10, 16, 22, 59))
    # 23:00 has come: due.
    assert bs.is_due(src, folder, *at, now=datetime(2026, 10, 16, 23, 0))
    # Server down at 23:00 and up at 23:40 with no backup today: catch up.
    assert bs.is_due(src, folder, *at, now=datetime(2026, 10, 16, 23, 40))
    # Laptop off all night, started next morning: the missed night is caught up.
    assert bs.is_due(src, folder, *at, now=datetime(2026, 10, 17, 8, 0))

    # A copy made this morning ("Back up now") does not stand in for tonight's.
    _touch(os.path.join(folder, "src_2026-10-16.db"), datetime(2026, 10, 16, 9, 0))
    assert bs.is_due(src, folder, *at, now=datetime(2026, 10, 16, 23, 30))
    # Tonight's copy made: not due again until tomorrow 23:00.
    _touch(os.path.join(folder, "src_2026-10-16.db"), datetime(2026, 10, 16, 23, 0, 3))
    assert not bs.is_due(src, folder, *at, now=datetime(2026, 10, 16, 23, 59))
    assert not bs.is_due(src, folder, *at, now=datetime(2026, 10, 17, 22, 0))


def test_other_files_do_not_count_as_a_backup(tmp_path):
    src = _source(tmp_path, "dx_store.db")
    folder = str(tmp_path / "backups")
    os.makedirs(folder)
    now = datetime(2026, 10, 16, 23, 30)
    for name in ("backup_before_x_2026-10-16.db", "dx_store_TEST_2026-10-16.db", "dx_store_2026-10-16.db.partial"):
        _touch(os.path.join(folder, name), datetime(2026, 10, 16, 23, 10))
    assert bs.is_due(src, folder, 23, 0, now=now)


def test_tick_catches_up_once_then_waits(app, tmp_path, monkeypatch, fresh_state):
    monkeypatch.setitem(app.config, "BACKUP_ENABLED", True)
    monkeypatch.setitem(app.config, "BACKUP_DIR", str(tmp_path))
    monkeypatch.setitem(app.config, "BACKUP_TIME", "00:00")
    first = BackupService().tick()
    assert first and first["ok"] and first["trigger"] == "AUTO"
    assert first["file"] in os.listdir(tmp_path)
    # A restart a moment later finds the file and takes no second copy.
    assert BackupService().tick() is None


# ---- settings + the off switch ----

def test_settings_defaults_and_bad_values(monkeypatch):
    for key in ("BACKUP_ENABLED", "BACKUP_TIME", "BACKUP_KEEP_DAYS", "BACKUP_DIR"):
        monkeypatch.delenv(key, raising=False)
    s = bs.backup_settings({})
    assert (s["enabled"], s["time"], s["keep_days"], s["dir"]) == (True, "23:00", 30, None)
    s = bs.backup_settings({"BACKUP_ENABLED": "0", "BACKUP_TIME": "6:30", "BACKUP_KEEP_DAYS": "45"})
    assert (s["enabled"], s["time"], s["keep_days"]) == (False, "06:30", 45)
    # A typo in .env falls back to the default instead of stopping anything.
    s = bs.backup_settings({"BACKUP_ENABLED": "maybe", "BACKUP_TIME": "25:00", "BACKUP_KEEP_DAYS": "0"})
    assert (s["enabled"], s["time"], s["keep_days"]) == (True, "23:00", 30)
    monkeypatch.setenv("BACKUP_TIME", "22:15")
    assert bs.backup_settings({})["time"] == "22:15"


def test_disabled_switch_stops_the_automatic_backup(app, tmp_path, monkeypatch, fresh_state):
    monkeypatch.setitem(app.config, "BACKUP_ENABLED", False)
    monkeypatch.setitem(app.config, "BACKUP_DIR", str(tmp_path / "off"))
    assert BackupService().tick() is None
    assert not (tmp_path / "off").exists()
    # ...and no worker thread is started for it.
    monkeypatch.setattr(BackupService, "_worker_started", False)
    monkeypatch.setattr(BackupService, "_thread", None)
    BackupService.start_worker(app)
    assert BackupService._worker_started is False and BackupService._thread is None
    assert BackupService().status()["enabled"] is False


def test_no_backup_for_an_in_memory_database():
    assert bs.database_file("sqlite://") is None
    assert bs.database_file("sqlite:///:memory:") is None
    assert bs.database_file("postgresql://u@h/db") is None
    assert bs.database_file("sqlite:///C:/dx_store_data/dx_store.db").replace("\\", "/") \
        .endswith("dx_store_data/dx_store.db")


def test_folder_is_beside_the_database(app):
    path = bs.database_file()
    # The suite's own temp database, never the plant's.
    assert "dx_store_data" not in path
    assert bs.backup_folder(path) == os.path.join(os.path.dirname(path), "backups")
    assert bs.backup_folder("C:/data/dx_store_TEST.db") == os.path.normpath("C:/data/backups")
    assert bs.backup_name("C:/data/dx_store_TEST.db", datetime(2026, 10, 16)) == "dx_store_TEST_2026-10-16.db"


def test_failed_automatic_backup_waits_before_retrying(app, tmp_path, monkeypatch, fresh_state):
    monkeypatch.setitem(app.config, "BACKUP_ENABLED", True)
    monkeypatch.setitem(app.config, "BACKUP_DIR", str(tmp_path))

    def boom(src, dst):
        raise sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr(bs, "_copy", boom)
    result = BackupService().tick()
    assert result["ok"] is False and result["error"] == "OperationalError: disk I/O error"
    assert BackupService._last_auto_failure is not None
    assert BackupService().tick() is None                     # back-off: not every minute
    monkeypatch.setattr(BackupService, "_last_auto_failure", clock.monotonic() - bs.RETRY_MINUTES * 60 - 1)
    assert BackupService().tick()["ok"] is False              # tries again after the wait


# ---- Settings: System status + "Back up now" ----

_seq = {"n": 0}


def _user(role):
    _seq["n"] += 1
    u = User(username=f"backupuser{_seq['n']}", role=role, is_active=True)
    u.set_password("pw")
    db.session.add(u)
    db.session.commit()
    return u


def _login(client, user):
    with client.session_transaction() as sess:
        sess["user_id"] = user.id


@pytest.fixture()
def client(app, tmp_path, monkeypatch, fresh_state):
    monkeypatch.setitem(app.config, "BACKUP_DIR", str(tmp_path))
    return app.test_client()


def test_back_up_now_admin(client, tmp_path):
    _login(client, _user("ADMIN"))
    resp = client.post("/api/v1/admin/backup-now")
    assert resp.status_code == 200
    data = resp.get_json()["data"]
    assert data["ok"] is True and data["trigger"] == "MANUAL" and data["by"]
    assert data["kind"] == "manual" and data["file"].endswith("_manual.db")
    assert data["file"] in os.listdir(tmp_path)
    # System status now shows it — as the newest "Back up now" copy, not as the
    # night's daily backup (none made yet).
    backup = client.get("/api/v1/admin/system-status").get_json()["data"]["backup"]
    assert backup["last"]["ok"] is True and backup["last"]["file"] == data["file"]
    assert backup["newest_manual"]["file"] == data["file"] and backup["newest_manual"]["size_bytes"] > 0
    assert backup["newest"] is None and backup["count"] == 0 and backup["manual_count"] == 1
    assert backup["keep_days"] == 30 and backup["keep_manual"] == 10 and backup["available"] is True
    assert backup["error"] is None and backup["future_dated"] == []


def test_back_up_now_is_admin_only(client, app):
    assert client.post("/api/v1/admin/backup-now").status_code == 401        # not signed in
    _login(client, _user("STORE_USER"))
    assert client.post("/api/v1/admin/backup-now").status_code == 403        # not an admin
    # The shared machine key is not a person: it cannot press the button either.
    machine = app.test_client()
    resp = machine.post("/api/v1/admin/backup-now", headers={"X-API-Key": app.config["API_KEY"]})
    assert resp.status_code == 403


def test_back_up_now_failure_is_reported(client, monkeypatch, tmp_path):
    def boom(src, dst):
        raise OSError("No space left on device")

    monkeypatch.setattr(bs, "_copy", boom)
    _login(client, _user("ADMIN"))
    resp = client.post("/api/v1/admin/backup-now")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["data"]["ok"] is False and "No space left" in body["data"]["error"]
    assert "not made" in body["message"]
    assert os.listdir(tmp_path) == []
    backup = client.get("/api/v1/admin/system-status").get_json()["data"]["backup"]
    assert backup["last"]["ok"] is False and "No space left" in backup["last"]["error"]
    assert backup["newest"] is None and backup["newest_manual"] is None


# ---- "Back up now" copies are never replaced by the nightly run (review, 16 Oct 2026) ----

def _users_in(path):
    con = sqlite3.connect(path)
    try:
        return {name for (name,) in con.execute("SELECT username FROM users")}
    finally:
        con.close()


def test_a_manual_copy_survives_the_nightly_run(app, tmp_path, monkeypatch, fresh_state):
    """The copy taken on the spot before a big change must still hold the
    data from BEFORE the change after that night's automatic backup."""
    monkeypatch.setitem(app.config, "BACKUP_DIR", str(tmp_path))
    before = BackupService().run(trigger="MANUAL", user="admin", now=datetime(2026, 10, 16, 10, 12, 5))
    assert before["ok"] and before["kind"] == "manual"
    changed = _user("STORE_USER")                               # the "big change"
    nightly = BackupService().run(trigger="AUTO", now=datetime(2026, 10, 16, 23, 0))
    assert nightly["ok"] and nightly["kind"] == "daily"

    stem = os.path.splitext(os.path.basename(bs.database_file()))[0]
    assert before["file"] == f"{stem}_2026-10-16_101205_manual.db"
    assert nightly["file"] == f"{stem}_2026-10-16.db"
    assert sorted(os.listdir(tmp_path)) == sorted([before["file"], nightly["file"]])
    assert changed.username not in _users_in(str(tmp_path / before["file"]))
    assert changed.username in _users_in(str(tmp_path / nightly["file"]))

    # A second press later the same day is a file of its own as well.
    again = BackupService().run(trigger="MANUAL", now=datetime(2026, 10, 16, 15, 0))
    assert again["ok"] and again["file"] != before["file"]
    assert before["file"] in os.listdir(tmp_path)


def test_manual_copies_neither_count_as_the_night_nor_get_pruned_by_it(tmp_path):
    src = _source(tmp_path, "dx_store.db")
    folder = tmp_path / "backups"
    folder.mkdir()
    manual = [f"dx_store_2026-10-{d:02d}_090000_manual.db" for d in range(1, 6)]
    for name in manual:
        (folder / name).write_bytes(b"x")
    # A manual copy made after tonight's 23:00 still leaves the night's backup due.
    _touch(str(folder / "dx_store_2026-10-16_231000_manual.db"), datetime(2026, 10, 16, 23, 10))
    assert bs.is_due(src, str(folder), 23, 0, now=datetime(2026, 10, 16, 23, 30))

    # The nightly run with keep 1 prunes dailies only.
    (folder / "dx_store_2026-10-15.db").write_bytes(b"x")
    nightly = bs.make_backup(src, keep_days=1, now=datetime(2026, 10, 16, 23, 30))
    assert nightly["ok"] and nightly["pruned"] == ["dx_store_2026-10-15.db"]
    assert all((folder / name).exists() for name in manual)

    # A manual run keeps the newest `keep_manual` manual copies and no daily goes.
    made = bs.make_backup(src, now=datetime(2026, 10, 17, 8, 0), manual=True, keep_manual=2)
    assert made["ok"] and made["file"] == "dx_store_2026-10-17_080000_manual.db"
    assert sorted(made["pruned"]) == sorted(manual)          # the five older 1-5 Oct copies
    assert sorted(os.listdir(folder)) == ["dx_store_2026-10-16.db", "dx_store_2026-10-16_231000_manual.db",
                                          "dx_store_2026-10-17_080000_manual.db"]


def test_a_cut_off_manual_copy_is_cleared_too(tmp_path):
    src = _source(tmp_path)
    folder = tmp_path / "backups"
    folder.mkdir()
    (folder / "src_2026-10-16_101205_manual.db.partial").write_bytes(b"half")
    assert bs.make_backup(src, now=datetime(2026, 10, 16, 23, 0))["ok"]
    assert os.listdir(folder) == ["src_2026-10-16.db"]


# ---- a network share for BACKUP_DIR (review, 16 Oct 2026) ----

def test_read_only_uri_for_a_network_path():
    # "file://server/..." would be read as a URI authority and refused.
    assert bs._ro_uri("\\\\TBDI-01\\backup$\\dx\\x.db") == "file:////TBDI-01/backup%24/dx/x.db?mode=ro"
    assert bs._ro_uri("C:\\dx_store_data\\dx_store.db") == "file:C:/dx_store_data/dx_store.db?mode=ro"


def test_a_backup_onto_a_network_share_is_made_and_verified(tmp_path):
    """A real \\\\host\\share path: this machine's own administrative share of
    the temp folder. Skipped where that share is not open."""
    drive, rest = os.path.splitdrive(str(tmp_path))
    if not drive.endswith(":"):
        pytest.skip("not a drive-letter temp folder")
    share = "\\\\localhost\\" + drive[0] + "$" + rest
    if not os.path.isdir(share):
        pytest.skip("the administrative share is not available here")
    src = _source(tmp_path)
    result = bs.make_backup(src, folder=os.path.join(share, "unc_backups"), now=datetime(2026, 10, 16, 23, 0))
    assert result["ok"] is True, result["error"]
    assert os.listdir(tmp_path / "unc_backups") == ["src_2026-10-16.db"]


# ---- a clock that was ahead (review, 16 Oct 2026) ----

def test_a_future_dated_backup_neither_blocks_nor_crowds_out(tmp_path, monkeypatch):
    monkeypatch.setattr(bs, "_warned", set())
    src = _source(tmp_path)
    folder = tmp_path / "backups"
    folder.mkdir()
    future = folder / "src_2027-01-05.db"
    _touch(str(future), datetime(2027, 1, 5, 23, 0))
    # Taken as the latest it would stop every automatic backup until January.
    assert bs.is_due(src, str(folder), 23, 0, now=datetime(2026, 10, 20, 23, 30))

    for day in (20, 21):
        assert bs.make_backup(src, keep_days=2, now=datetime(2026, 10, day, 23, 0))["ok"]
        ts = datetime(2026, 10, day, 23, 0, 5).timestamp()     # as if made that night
        os.utime(folder / f"src_2026-10-{day}.db", (ts, ts))
    # Both genuine backups kept; the future one is not ranked, so not deleted either.
    assert sorted(os.listdir(folder)) == ["src_2026-10-20.db", "src_2026-10-21.db", "src_2027-01-05.db"]
    assert not bs.is_due(src, str(folder), 23, 0, now=datetime(2026, 10, 21, 23, 30))
    # The third night prunes the 20th, still not the future file.
    result = bs.make_backup(src, keep_days=2, now=datetime(2026, 10, 22, 23, 0))
    assert result["pruned"] == ["src_2026-10-20.db"]
    assert future.exists()


def test_status_flags_a_future_dated_backup(app, tmp_path, monkeypatch, fresh_state):
    monkeypatch.setitem(app.config, "BACKUP_DIR", str(tmp_path))
    stem = os.path.splitext(os.path.basename(bs.database_file()))[0]
    today = datetime.now()
    good = tmp_path / f"{stem}_{today:%Y-%m-%d}.db"
    _touch(str(good), today)
    ahead = today + timedelta(days=400)
    _touch(str(tmp_path / f"{stem}_{ahead:%Y-%m-%d}.db"), ahead)
    status = BackupService().status()
    assert status["future_dated"] == [f"{stem}_{ahead:%Y-%m-%d}.db"]
    assert status["newest"]["file"] == good.name and status["count"] == 2


# ---- a folder that cannot be read (review, 16 Oct 2026) ----

def test_an_unreadable_backup_folder_is_a_recorded_failure(app, tmp_path, monkeypatch, fresh_state):
    """BACKUP_DIR naming a file: the worker records a failed automatic backup
    (System status shows it, the 30-minute wait applies) instead of raising
    every minute, and System status keeps the box — and "Back up now"."""
    not_a_folder = tmp_path / "backups.txt"
    not_a_folder.write_text("a file, not a folder")
    monkeypatch.setitem(app.config, "BACKUP_ENABLED", True)
    monkeypatch.setitem(app.config, "BACKUP_DIR", str(not_a_folder))

    result = BackupService().tick()
    assert result["ok"] is False and result["trigger"] == "AUTO"
    assert result["error"].startswith("Cannot read the backup folder")
    assert BackupService._last_auto_failure is not None
    assert BackupService().tick() is None                    # back-off, not every minute

    status = BackupService().status()
    assert status["available"] is True
    assert status["error"].startswith("Cannot read the backup folder")
    assert status["last"]["ok"] is False and status["last"]["trigger"] == "AUTO"


def test_a_bad_env_value_is_warned_about_once(monkeypatch, caplog):
    monkeypatch.setattr(bs, "_warned", set())
    cfg = {"BACKUP_TIME": "25:00", "BACKUP_KEEP_DAYS": "lots", "BACKUP_KEEP_MANUAL": "0"}
    with caplog.at_level("WARNING", logger="dxstore.backup"):
        for _ in range(5):                                    # five worker ticks
            s = bs.backup_settings(cfg)
    assert (s["time"], s["keep_days"], s["keep_manual"]) == ("23:00", 30, 10)
    texts = [r.getMessage() for r in caplog.records]
    assert sum("BACKUP_TIME" in t for t in texts) == 1
    assert sum("BACKUP_KEEP_DAYS" in t for t in texts) == 1
    assert sum("BACKUP_KEEP_MANUAL" in t for t in texts) == 1
