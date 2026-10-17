"""Where an issued part was installed (store request 2026-10-14: "the part
ledger must also show where it was installed").

Confirm Installation, and every Update Line / Machine after it, appends an
INSTALLATION journal row; the ISSUE ledger row keeps only the CURRENT place.
The Part Ledger (history_for_part) now shows each of those entries — who,
when, where, how much was used — the Installed list (GET
/spare-stock/installations) holds the issues already confirmed, and an entry
with nothing used reads "Not used yet", never "Partly used".

Every part, store, person and user here is IH-<tag>-<n>; the stores are this
file's own and are switched off afterwards (with the people and users), so
nothing leaks into the MAINTENANCE lists other tests read.
"""
import uuid
from datetime import date, datetime, timezone

import pytest

from app.extensions import db
from app.models.employee import Employee
from app.models.part import Part
from app.models.spare_flow import SpareTransaction
from app.models.spare_stock import SpareStockLedger
from app.models.store import Store
from app.models.user import User, UserStoreAccess
from app.services.scan_result_service import ScanResultService
from app.services.spare_journal_service import SpareJournalService
from app.services.spare_return_service import TAKEN_BACK_REMARK, SpareReturnService
from app.services.spare_stock_service import SpareStockService
from app.utils.exceptions import BadRequestError

_TAG = uuid.uuid4().hex[:6].upper()
_seq = {"n": 0}

LEDGER_KEYS = {
    "id", "at", "qty_delta", "balance_after", "txn_type", "status", "reference", "remarks",
    "department", "issued_to", "issued_to_mobile", "issued_to_code", "machine", "line_name",
    "line_no", "die_no", "actual_qty", "invoice_no", "invoice_date", "check_result", "supplier",
    "return_no", "return_reason", "returned_by", "created_by", "confirmed_by", "confirmed_at",
    "row_kind",
}
INSTALLATION_KEYS = {
    "id", "row_kind", "at", "txn_type", "qty_delta", "balance_after", "issue_id",
    "issue_reference", "issued_qty", "actual_qty", "status", "prev_status", "department",
    "issued_to", "line_name", "line_no", "machine", "die_no", "remarks", "created_by",
}
LIST_KEYS = {
    "id", "part_id", "part_no", "part_name", "issued_at", "issued_by", "issued_qty",
    "returned_qty", "outstanding_qty", "actual_qty", "status", "department", "issued_to",
    "issued_to_code", "issued_to_mobile", "line_name", "line_no", "machine", "die_no",
    "reference", "confirmed_by", "confirmed_at", "remarks",
}
INST = ("installation", "INSTALLATION")


def _n():
    _seq["n"] += 1
    return _seq["n"]


@pytest.fixture()
def make():
    """Factories for this file's own stores / people / users. Afterwards the
    stores, people and users are switched off (rows still point at them) —
    MAINTENANCE must stay the last active store for later tests."""
    made = {"stores": [], "people": [], "users": []}

    def store():
        code = f"IH{_TAG}{_n()}"
        db.session.add(Store(code=code, name=f"Installation History {code}"))
        db.session.commit()
        made["stores"].append(code)
        return code

    def person(name):
        emp = Employee(mobile=f"6{uuid.uuid4().int % 10 ** 9:09d}", name=name,
                       employee_code=f"E-IH-{_TAG}-{_n()}", department="Press Shop")
        db.session.add(emp)
        db.session.commit()
        made["people"].append(emp.id)
        return emp

    def user(stores, perms=None):
        u = User(username=f"ih{_TAG.lower()}{_n()}", role="STORE_USER", is_active=True)
        u.set_password("pw")
        if perms:
            u.set_permissions(perms)
        db.session.add(u)
        db.session.flush()
        for code in stores:
            db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
        db.session.commit()
        made["users"].append(u.id)
        return u

    yield type("Make", (), {"store": staticmethod(store), "person": staticmethod(person),
                            "user": staticmethod(user)})
    db.session.rollback()
    Store.query.filter(Store.code.in_(made["stores"])).update(
        {"is_active": False}, synchronize_session=False)
    Employee.query.filter(Employee.id.in_(made["people"])).update(
        {"is_active": False}, synchronize_session=False)
    User.query.filter(User.id.in_(made["users"])).update(
        {"is_active": False}, synchronize_session=False)
    db.session.commit()


def _part(store_code):
    n = _n()
    p = Part(part_no=f"IH-{_TAG}-{n}", part_name=f"Installed Part {n}", uom="NO",
             part_type="OTHER", store_code=store_code)
    db.session.add(p)
    db.session.commit()
    return p


def _issued(store_code, qty=3, stock=10, department="Press Shop", **kw):
    """A part with `stock` on the shelf and one ISSUE of `qty` -> (part, issue id)."""
    svc = SpareStockService()
    p = _part(store_code)
    svc.set_quantity(p.id, stock, txn_type="OPENING")
    return p, svc.issue(p.id, qty, department, **kw)["issue"]["id"]


def _hist(part_id, limit=None, **kw):
    return SpareStockService().history_for_part(part_id, limit=limit, **kw)


def _kinds(rows):
    return [(r["row_kind"], r["txn_type"]) for r in rows]


def _at(row):
    return datetime.fromisoformat(row["at"])


def _installed_twice(store_code):
    """Issue 3 -> confirm (all used) at Seat Slider 03 / MC-1 / D-1 -> the stock
    moves -> update to MC-2 with the die cleared. -> (part, issue id)."""
    svc = SpareStockService()
    p, lid = _issued(store_code, qty=3, stock=10, issued_to="Ravi", reference="REQ-IH-1")
    svc.confirm_installation(lid, line_name="Seat Slider", line_no="03", machine="MC-1",
                             die_no="D-1", user="fitter.one", remarks="first fit")
    svc.set_quantity(p.id, 5, txn_type="ADJUSTMENT")
    svc.confirm_installation(lid, machine="MC-2", die_no=None, user="fitter.two")
    return p, lid


# ---- the Part Ledger shows every installation entry ---------------------------------

def test_history_keeps_every_installation_entry(make):
    p, lid = _installed_twice(make.store())
    rows = _hist(p.id)
    assert _kinds(rows) == [INST, ("ledger", "ADJUSTMENT"), INST,
                            ("ledger", "ISSUE"), ("ledger", "OPENING")]
    second, adj, first, issue, opening = rows

    journal = (SpareTransaction.query.filter_by(part_id=p.id, txn_type="INSTALLATION")
               .order_by(SpareTransaction.id).all())
    assert [first["id"], second["id"]] == [f"inst-{t.id}" for t in journal]   # strings, never a ledger id
    assert all(isinstance(r["id"], int) for r in (adj, issue, opening))
    assert set(first) == set(second) == INSTALLATION_KEYS
    assert set(issue) == set(opening) == LEDGER_KEYS

    # The ISSUE row: where the part is NOW. The entries: every place it was.
    assert issue["id"] == lid and (issue["machine"], issue["die_no"]) == ("MC-2", None)
    assert {k: first[k] for k in ("line_name", "line_no", "machine", "die_no", "actual_qty",
                                  "created_by", "prev_status", "status", "remarks")} == {
        "line_name": "Seat Slider", "line_no": "03", "machine": "MC-1", "die_no": "D-1",
        "actual_qty": 3.0, "created_by": "fitter.one", "prev_status": "PENDING_USER_CONFIRMATION",
        "status": "INSTALLED", "remarks": "first fit"}
    assert {k: second[k] for k in ("line_name", "line_no", "machine", "die_no", "actual_qty",
                                   "created_by", "prev_status", "status", "remarks")} == {
        "line_name": "Seat Slider", "line_no": "03", "machine": "MC-2", "die_no": None,
        "actual_qty": 3.0, "created_by": "fitter.two", "prev_status": "INSTALLED",
        "status": "INSTALLED", "remarks": None}
    for entry in (first, second):
        assert entry["row_kind"] == "installation" and entry["txn_type"] == "INSTALLATION"
        assert entry["qty_delta"] == 0
        assert (entry["issue_id"], entry["issue_reference"], entry["issued_qty"]) == (lid, "REQ-IH-1", 3.0)
        assert (entry["department"], entry["issued_to"]) == ("Press Shop", "Ravi")
    assert all(r["row_kind"] == "ledger" for r in (adj, issue, opening))

    # balance_after: the ledger balance in force when each entry was recorded.
    assert first["balance_after"] == issue["balance_after"] == 7.0
    assert second["balance_after"] == adj["balance_after"] == 5.0


def test_installation_entries_stay_right_after_a_return(make):
    """A return goes straight back into stock (the store's rule, 14 Oct 2026):
    its RETURN row sits between the installation entries, each entry keeps the
    balance in force when it was recorded, and an update after the return
    counts only what is still out."""
    svc = SpareStockService()
    p, lid = _issued(make.store(), qty=3, stock=10, issued_to="Ravi")         # 7 left
    svc.confirm_installation(lid, machine="MC-1", actual_qty=3, user="fitter.one")
    SpareReturnService().return_to_store(lid, qty=1, reason="Excess / Not Required",
                                         returned_by="Ravi", user="store1")    # 8
    svc.confirm_installation(lid, machine="MC-2", user="fitter.two")

    rows = _hist(p.id)
    assert _kinds(rows) == [INST, ("ledger", "RETURN"), INST, ("ledger", "ISSUE"), ("ledger", "OPENING")]
    second, ret, first, issue, _ = rows
    assert set(ret) == LEDGER_KEYS
    assert (ret["qty_delta"], ret["balance_after"], ret["status"]) == (1.0, 8.0, "INSPECTED_GOOD")
    assert (ret["return_reason"], ret["returned_by"], ret["remarks"]) == (
        "Excess / Not Required", "Ravi", TAKEN_BACK_REMARK)
    assert first["balance_after"] == issue["balance_after"] == 7.0
    assert second["balance_after"] == ret["balance_after"] == 8.0
    assert (first["machine"], first["actual_qty"], first["status"]) == ("MC-1", 3.0, "INSTALLED")
    assert (second["machine"], second["actual_qty"], second["prev_status"]) == (
        "MC-2", 2.0, "PARTIALLY_RETURNED")
    assert all(r["issue_id"] == lid and r["issued_qty"] == 3.0 for r in (first, second))

    titles = [r["title"] for r in ScanResultService().timeline(p.id)["rows"]]
    assert titles == ["Installed – MC-2", "Returned to stock – Excess / Not Required",
                      "Installed – MC-1", "Issued to Press Shop", "Opening stock"]


def test_history_filters_apply_to_installation_rows(make):
    p, _ = _installed_twice(make.store())
    rows = _hist(p.id)
    second_at, first_at = _at(rows[0]), _at(rows[2])

    assert _kinds(_hist(p.id, txn_type="INSTALLATION")) == [INST, INST]
    assert _kinds(_hist(p.id, txn_type="ISSUE")) == [("ledger", "ISSUE")]
    assert _kinds(_hist(p.id, txn_type="ADJUSTMENT")) == [("ledger", "ADJUSTMENT")]
    # Opening / adjustment rows carry no department.
    assert _kinds(_hist(p.id, department="Press Shop")) == [INST, INST, ("ledger", "ISSUE")]
    assert _hist(p.id, department="Tool Room") == []
    # MC-1 is only in the first entry now; the ISSUE row says MC-2.
    assert [(r["row_kind"], r["machine"]) for r in _hist(p.id, machine="MC-1")] == [("installation", "MC-1")]
    assert _kinds(_hist(p.id, machine="MC-2")) == [INST, ("ledger", "ISSUE")]

    assert _kinds(_hist(p.id, since=second_at)) == [INST]
    aware = second_at.replace(tzinfo=timezone.utc)
    assert _hist(p.id, since=aware) == _hist(p.id, since=second_at)
    assert _kinds(_hist(p.id, until=first_at)) == [INST, ("ledger", "ISSUE"), ("ledger", "OPENING")]
    assert _kinds(_hist(p.id, since=first_at, until=first_at)) == [INST]
    assert _hist(p.id, until=date(2000, 1, 1)) == []
    assert _kinds(_hist(p.id, txn_type="INSTALLATION", machine="MC-2")) == [INST]

    # The limit cuts the merged list.
    assert _kinds(_hist(p.id, limit=2)) == [INST, ("ledger", "ADJUSTMENT")]
    assert len(SpareStockService().history_for_part(p.id, limit=4)) == 4
    assert len(SpareStockService().history_for_part(p.id)) == 5          # default 25
    # 0 or a negative limit (the route passes ?limit=-1 through) means no limit,
    # as the old query's LIMIT -1 did on SQLite — never "all but the oldest".
    assert _kinds(_hist(p.id, limit=-1)) == _kinds(_hist(p.id, limit=0)) == _kinds(_hist(p.id))
    assert len(_hist(p.id, limit=-5)) == 5


def test_history_route_carries_the_installation_rows(make, client):
    code = make.store()
    p, _ = _installed_twice(code)
    c = _as(client, make.user([code]))
    r = c.get(f"/api/v1/spare-stock/parts/{p.id}/history?limit=500")
    assert r.status_code == 200
    assert _kinds(r.get_json()["data"]) == _kinds(_hist(p.id))
    r = c.get(f"/api/v1/spare-stock/parts/{p.id}/history?limit=-1")
    assert len(r.get_json()["data"]) == 5                                 # no limit, not 4
    r = c.get(f"/api/v1/spare-stock/parts/{p.id}/history?txn_type=INSTALLATION&machine=MC-1")
    assert [x["machine"] for x in r.get_json()["data"]] == ["MC-1"]


def test_a_journal_row_never_lands_on_another_parts_issue(make):
    code = make.store()
    svc = SpareStockService()
    a, a_lid = _issued(code, qty=2)
    svc.confirm_installation(a_lid, machine="MC-A", user="fitter")
    b, _ = _issued(code, qty=1)
    # A stray row of part B pointing at part A's issue — what an old row left
    # by a deleted issue looks like once SQLite reuses that issue's id.
    SpareJournalService().record(b.id, "INSTALLATION", 1, store_code=code, issue_id=a_lid,
                                 machine="STRAY", new_status="INSTALLED", user="ghost")
    # And a row of part A itself dated before A's issue (an earlier, deleted
    # issue of the same part whose id was reused).
    db.session.add(SpareTransaction(part_id=a.id, store_code=code, txn_type="INSTALLATION", qty=1,
                                    issue_id=a_lid, machine="OLD", created_at=datetime(2026, 1, 1)))
    db.session.commit()

    assert [r["machine"] for r in _hist(a.id) if r["row_kind"] == "installation"] == ["MC-A"]
    assert all(r["row_kind"] == "ledger" for r in _hist(b.id))
    assert _hist(b.id, txn_type="INSTALLATION") == []


# ---- nothing used reads "Not used yet" ---------------------------------------------

def _legacy_nothing_used(lid, user="fitter", **place):
    """An installation confirmed with 0 used, written as the code did before
    14 Oct 2026 — it is refused since (one such record is on the plant's data)."""
    row = db.session.get(SpareStockLedger, lid)
    prev = row.status
    SpareStockLedger.query.filter_by(id=lid).update({
        **place, "actual_qty": 0, "status": "PARTIALLY_USED", "confirmed_by": user,
        "confirmed_at": datetime.now(timezone.utc).replace(tzinfo=None)})
    SpareJournalService().record(
        row.part_id, "INSTALLATION", 0, store_code=db.session.get(Part, row.part_id).store_code, user=user,
        prev_status=prev, new_status="PARTIALLY_USED", issue_id=lid, department=row.department,
        issued_to=row.issued_to, **place)
    db.session.commit()


def test_nothing_used_cannot_be_confirmed_as_an_installation(make):
    """A part that was not fitted is not installed: 0 used (or less) is
    refused, and nothing is recorded — the issue stays under Waiting."""
    p, lid = _issued(make.store(), qty=2)
    svc = SpareStockService()
    for used in (0, -1):
        with pytest.raises(BadRequestError, match="A part that was not fitted is not installed"):
            svc.confirm_installation(lid, machine="MC-Z", actual_qty=used, user="fitter")
    row = db.session.get(SpareStockLedger, lid)
    assert (row.status, row.actual_qty, row.machine, row.confirmed_at) == ("PENDING_USER_CONFIRMATION", None, None, None)
    assert SpareTransaction.query.filter_by(issue_id=lid, txn_type="INSTALLATION").count() == 0
    assert lid in [r["id"] for r in svc.pending_confirmations(p.store_code)]


def test_nothing_used_reads_not_used_yet(make):
    code = make.store()
    svc = SpareStockService()
    p, lid = _issued(code, qty=1)
    _legacy_nothing_used(lid, user="tarun", line_no="YHB-SS-05", machine="SEMI AUTO")
    assert db.session.get(SpareStockLedger, lid).status == "PARTIALLY_USED"     # status values unchanged

    rows = ScanResultService().timeline(p.id)["rows"]
    assert [r["title"] for r in rows if r["kind"] == "INSTALLATION"] == [
        "Not used yet – Line YHB-SS-05 / SEMI AUTO"]
    assert not any("Partly used" in (r["title"] or "") for r in rows)
    entry = _hist(p.id, txn_type="INSTALLATION")[0]
    assert (entry["actual_qty"], entry["issued_qty"], entry["status"]) == (0.0, 1.0, "PARTIALLY_USED")

    # Something used but not all still reads "Partly used".
    q, lid2 = _issued(code, qty=2)
    svc.confirm_installation(lid2, machine="MC-P", actual_qty=1, user="f")
    assert [r["title"] for r in ScanResultService().timeline(q.id)["rows"]
            if r["kind"] == "INSTALLATION"] == ["Partly used – MC-P"]


def test_nothing_used_on_a_pre_journal_confirmation_reads_not_used_yet(make):
    """A confirmation recorded on the ISSUE row with no journal row (before
    the journal) is worded the same way."""
    p, lid = _issued(make.store(), qty=2)
    SpareStockLedger.query.filter_by(id=lid).update({
        "machine": "MC-L", "actual_qty": 0, "status": "PARTIALLY_USED",
        "confirmed_by": "old", "confirmed_at": datetime(2030, 1, 1)})
    db.session.commit()
    rows = ScanResultService().timeline(p.id)["rows"]
    assert [r["title"] for r in rows if r["kind"] == "INSTALLATION"] == ["Not used yet – MC-L"]


# ---- the Installed list ------------------------------------------------------------

def test_installations_lists_confirmed_issues_newest_first(make):
    code, other = make.store(), make.store()
    svc = SpareStockService()
    emp = make.person("Asha Rani")
    _issued(code, qty=1)                                                  # never confirmed
    a, a_lid = _issued(code, qty=3, department="Maintenance", employee_id=emp.id,
                       reference="REQ-IH-A")
    b, b_lid = _issued(code, qty=2, issued_to="Bala")
    _, c_lid = _issued(code, qty=1)
    _, o_lid = _issued(other, qty=1)
    svc.confirm_installation(a_lid, line_name="Seat Slider", machine="MC-A", user="fitter")
    _legacy_nothing_used(b_lid, line_no="L-7", machine="MC-B")
    svc.confirm_installation(c_lid, machine="MC-C", user="fitter")
    svc.confirm_installation(o_lid, machine="MC-O", user="fitter")
    SpareStockLedger.query.filter_by(id=c_lid).update({"status": "CANCELLED"})
    db.session.commit()

    assert [r["id"] for r in svc.installations(code)] == [b_lid, a_lid]
    assert [r["id"] for r in svc.installations(other)] == [o_lid]          # store-scoped

    # An update moves the issue to the top, with its current place.
    svc.confirm_installation(a_lid, machine="MC-A2", user="fitter.two")
    rows = svc.installations(code)
    assert [r["id"] for r in rows] == [a_lid, b_lid]
    top = rows[0]
    assert set(top) == LIST_KEYS
    assert {k: top[k] for k in ("part_id", "part_no", "part_name", "issued_qty", "returned_qty",
                                "outstanding_qty", "actual_qty", "status", "department",
                                "issued_to", "issued_to_code", "issued_to_mobile", "line_name",
                                "machine", "reference", "confirmed_by")} == {
        "part_id": a.id, "part_no": a.part_no, "part_name": a.part_name, "issued_qty": 3.0,
        "returned_qty": 0.0, "outstanding_qty": 3.0, "actual_qty": 3.0, "status": "INSTALLED",
        "department": "Maintenance", "issued_to": "Asha Rani", "issued_to_code": emp.employee_code,
        "issued_to_mobile": emp.mobile, "line_name": "Seat Slider", "machine": "MC-A2",
        "reference": "REQ-IH-A", "confirmed_by": "fitter.two"}
    assert rows[1]["actual_qty"] == 0.0 and rows[1]["status"] == "PARTIALLY_USED"

    # A return: still listed, with returned / outstanding.
    SpareReturnService().return_to_store(a_lid, qty=1, reason="Fitment Issue")
    SpareReturnService().return_to_store(b_lid, reason="Fitment Issue")       # all of it
    by_id = {r["id"]: r for r in svc.installations(code)}
    assert (by_id[a_lid]["returned_qty"], by_id[a_lid]["outstanding_qty"],
            by_id[a_lid]["status"]) == (1.0, 2.0, "PARTIALLY_RETURNED")
    assert (by_id[b_lid]["returned_qty"], by_id[b_lid]["outstanding_qty"],
            by_id[b_lid]["status"]) == (2.0, 0.0, "RETURNED")

    # The limit, at least 1.
    assert [r["id"] for r in svc.installations(code, limit=1)] == [a_lid]
    assert len(svc.installations(code, limit=-5)) == 1


def test_installations_search(make):
    code = make.store()
    svc = SpareStockService()
    emp = make.person("Asha Rani")
    a, a_lid = _issued(code, qty=1, department="Maintenance", employee_id=emp.id)
    b, b_lid = _issued(code, qty=1, issued_to="Bala_100%")
    svc.confirm_installation(a_lid, line_name="Seat Slider", machine="MC-A", user="f")
    svc.confirm_installation(b_lid, line_no="L-7", machine="Press 07", user="f")

    def ids(q):
        return [r["id"] for r in svc.installations(code, q=q)]

    assert ids(a.part_no.lower()) == [a_lid]                 # part no, case-blind
    assert ids(b.part_name.upper()) == [b_lid]               # part name
    assert ids("asha") == [a_lid]                            # issued to
    assert ids(emp.mobile) == [a_lid]                        # mobile
    assert ids("MAINTEN") == [a_lid]                         # department
    assert ids("seat") == [a_lid] and ids("l-7") == [b_lid]  # line name / line no
    assert ids("press 0") == [b_lid]                         # machine
    assert ids("_100%") == [b_lid] and ids("%") == [b_lid]   # wildcards are literal
    assert ids("  ") == ids(None) == [b_lid, a_lid]          # blank = everything
    assert ids("nothing-like-this") == []


# ---- who may read the list: exactly who may read the confirmation queue -------------

@pytest.fixture()
def client(app):
    return app.test_client()


def _as(client, user):
    with client.session_transaction() as sess:
        sess["user_id"] = user.id
    return client


def test_installations_route_is_gated_like_pending_confirmations(make, client, app):
    code = make.store()
    _, lid = _issued(code, qty=1)
    SpareStockService().confirm_installation(lid, machine="MC-G", user="f")
    paths = ("/api/v1/spare-stock/installations", "/api/v1/spare-stock/pending-confirmations")

    def statuses(headers=None, query=f"?store_code={code}"):
        return [client.get(p + query, headers=headers or {}).status_code for p in paths]

    assert statuses() == [401, 401]                                        # not signed in
    _as(client, make.user(["MAINTENANCE"], {"scan_part": {"edit": True}}))
    assert statuses() == [403, 403]                                        # not this store
    _as(client, make.user([code], {"install_confirm": {"edit": True}}))   # a line user
    assert statuses() == [200, 200]
    assert statuses(query="") == [400, 400]                                # store_code required
    _as(client, make.user([code]))                                         # no module right at all
    assert statuses() == [200, 200]
    with client.session_transaction() as sess:
        sess.clear()
    assert statuses(headers={"X-API-Key": app.config["API_KEY"]}) == [200, 200]   # the machine caller

    _as(client, make.user([code]))
    r = client.get(f"/api/v1/spare-stock/installations?store_code={code}&q=MC-G&limit=5")
    assert [x["id"] for x in r.get_json()["data"]] == [lid]
