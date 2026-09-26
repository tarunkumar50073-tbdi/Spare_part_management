"""Returns to store and the store inspection (spec 13 / 14), plus the repeatable
installation update (spec 11 / 12).

A return is recorded against its ORIGINAL issue and held for inspection: only
a GOOD result adds it back to available stock (one RETURN ledger row per
inspection); Inspection Required / Damaged / Scrap never do. Every step lands
in the append-only journal. Each part is its own RT-<n>, so assertions read
only this file's rows out of the shared session DB.
"""
import threading

import pytest

from app.extensions import db
from app.models.part import Part
from app.models.spare_flow import SpareReturn, SpareTransaction
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.models.user import User, UserStoreAccess
from app.services.spare_return_service import SpareReturnService
from app.services.spare_stock_service import SpareStockService
from app.utils.exceptions import BadRequestError, NotFoundError

_seq = {"n": 0}


def _next():
    _seq["n"] += 1
    return _seq["n"]


def _part(store_code="MAINTENANCE"):
    n = _next()
    p = Part(part_no=f"RT-{n}", part_name=f"Return Part {n}", uom="NO",
             part_type="OTHER", store_code=store_code)
    db.session.add(p)
    db.session.commit()
    return p


def _on_hand(part_id):
    row = SpareStock.query.filter_by(part_id=part_id).first()
    return float(row.qty_on_hand) if row else 0.0


def _issued(qty=4, stock=10, **kw):
    """A part with `stock` on the shelf and one ISSUE of `qty` -> (part, issue_id)."""
    svc = SpareStockService()
    p = _part()
    svc.set_quantity(p.id, stock, txn_type="OPENING")
    res = svc.issue(p.id, qty, kw.pop("department", "Maintenance"), **kw)
    return p, res["issue"]["id"]


def _return(issue_id, qty=None, reason="Fitment Issue", **kw):
    return SpareReturnService().return_to_store(issue_id, qty=qty, reason=reason, **kw)


def _return_rows(issue_id):
    return SpareStockLedger.query.filter_by(return_of_id=issue_id, txn_type="RETURN").all()


def _journal(txn_type, **by):
    return (SpareTransaction.query.filter_by(txn_type=txn_type, **by)
            .order_by(SpareTransaction.id).all())


# ---- return -> inspect GOOD ----

def test_full_return_then_good_adds_stock_exactly_once():
    p, lid = _issued(qty=4, stock=10, issued_to="Ravi")
    assert _on_hand(p.id) == 6.0

    doc = _return(lid, returned_by="Ravi", user="store1", scanned_code=p.part_no,
                  scan_source="USB_SCANNER")
    assert doc["status"] == "INSPECTION_PENDING" and doc["qty_pending"] == 4.0
    assert doc["issue_status"] == "RETURNED" and doc["issued_qty"] == 4.0
    assert doc["issue_date"] and doc["part_no"] == p.part_no
    assert doc["issued_to"] == "Ravi" and doc["received_by"] == "store1"
    assert _on_hand(p.id) == 6.0 and not _return_rows(lid)   # not stock before inspection

    out = SpareReturnService().inspect(doc["id"], "GOOD", 4, user="insp")
    assert out["status"] == "CLOSED"
    assert (out["qty_good"], out["qty_pending"], out["qty_open"]) == (4.0, 0.0, 0.0)
    assert _on_hand(p.id) == 10.0

    rows = _return_rows(lid)
    assert len(rows) == 1                                   # ONE RETURN ledger row
    row = rows[0]
    assert float(row.qty_delta) == 4.0 and row.status == "INSPECTED_GOOD"
    assert row.return_no == doc["return_no"] and row.id == out["inspection"]["ledger_id"]

    with pytest.raises(BadRequestError):                    # nothing left to inspect
        SpareReturnService().inspect(doc["id"], "GOOD", 1)
    assert _on_hand(p.id) == 10.0 and len(_return_rows(lid)) == 1
    # The GOOD row is the same quantity as the return — never counted twice.
    assert SpareStockService._returned_qty(lid) == 4.0

    back = _journal("RETURN_TO_STORE", issue_id=lid)
    assert len(back) == 1
    assert (back[0].from_bucket, back[0].to_bucket) == ("ISSUED", "RETURN_PENDING")
    assert (back[0].return_id, back[0].return_reason) == (doc["id"], "Fitment Issue")
    assert (back[0].prev_status, back[0].new_status) == ("PENDING_USER_CONFIRMATION", "RETURNED")
    assert (back[0].scanned_code, back[0].scan_source) == (p.part_no, "USB_SCANNER")
    insp = _journal("RETURN_INSPECTION", return_id=doc["id"])
    assert len(insp) == 1
    assert (insp[0].from_bucket, insp[0].to_bucket) == ("RETURN_PENDING", "AVAILABLE")
    assert (insp[0].inspection_result, insp[0].ledger_id) == ("GOOD", row.id)
    assert (insp[0].prev_status, insp[0].new_status) == ("INSPECTION_PENDING", "CLOSED")


def test_hold_damaged_and_scrap_never_add_stock():
    p, lid = _issued(qty=4, stock=10)
    doc = _return(lid)
    svc = SpareReturnService()

    assert svc.inspect(doc["id"], "INSPECTION_REQUIRED", 1)["status"] == "INSPECTION_PENDING"
    svc.inspect(doc["id"], "DAMAGED", 1)
    svc.inspect(doc["id"], "SCRAP", 1)
    out = svc.inspect(doc["id"], "INSPECTION_REQUIRED", 1)       # last one waiting
    assert out["status"] == "RETURN_HOLD"
    assert (out["qty_pending"], out["qty_hold"], out["qty_damaged"], out["qty_scrap"]) == (0, 2, 1, 1)

    out = svc.inspect(doc["id"], "DAMAGED", 2)                   # default source: the hold
    assert out["status"] == "DAMAGED" and out["qty_damaged"] == 3.0
    out = svc.inspect(doc["id"], "SCRAP", 3)                     # default source: damaged
    assert out["status"] == "CLOSED" and out["qty_scrap"] == 4.0

    assert _on_hand(p.id) == 6.0                                 # never touched stock
    assert not _return_rows(lid)
    split = sum(out[k] for k in ("qty_pending", "qty_hold", "qty_damaged",
                                 "qty_good", "qty_scrap", "qty_rgp"))
    assert split == out["qty"] == 4.0
    assert all(j.ledger_id is None for j in _journal("RETURN_INSPECTION", return_id=doc["id"]))


def test_only_allowed_transitions():
    p, lid = _issued(qty=3, stock=5)
    doc = _return(lid)
    svc = SpareReturnService()
    svc.inspect(doc["id"], "DAMAGED", 1)
    svc.inspect(doc["id"], "INSPECTION_REQUIRED", 1)             # pending 1, hold 1, damaged 1

    for result, source in (("GOOD", "DAMAGED"),                  # damaged -> good refused
                           ("DAMAGED", "DAMAGED"),
                           ("INSPECTION_REQUIRED", "DAMAGED"),
                           ("INSPECTION_REQUIRED", "HOLD")):     # hold -> hold moves nothing
        with pytest.raises(BadRequestError):
            svc.inspect(doc["id"], result, 1, from_bucket=source)
    with pytest.raises(BadRequestError):
        svc.inspect(doc["id"], "LOST", 1)
    with pytest.raises(BadRequestError):
        svc.inspect(doc["id"], "GOOD", 1, from_bucket="SHELF")
    assert _on_hand(p.id) == 2.0                                 # nothing moved

    svc.inspect(doc["id"], "GOOD", 1, from_bucket="HOLD")        # hold -> good is allowed
    assert _on_hand(p.id) == 3.0
    svc.inspect(doc["id"], "SCRAP", 1, from_bucket="DAMAGED")    # damaged -> scrap is allowed
    with pytest.raises(BadRequestError):                         # the hold is empty now
        svc.inspect(doc["id"], "GOOD", 1, from_bucket="HOLD")
    out = svc.inspect(doc["id"], "good", 1, from_bucket="pending")   # codes are case-insensitive
    assert out["status"] == "CLOSED" and _on_hand(p.id) == 4.0
    assert len(_return_rows(lid)) == 2                           # one row per GOOD inspection


def test_over_return_and_over_inspection_are_refused():
    p, lid = _issued(qty=3, stock=5)
    doc = _return(lid, qty=2)
    assert doc["issue_status"] == "PARTIALLY_RETURNED"
    with pytest.raises(BadRequestError):
        _return(lid, qty=2)                                      # only 1 still out
    with pytest.raises(BadRequestError):
        _return(lid, qty=0)
    assert _return(lid, qty=1)["issue_status"] == "RETURNED"
    with pytest.raises(BadRequestError):
        _return(lid, qty=1)                                      # nothing left
    assert SpareReturn.query.filter_by(issue_id=lid).count() == 2

    with pytest.raises(BadRequestError):
        SpareReturnService().inspect(doc["id"], "GOOD", 5)       # only 2 waiting
    with pytest.raises(NotFoundError):
        SpareReturnService().inspect(999999, "GOOD", 1)
    assert _on_hand(p.id) == 2.0


def test_return_reason_is_free_text_up_to_60():
    _, lid = _issued(qty=2, stock=2)
    with pytest.raises(BadRequestError):
        _return(lid, qty=1, reason="x" * 61)
    assert _return(lid, qty=1, reason="Other — thread damaged at the line")["reason"].startswith("Other")


def test_inactive_part_cannot_be_returned_or_inspected():
    p, lid = _issued(qty=2, stock=2)
    doc = _return(lid, qty=1)
    p.is_active = False
    db.session.commit()
    with pytest.raises(BadRequestError):
        _return(lid, qty=1)
    with pytest.raises(BadRequestError):
        SpareReturnService().inspect(doc["id"], "GOOD", 1)


def test_legacy_direct_returns_still_count_as_returned():
    """RETURN rows written by the former direct return (no status) are part of
    what came back; an issue's outstanding figure keeps honouring them."""
    svc = SpareStockService()
    p, lid = _issued(qty=4, stock=4)
    svc._write(p.id, 1, "RETURN", return_of_id=lid)              # legacy: 1 back, straight to stock
    db.session.commit()
    assert svc._returned_qty(lid) == 1.0
    with pytest.raises(BadRequestError):
        _return(lid, qty=4)                                      # only 3 still out
    assert _return(lid, qty=3)["issue_status"] == "RETURNED"
    assert not any(r["id"] == lid for r in svc.returnable_issues_for_part(p.id))


def test_outstanding_returnables_keep_a_partly_returned_tool():
    svc = SpareStockService()
    p, lid = _issued(qty=3, stock=5, returnable=True, machine="PRESS-2")
    _return(lid, qty=1)
    row = next(r for r in svc.outstanding_returnables("MAINTENANCE") if r["id"] == lid)
    assert (row["outstanding_qty"], row["returned_qty"], row["qty"]) == (2.0, 1.0, 3.0)
    _return(lid, qty=2)
    assert not any(r["id"] == lid for r in svc.outstanding_returnables("MAINTENANCE"))


# ---- installation updates (spec 11 / 12) ----

def test_installation_updates_repeat_and_keep_history():
    svc = SpareStockService()
    p, lid = _issued(qty=5, stock=5)
    first = svc.confirm_installation(lid, line_name="L1", machine="M-1", actual_qty=5, user="fit1")
    assert first["status"] == "INSTALLED" and first["outstanding_qty"] == 5.0

    _return(lid, qty=2, reason="Machine Change")                 # 2 taken off the machine
    moved = svc.confirm_installation(lid, machine="M-2", die_no="D-9", user="fit2")
    assert moved["status"] == "INSTALLED" and moved["actual_qty"] == 3.0   # default = still out
    assert (moved["line_name"], moved["machine"], moved["die_no"]) == ("L1", "M-2", "D-9")
    assert (moved["returned_qty"], moved["outstanding_qty"]) == (2.0, 3.0)
    with pytest.raises(BadRequestError):
        svc.confirm_installation(lid, actual_qty=4)             # only 3 still out
    assert svc.confirm_installation(lid, actual_qty=1)["status"] == "PARTIALLY_USED"

    rows = _journal("INSTALLATION", issue_id=lid)
    assert [r.machine for r in rows] == ["M-1", "M-2", "M-2"]
    assert [r.die_no for r in rows] == [None, "D-9", "D-9"]
    assert [(r.prev_status, r.new_status) for r in rows] == [
        ("PENDING_USER_CONFIRMATION", "INSTALLED"),
        ("PARTIALLY_RETURNED", "INSTALLED"),
        ("INSTALLED", "PARTIALLY_USED"),
    ]
    assert [float(r.qty) for r in rows] == [5.0, 3.0, 1.0]
    issue = next(h for h in svc.history_for_part(p.id) if h["id"] == lid)
    assert (issue["machine"], issue["die_no"]) == ("M-2", "D-9")  # current values on the row

    _return(lid, qty=3)                                          # everything back
    with pytest.raises(BadRequestError):
        svc.confirm_installation(lid, machine="M-3")             # nothing out to place
    assert _on_hand(p.id) == 0.0                                 # still waiting for inspection


def test_installation_update_can_clear_a_place_field():
    """The part moves from Press-07 / Die-12 to Press-09, which has no die: the
    operator empties Die and it must be cleared — on the issue AND in the
    journal row — not kept as the part's current place. A field left out still
    keeps its value."""
    svc = SpareStockService()
    p, lid = _issued(qty=2, stock=2)
    svc.confirm_installation(lid, line_name="Line-03", machine="Press-07", die_no="Die-12")
    moved = svc.confirm_installation(lid, machine="Press-09", die_no=None)
    assert (moved["line_name"], moved["machine"], moved["die_no"]) == ("Line-03", "Press-09", None)
    assert db.session.get(SpareStockLedger, lid).die_no is None
    last = _journal("INSTALLATION", issue_id=lid)[-1]
    assert (last.machine, last.die_no, last.line_name) == ("Press-09", None, "Line-03")

    blank = svc.confirm_installation(lid, line_name="   ")        # blank clears too
    assert (blank["line_name"], blank["machine"]) == (None, "Press-09")
    assert [r.die_no for r in _journal("INSTALLATION", issue_id=lid)] == ["Die-12", None, None]


def test_cancelled_issue_cannot_be_updated():
    svc = SpareStockService()
    _, lid = _issued(qty=1, stock=1)
    row = db.session.get(SpareStockLedger, lid)
    row.status = "CANCELLED"
    db.session.commit()
    with pytest.raises(BadRequestError):
        svc.confirm_installation(lid, machine="M-1")


# ---- concurrency: the re-check inside atomic() ----

def test_stale_read_is_caught_by_the_recheck_inside_the_transaction(monkeypatch):
    """Simulate a second terminal that read "2 still out" just before another
    return landed: the pre-check sees a stale 0 returned, the re-check under
    the write lock must still refuse."""
    _, lid = _issued(qty=2, stock=2)
    _return(lid, qty=2)                                          # the other terminal won
    real = SpareStockService._returned_qty_map
    calls = {"n": 0}

    def stale_first(issue_ids):
        calls["n"] += 1
        return {i: 0.0 for i in issue_ids} if calls["n"] == 1 else real(issue_ids)

    monkeypatch.setattr(SpareStockService, "_returned_qty_map", staticmethod(stale_first))
    with pytest.raises(BadRequestError):
        _return(lid, qty=2)
    assert calls["n"] >= 2                                       # the re-check really ran
    assert SpareReturn.query.filter_by(issue_id=lid).count() == 1


def _race(app, fn):
    """Run fn twice at once from two threads; each gets its own session."""
    barrier = threading.Barrier(2)
    results, guard = [], threading.Lock()

    def worker():
        with app.app_context():
            barrier.wait()
            try:
                fn()
                outcome = "ok"
            except BadRequestError:
                outcome = "rejected"
            except Exception as exc:  # surface anything unexpected in the assert
                outcome = f"error:{type(exc).__name__}:{exc}"
        with guard:
            results.append(outcome)

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    db.session.expire_all()                                      # see the threads' commits
    return sorted(results)


def test_concurrent_returns_of_one_issue_take_it_once(app):
    _, lid = _issued(qty=3, stock=3)
    results = _race(app, lambda: SpareReturnService().return_to_store(lid, qty=3, reason="Wrong Part"))
    assert results == ["ok", "rejected"], results
    assert SpareReturn.query.filter_by(issue_id=lid).count() == 1
    assert len(_journal("RETURN_TO_STORE", issue_id=lid)) == 1


def test_concurrent_good_inspections_add_stock_once(app):
    p, lid = _issued(qty=3, stock=3)
    doc = _return(lid)
    results = _race(app, lambda: SpareReturnService().inspect(doc["id"], "GOOD", 3))
    assert results == ["ok", "rejected"], results
    assert _on_hand(p.id) == 3.0                                 # 0 after issue + 3, once
    assert len(_return_rows(lid)) == 1


# ---- reading ----

def test_list_and_open_for_part():
    svc = SpareReturnService()
    p, lid = _issued(qty=3, stock=3)
    a = _return(lid, qty=1)
    b = _return(lid, qty=2)
    svc.inspect(a["id"], "GOOD", 1)                              # a is CLOSED now
    open_ids = [r["id"] for r in svc.open_for_part(p.id)]
    assert open_ids == [b["id"]]
    listed = {r["id"]: r for r in svc.list("MAINTENANCE", status="OPEN")}
    assert b["id"] in listed and a["id"] not in listed
    assert listed[b["id"]]["part_no"] == p.part_no
    closed = [r["id"] for r in svc.list("MAINTENANCE", status="CLOSED")]
    assert a["id"] in closed
    with pytest.raises(BadRequestError):
        svc.list("MAINTENANCE", status="LOST")


# ---- routes ----

@pytest.fixture()
def client(app):
    return app.test_client()


def _login(client, stores=("MAINTENANCE",), perms=None):
    u = User(username=f"rtuser{_next()}", role="STORE_USER", is_active=True)
    u.set_password("pw")
    u.set_permissions(perms if perms is not None else {"scan_part": {"edit": True}})
    db.session.add(u)
    db.session.flush()
    for code in stores:
        db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
    db.session.commit()
    with client.session_transaction() as s:
        s["user_id"] = u.id
    return u


def test_return_and_inspect_via_routes(client):
    user = _login(client)
    p = _part()
    SpareStockService().set_quantity(p.id, 5, txn_type="OPENING")
    r = client.post(f"/api/v1/spare-stock/parts/{p.id}/issue",
                    json={"qty": 2, "department": "Maintenance", "issued_to": "Vijay"})
    assert r.status_code == 200, r.get_json()
    lid = r.get_json()["data"]["issue"]["id"]

    r = client.post(f"/api/v1/spare-stock/issues/{lid}/return",
                    json={"qty": 2, "reason": "Wrong Part", "returned_by": "Vijay"})
    assert r.status_code == 200, r.get_json()
    body = r.get_json()["data"]
    assert body["qty_on_hand"] == 3.0                            # held, not stock
    ret = body["return"]
    assert ret["status"] == "INSPECTION_PENDING" and ret["received_by"] == user.username

    r = client.get("/api/v1/spare-flow/returns?store_code=MAINTENANCE&status=OPEN")
    assert r.status_code == 200
    assert any(x["id"] == ret["id"] and x["part_no"] == p.part_no for x in r.get_json()["data"])
    assert client.get("/api/v1/spare-flow/returns").status_code == 400
    assert client.get("/api/v1/spare-flow/returns?store_code=MAINTENANCE&status=NOPE").status_code == 400
    assert client.get(f"/api/v1/spare-flow/returns/{ret['id']}").status_code == 200

    bad = client.post(f"/api/v1/spare-flow/returns/{ret['id']}/inspect", json={"result": "GOOD"})
    assert bad.status_code == 422                                # qty is required
    r = client.post(f"/api/v1/spare-flow/returns/{ret['id']}/inspect",
                    json={"result": "good", "qty": 2, "remarks": "checked OK"})
    assert r.status_code == 201, r.get_json()
    data = r.get_json()["data"]
    assert data["status"] == "CLOSED" and data["inspection"]["ledger_id"]
    assert _on_hand(p.id) == 5.0


def test_confirm_route_tells_left_out_from_cleared(client):
    """The Update form sends an emptied field as null (cleared); a caller that
    leaves a key out keeps its current value."""
    _login(client)
    _, lid = _issued(qty=1, stock=1)
    url = f"/api/v1/spare-stock/issues/{lid}/confirm"
    r = client.post(url, json={"line_name": "Line-03", "machine": "Press-07", "die_no": "Die-12"})
    assert r.status_code == 200, r.get_json()

    r = client.post(url, json={"actual_qty": 1})                 # no place keys: all kept
    assert r.status_code == 200, r.get_json()
    body = r.get_json()["data"]
    assert (body["line_name"], body["machine"], body["die_no"]) == ("Line-03", "Press-07", "Die-12")

    r = client.post(url, json={"line_name": "Line-03", "line_no": None, "machine": "Press-09",
                               "die_no": None, "actual_qty": 1})
    assert r.status_code == 200, r.get_json()
    body = r.get_json()["data"]
    assert (body["machine"], body["die_no"]) == ("Press-09", None)
    assert db.session.get(SpareStockLedger, lid).die_no is None
    assert _journal("INSTALLATION", issue_id=lid)[-1].die_no is None


def test_inspect_route_enforces_store_and_permission(client):
    _, lid = _issued(qty=1, stock=1)
    doc = _return(lid)
    _login(client, stores=("CHILD_PART",))                       # right module, wrong store
    url = f"/api/v1/spare-flow/returns/{doc['id']}"
    assert client.post(f"{url}/inspect", json={"result": "GOOD", "qty": 1}).status_code == 403
    assert client.get(url).status_code == 403
    assert client.get("/api/v1/spare-flow/returns?store_code=MAINTENANCE").status_code == 403

    _login(client, perms={})                                     # right store, no edit right
    assert client.post(f"{url}/inspect", json={"result": "GOOD", "qty": 1}).status_code == 403
    assert client.post(f"{url}/inspect", json={"result": "GOOD", "qty": 1}).status_code == 403
    assert db.session.get(SpareReturn, doc["id"]).status == "INSPECTION_PENDING"
