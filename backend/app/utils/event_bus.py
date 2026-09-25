"""A tiny in-process publish/subscribe bus for Server-Sent Events.

Single-process only (the app runs as one Waitress/Werkzeug server): each live SSE
connection registers a queue, and publish() fans a short "something changed"
message out to every queue. It is NOT a cross-process message broker — just
enough to nudge connected dashboards to refresh without polling. A slow or full
subscriber is skipped, never allowed to break the caller (a stock movement must
not fail because a browser tab stopped reading).
"""
import json
import queue
import threading

_lock = threading.Lock()
_subscribers = set()


def subscribe():
    q = queue.Queue(maxsize=100)
    with _lock:
        _subscribers.add(q)
    return q


def unsubscribe(q):
    with _lock:
        _subscribers.discard(q)


def subscriber_count():
    with _lock:
        return len(_subscribers)


def publish(event, data=None):
    """Fan an event out to every connected subscriber (non-blocking)."""
    payload = json.dumps({"event": event, "data": data or {}})
    with _lock:
        subs = list(_subscribers)
    for q in subs:
        try:
            q.put_nowait(payload)
        except queue.Full:
            pass
