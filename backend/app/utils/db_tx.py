"""Transaction boundary helper.

Repository mutators call ``maybe_commit()`` instead of committing directly.
Outside a transaction it behaves exactly as a plain ``db.session.commit()``
did before — nothing changes for the many single-step CRUD flows. But when
a service wraps a multi-step operation in ``with atomic():``, every nested
write joins one transaction and the whole thing commits (or rolls back) as a
unit, so a failure part-way through can no longer leave stock decremented in
one place but never added in another (audit finding C-2).

Nesting is safe: ``atomic()`` blocks join the outermost one via a per-thread
depth counter, so a public method wrapped in ``atomic()`` can freely call
other wrapped methods.
"""
import threading
from contextlib import contextmanager
from app.extensions import db

_tx = threading.local()


def _depth():
    return getattr(_tx, "depth", 0)


def maybe_commit():
    """Commit now if not inside an atomic() block; otherwise flush (so PKs
    are assigned and SQL runs) and let the outermost atomic() commit."""
    if _depth() > 0:
        db.session.flush()
    else:
        db.session.commit()


@contextmanager
def atomic():
    """Run a block as a single transaction. Nested atomic() blocks join the
    outermost; the whole stack commits once on success, or rolls back
    entirely on any exception."""
    _tx.depth = _depth() + 1
    try:
        yield
    except Exception:
        _tx.depth = 0
        db.session.rollback()
        raise
    else:
        _tx.depth -= 1
        if _depth() == 0:
            db.session.commit()
