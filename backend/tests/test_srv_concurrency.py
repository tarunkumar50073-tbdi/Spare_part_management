"""Regression + concurrency tests for the SRV status-transition compare-and-set
(audit finding DATA-2).

The bug: each transition read the status, checked it in Python, then wrote —
so two simultaneous requests for the same SRV could both pass the check and
both move stock (double deduction). The fix replaces the read-then-write with
a single conditional UPDATE (`claim_status`) that only one caller can win.
"""
import threading

import pytest

from app.extensions import db
from app.models.srv import SRV
from app.models.store_stock import PartStock, StockLedger
from app.repositories.srv_repository import SRVRepository
from app.repositories.store_stock_repository import PartStockRepository
from app.services.srv_service import SRVService
from app.utils.exceptions import BadRequestError


def _part_store_qty(part_id):
    row = PartStock.query.filter_by(part_id=part_id, location="PART_STORE").first()
    return float(row.qty_on_hand) if row else 0.0


def _consumption_rows(srv_id):
    return StockLedger.query.filter_by(srv_id=srv_id, reason="PRODUCTION_CONSUMPTION").count()


def test_happy_path_reaches_transferred_and_consumes(make_transferred):
    """The refactor must not break the normal pipeline: a DOL SRV lands in
    TRANSFERRED, and one consumption deducts PART_STORE exactly once."""
    srv_id, part_id, qty = make_transferred(qty=100)
    assert SRV.query.get(srv_id).status == "TRANSFERRED"
    assert _part_store_qty(part_id) == 100.0

    SRVService().confirm_consumption(srv_id)

    assert SRV.query.get(srv_id).status == "CONSUMED"
    assert _part_store_qty(part_id) == 0.0
    assert _consumption_rows(srv_id) == 1


def test_claim_status_is_compare_and_set(make_transferred):
    """The primitive behind the fix: two claims of the same transition yield
    exactly one winner. This is what makes the transition race-safe."""
    srv_id, _part_id, _qty = make_transferred(qty=100)
    repo = SRVRepository()

    first = repo.claim_status(srv_id, "TRANSFERRED", "CONSUMED")
    second = repo.claim_status(srv_id, "TRANSFERRED", "CONSUMED")

    assert first is not None and first.status == "CONSUMED"
    assert second is None  # already advanced -> the loser is rejected


def test_replayed_consumption_is_rejected(make_transferred):
    """A second confirm_consumption on an already-consumed SRV raises and does
    not deduct stock again — even when there is enough on hand that the
    negative-stock guard would not have caught the double deduction."""
    srv_id, part_id, _qty = make_transferred(qty=100)
    PartStockRepository().adjust(part_id, "PART_STORE", 100)  # PART_STORE now 200
    db.session.commit()

    SRVService().confirm_consumption(srv_id)                  # 200 -> 100
    with pytest.raises(BadRequestError):
        SRVService().confirm_consumption(srv_id)

    assert _part_store_qty(part_id) == 100.0                  # only one deduction
    assert _consumption_rows(srv_id) == 1


def test_concurrent_consumption_deducts_once(app, make_transferred):
    """Two threads confirm-consume the SAME SRV at once. With the compare-and-set
    guard exactly one wins; stock is deducted once and a single ledger row is
    written. PART_STORE is padded to 200 first so a double deduction would NOT
    trip the negative-stock guard — the guarantee has to come from the claim."""
    srv_id, part_id, _qty = make_transferred(qty=100)
    PartStockRepository().adjust(part_id, "PART_STORE", 100)  # PART_STORE now 200
    db.session.commit()

    barrier = threading.Barrier(2)
    results = []
    results_lock = threading.Lock()

    def worker():
        with app.app_context():
            barrier.wait()  # line both threads up right before the transaction
            try:
                SRVService().confirm_consumption(srv_id)
                outcome = "ok"
            except BadRequestError:
                outcome = "rejected"
            except Exception as exc:  # surface anything unexpected in the assert
                outcome = f"error:{type(exc).__name__}"
        with results_lock:
            results.append(outcome)

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    db.session.expire_all()  # see the other sessions' committed writes
    assert sorted(results) == ["ok", "rejected"], results
    assert _part_store_qty(part_id) == 100.0     # exactly one deduction, not two
    assert _consumption_rows(srv_id) == 1
    assert SRV.query.get(srv_id).status == "CONSUMED"
