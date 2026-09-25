"""A tiny in-process sliding-window rate limiter.

No external dependency: flask-limiter would add one purely to protect a
single-process Waitress deployment on a trusted LAN, where an in-memory counter
is enough. Keyed by an arbitrary string (logins are keyed by client IP).
Thread-safe; each key's window is trimmed on every hit so memory stays bounded
by the number of distinct recent callers.
"""
import threading
import time
from collections import deque

_lock = threading.Lock()
_hits = {}


def over_limit(key, max_hits, window_seconds):
    """Record one hit for ``key`` now and return True if the number of hits in
    the trailing ``window_seconds`` seconds exceeds ``max_hits`` — i.e. this
    caller has gone over the limit and should be turned away."""
    now = time.monotonic()
    cutoff = now - window_seconds
    with _lock:
        dq = _hits.get(key)
        if dq is None:
            dq = _hits[key] = deque()
        dq.append(now)
        while dq and dq[0] < cutoff:
            dq.popleft()
        return len(dq) > max_hits


def reset():
    """Clear every counter — used by tests to isolate cases."""
    with _lock:
        _hits.clear()
