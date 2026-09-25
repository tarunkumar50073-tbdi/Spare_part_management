"""Server-Sent Events stream (/api/v1/events) — pushes short "something changed"
nudges to connected dashboards so they refresh live instead of polling.

Guarded like every /api route (the browser's EventSource sends the session
cookie same-origin). Note: works on the threaded dev server; behind a buffering
proxy (or if a future prod server buffers) SSE may need proxy tuning — the app
keeps its React-Query refetch intervals as a fallback either way.
"""
import queue

from flask import Blueprint, Response, stream_with_context

from app.utils.event_bus import subscribe, unsubscribe

bp = Blueprint("events", __name__, url_prefix="/api/v1/events")

_HEARTBEAT_SECONDS = 25


@bp.route("/stream", methods=["GET"])
def stream():
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

    resp = Response(stream_with_context(gen()), mimetype="text/event-stream")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["X-Accel-Buffering"] = "no"  # disable proxy buffering if present
    return resp
