"""Server-Sent Events stream (/api/v1/events) — pushes short "something changed"
nudges to connected dashboards so they refresh live instead of polling.

Guarded like every /api route (the browser's EventSource sends the session
cookie same-origin). Note: works on the threaded dev server; behind a buffering
proxy (or if a future prod server buffers) SSE may need proxy tuning — the app
keeps its React-Query refetch intervals as a fallback either way.
"""
import os
import queue
import threading

from flask import Blueprint, Response, g, stream_with_context

from app.utils.event_bus import subscribe, unsubscribe

bp = Blueprint("events", __name__, url_prefix="/api/v1/events")

_HEARTBEAT_SECONDS = 25

# Each open stream holds one server thread for as long as the tab is open
# (27 Nov 2026 audit: with waitress' 8 threads, ~8 open tabs froze the app for
# everyone). Streams are capped - in all and per login - well below the thread
# count; a tab over the cap gets 204, which tells the browser not to retry, and
# that tab simply refreshes on its normal poll timers instead.
_MAX_STREAMS = int(os.getenv("SSE_MAX_STREAMS", "12"))
_MAX_PER_USER = int(os.getenv("SSE_MAX_PER_USER", "3"))
_open = {"all": 0}
_open_lock = threading.Lock()


def _take(who):
    with _open_lock:
        if _open["all"] >= _MAX_STREAMS or _open.get(who, 0) >= _MAX_PER_USER:
            return False
        _open["all"] += 1
        _open[who] = _open.get(who, 0) + 1
        return True


def _give_back(who):
    with _open_lock:
        _open["all"] = max(0, _open["all"] - 1)
        left = _open.get(who, 0) - 1
        if left > 0:
            _open[who] = left
        else:
            _open.pop(who, None)


@bp.route("/stream", methods=["GET"])
def stream():
    user = getattr(g, "current_user", None)
    who = f"user:{user.id}" if user is not None else "machine"
    if not _take(who):
        return Response(status=204)
    done = []

    def release():                         # once, whichever end comes first
        if not done:
            done.append(True)
            _give_back(who)

    def gen():
        q = subscribe()
        try:
            yield ": connected\n\n"  # opens the stream promptly
            while True:
                try:
                    payload = q.get(timeout=_HEARTBEAT_SECONDS)
                    yield f"data: {payload}\n\n"
                except queue.Empty:
                    yield ": ping\n\n"  # heartbeat keeps the connection alive
        finally:
            unsubscribe(q)
            release()

    resp = Response(stream_with_context(gen()), mimetype="text/event-stream")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["X-Accel-Buffering"] = "no"  # disable proxy buffering if present
    resp.call_on_close(release)            # a tab gone before the first byte too
    return resp
