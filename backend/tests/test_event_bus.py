"""In-process event bus behind the SSE stream (Phase D4)."""
import json
import queue

from app.utils import event_bus


def test_publish_reaches_all_subscribers():
    q1 = event_bus.subscribe()
    q2 = event_bus.subscribe()
    try:
        event_bus.publish("stock", {"part_id": 7, "action": "issue"})
        m1 = json.loads(q1.get_nowait())
        m2 = json.loads(q2.get_nowait())
        assert m1 == {"event": "stock", "data": {"part_id": 7, "action": "issue"}}
        assert m2 == m1
    finally:
        event_bus.unsubscribe(q1)
        event_bus.unsubscribe(q2)


def test_unsubscribed_queue_gets_nothing():
    q = event_bus.subscribe()
    event_bus.unsubscribe(q)
    event_bus.publish("stock", {"x": 1})
    try:
        q.get_nowait()
        assert False, "an unsubscribed queue should receive nothing"
    except queue.Empty:
        pass
