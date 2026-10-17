"""Supplier rework under an RGP — spec 15-19.

There is no direct RGP: material goes to a supplier only from a return the
store inspection held or found damaged. While with the supplier, and until the
RGP GRN is recorded, it is not available stock; the RGP GRN adds it back exactly
once, as one RECEIPT ledger row. Every step writes one journal row, and a vendor
code is accepted only when ERP has seen that vendor for the part.

SpareReturn rows are made directly here (the return flow is tested on its own):
a real ISSUE first, then a return carrying the inspected hold / damaged split.
"""
import re
import threading
from datetime import date, timedelta

import pytest

from app.extensions import db
from app.models.gate_entry import GateEntry
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.spare_flow import SpareReturn, SpareRgp, SpareTransaction
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.models.supplier import Supplier
from app.models.user import User, UserStoreAccess
from app.services.scan_result_service import ScanResultService
from app.services.spare_journal_service import SpareJournalService
from app.services.spare_rgp_service import SpareRgpService, rework_bin
from app.services.spare_stock_service import SpareStockService
from app.utils.exceptions import BadRequestError, NotFoundError

_seq = {"n": 0}


def _next():
    _seq["n"] += 1
    return _seq["n"]


def _part(active=True):
    n = _next()
    p = Part(part_no=f"RGPT-{n:04d}", part_name=f"Rework Part {n}", uom="NO",
             part_type="OTHER", store_code="MAINTENANCE", location=f"R{n}-S1", is_active=active)
    db.session.add(p)
    db.session.commit()
    return p


def _returned(damaged=0, hold=0, pending=0, good=0, opening=10, part=None):
    """A part with `opening` on hand, one ISSUE of the whole return quantity, and
    a return against that issue already split by the store inspection."""
    p = part or _part()
    svc = SpareStockService()
    svc.set_quantity(p.id, opening, txn_type="OPENING")
    total = damaged + hold + pending + good
    svc.issue(p.id, total, "Maintenance", issued_to="Ravi")
    issue = (SpareStockLedger.query.filter_by(part_id=p.id, txn_type="ISSUE")
             .order_by(SpareStockLedger.id.desc()).first())
    ret = SpareReturn(
        return_no=SpareJournalService().next_return_no(), part_id=p.id, store_code="MAINTENANCE",
        issue_id=issue.id, qty=total, qty_pending=pending, qty_hold=hold, qty_damaged=damaged,
        qty_good=good, reason="Fitment Issue", department="Maintenance", issued_to="Ravi",
    )
    ret.refresh_status()
    db.session.add(ret)
    db.session.commit()
    return p, ret


def _out(ret, qty=1, **kw):
    args = {"ven_name": "ABC Engineering", "supplier_source": "NAME_ONLY",
            "rework_reason": "Worn seal - regrind", "user": "store1"}
    args.update(kw)
    return SpareRgpService().rgp_out(ret.id, qty, **args)


def _on_hand(part_id):
    return float(SpareStock.query.filter_by(part_id=part_id).first().qty_on_hand)


def _ledger_count(part_id):
    return SpareStockLedger.query.filter_by(part_id=part_id).count()


def _ret(ret_id):
    return db.session.get(SpareReturn, ret_id)


def _gate(part_no, ven_cd, ven_name, d):
    db.session.add(GateEntry(store_code="MAINTENANCE", item_code=part_no, ven_cd=ven_cd,
                             ven_name=ven_name, gate_entry_dt=d, qty=5,
                             gate_entry_no=f"GE-{ven_cd}-{d.isoformat()}"))
    db.session.commit()


def _grn_row(part_no, ven_cd, ven_name, d):
    db.session.add(ReceivingRegister(store_code="MAINTENANCE", item_cd=part_no, ven_cd=ven_cd,
                                     ven_name=ven_name, grn_date=d, grn_no=f"IN-{ven_cd}",
                                     receipt_qty=5, accept_qty=5))
    db.session.commit()


# ---- RGP only from a held / damaged return (no direct RGP) ----

def test_rgp_only_from_held_or_damaged_returned_qty():
    svc = SpareRgpService()
    p, not_inspected = _returned(pending=2)
    with pytest.raises(BadRequestError):          # returned but not inspected yet
        _out(not_inspected, 1)
    p2, good_only = _returned(good=2)
    with pytest.raises(BadRequestError):          # GOOD went back to stock — not reworkable
        _out(good_only, 1)
    with pytest.raises(NotFoundError):            # no return, no RGP
        svc.rgp_out(987654, 1, ven_name="X", supplier_source="NAME_ONLY", rework_reason="x")
    assert SpareRgp.query.filter(SpareRgp.part_id.in_([p.id, p2.id])).count() == 0
    assert _on_hand(p.id) == 8.0 and _on_hand(p2.id) == 8.0


def test_no_endpoint_makes_an_rgp_without_a_return(app):
    """The only POST that creates an RGP hangs off a return; nothing under a
    part or the stock API can. (/api/v1/rgp is the Child Parts ERP report.)"""
    posts = [r.rule for r in app.url_map.iter_rules()
             if "POST" in r.methods and "rgp" in r.rule.lower() and not r.rule.startswith("/api/v1/rgp")]
    assert "/api/v1/spare-flow/returns/<int:return_id>/rgp-out" in posts
    assert all(r.startswith(("/api/v1/spare-flow/returns/", "/api/v1/spare-flow/rgps/")) for r in posts)


def test_default_bucket_is_damaged_then_hold():
    p, ret = _returned(damaged=2, hold=1)
    first = _out(ret, 2)
    assert first["source_bucket"] == "DAMAGED" and first["status"] == "WITH_SUPPLIER"
    r = _ret(ret.id)
    assert r.q("qty_damaged") == 0 and r.q("qty_rgp") == 2 and r.status == "RETURN_HOLD"
    second = _out(ret, 1)
    assert second["source_bucket"] == "RETURN_HOLD"
    r = _ret(ret.id)
    assert r.q("qty_hold") == 0 and r.q("qty_rgp") == 3 and r.status == "CLOSED"


def test_over_send_refused_and_return_untouched():
    p, ret = _returned(damaged=2)
    with pytest.raises(BadRequestError):
        _out(ret, 3)                                   # more than is damaged
    with pytest.raises(BadRequestError):
        _out(ret, 1, from_bucket="RETURN_HOLD")        # nothing held on this return
    with pytest.raises(BadRequestError):
        _out(ret, 1, from_bucket="AVAILABLE")          # never from stock
    with pytest.raises(BadRequestError):
        _out(ret, 0)
    r = _ret(ret.id)
    assert r.q("qty_damaged") == 2 and r.q("qty_rgp") == 0 and r.status == "DAMAGED"
    assert SpareRgp.query.filter_by(part_id=p.id).count() == 0


def test_inactive_part_cannot_go_on_rgp():
    p, ret = _returned(damaged=1)
    p.is_active = False
    db.session.commit()
    with pytest.raises(BadRequestError):
        _out(ret, 1)


# ---- not stock while with the supplier; the GRN adds it exactly once ----

def test_with_supplier_and_supplier_return_do_not_touch_stock():
    svc = SpareRgpService()
    p, ret = _returned(damaged=3, opening=10)
    assert _on_hand(p.id) == 7.0
    rows_before = _ledger_count(p.id)
    rgp = _out(ret, 3)
    assert _on_hand(p.id) == 7.0                       # with the supplier = not available
    assert rgp["qty_with_supplier"] == 3.0
    back = svc.supplier_return(rgp["id"], 3, user="store1")
    assert back["status"] == "RGP_GRN_PENDING"
    assert back["qty_with_supplier"] == 0.0 and back["qty_grn_pending"] == 3.0
    assert _on_hand(p.id) == 7.0                       # back at the store, still no stock
    assert _ledger_count(p.id) == rows_before          # no ledger row for either step


def test_grn_adds_stock_once_via_one_receipt_row_and_closes(monkeypatch):
    svc = SpareRgpService()
    stock = SpareStockService()
    p, ret = _returned(damaged=3, opening=10)
    rgp = _out(ret, 3)
    svc.supplier_return(rgp["id"], 3, user="store1")
    pending_before = stock.pending_erp_count("MAINTENANCE")
    done = svc.rgp_grn(rgp["id"], 3, "GRN-RGP-1", user="supervisor")
    assert done["status"] == "CLOSED" and done["qty_grn"] == 3.0 and done["qty_grn_pending"] == 0.0
    assert done["qty_on_hand"] == 10.0 and _on_hand(p.id) == 10.0

    receipts = SpareStockLedger.query.filter_by(part_id=p.id, txn_type="RECEIPT").all()
    assert len(receipts) == 1
    row = receipts[0]
    assert float(row.qty_delta) == 3.0 and float(row.balance_after) == 10.0
    assert row.status == "RGP_GRN"
    assert row.reference == rgp["rgp_no"]
    assert row.remarks == "RGP GRN GRN-RGP-1"
    assert done["ledger_id"] == row.id

    # The stock-in already happened in ERP through the supervisor's GRN, so the
    # row never joins the ERP push backlog — pushing it would add it twice.
    assert stock.pending_erp_count("MAINTENANCE") == pending_before
    assert row.id not in {m["id"] for m in stock.pending_erp_movements("MAINTENANCE")}
    # The sync picks its rows with its own query: record what it would push.
    # Every push fails, so nothing is stamped as pushed for the other tests.
    from app.services.erp_client import ERPClient
    pushed = []

    def _refuse(self, part_no, qty_delta, reason, reference=None):
        pushed.append((part_no, reason, reference))
        raise RuntimeError("test: ERP push refused")

    monkeypatch.setattr(ERPClient, "push_stock_movement", _refuse)
    stock.sync_pending_to_erp("MAINTENANCE")
    assert (p.part_no, "RECEIPT", rgp["rgp_no"]) not in pushed
    assert db.session.get(SpareStockLedger, row.id).erp_pushed_at is None

    with pytest.raises(BadRequestError):               # nothing left to GRN
        svc.rgp_grn(rgp["id"], 1, "GRN-RGP-2")
    with pytest.raises(BadRequestError):               # closed: nothing with the supplier
        svc.supplier_return(rgp["id"], 1)
    assert SpareStockLedger.query.filter_by(part_id=p.id, txn_type="RECEIPT").count() == 1
    assert _on_hand(p.id) == 10.0


def test_grn_needs_a_supplier_return_first_and_a_grn_no():
    svc = SpareRgpService()
    p, ret = _returned(damaged=2)
    rgp = _out(ret, 2)
    with pytest.raises(BadRequestError):               # still with the supplier
        svc.rgp_grn(rgp["id"], 1, "GRN-X")
    svc.supplier_return(rgp["id"], 1)
    with pytest.raises(BadRequestError):               # the ERP GRN no. is required
        svc.rgp_grn(rgp["id"], 1, "  ")
    with pytest.raises(BadRequestError):               # a GRN is not dated in the future
        svc.rgp_grn(rgp["id"], 1, "GRN-X", grn_date=date.today() + timedelta(days=1))
    with pytest.raises(BadRequestError):               # more than came back
        svc.supplier_return(rgp["id"], 2)


def test_partial_flows():
    svc = SpareRgpService()
    p, ret = _returned(damaged=3, opening=10)
    rgp_id = _out(ret, 3)["id"]

    r = svc.supplier_return(rgp_id, 1)
    assert (r["status"], r["qty_with_supplier"], r["qty_grn_pending"]) == ("RGP_GRN_PENDING", 2.0, 1.0)
    r = svc.rgp_grn(rgp_id, 1, "GRN-P1")
    # Everything returned so far is GRN'd, the rest is still out.
    assert (r["status"], r["qty_with_supplier"], r["qty_grn_pending"]) == ("WITH_SUPPLIER", 2.0, 0.0)
    assert _on_hand(p.id) == 8.0

    r = svc.supplier_return(rgp_id, 2)
    assert (r["status"], r["qty_with_supplier"], r["qty_grn_pending"]) == ("RGP_GRN_PENDING", 0.0, 2.0)
    with pytest.raises(BadRequestError):
        svc.rgp_grn(rgp_id, 3, "GRN-P2")               # only 2 waiting
    r = svc.rgp_grn(rgp_id, 1, "GRN-P2")
    assert r["status"] == "RGP_GRN_PENDING" and r["qty_grn_pending"] == 1.0
    r = svc.rgp_grn(rgp_id, 1, "GRN-P3")
    assert r["status"] == "CLOSED" and r["grn_no"] == "GRN-P3"

    receipts = SpareStockLedger.query.filter_by(part_id=p.id, txn_type="RECEIPT").all()
    assert len(receipts) == 3 and sum(float(x.qty_delta) for x in receipts) == 3.0
    assert _on_hand(p.id) == 10.0


# ---- cancel ----

def test_cancel_puts_qty_back_on_its_return_bucket():
    svc = SpareRgpService()
    p, ret = _returned(damaged=2, opening=10)
    rgp = _out(ret, 2)
    assert _ret(ret.id).status == "CLOSED"
    with pytest.raises(BadRequestError):
        svc.cancel(rgp["id"], "   ")                    # a reason is required
    done = svc.cancel(rgp["id"], "Wrong supplier picked", user="store1")
    assert done["status"] == "CANCELLED" and done["cancel_reason"] == "Wrong supplier picked"
    assert done["qty_with_supplier"] == 0.0 and done["qty_grn_pending"] == 0.0
    r = _ret(ret.id)
    assert r.q("qty_damaged") == 2 and r.q("qty_rgp") == 0 and r.status == "DAMAGED"
    assert _on_hand(p.id) == 8.0                       # no stock moved either way

    with pytest.raises(BadRequestError):
        svc.cancel(rgp["id"], "again")
    with pytest.raises(BadRequestError):
        svc.supplier_return(rgp["id"], 1)
    with pytest.raises(BadRequestError):
        svc.rgp_grn(rgp["id"], 1, "GRN-C")
    # The quantity is on the return again, so it can go out on a fresh RGP.
    again = _out(ret, 2)
    assert again["source_bucket"] == "DAMAGED"


def test_cancel_refused_once_the_supplier_returned_anything():
    svc = SpareRgpService()
    p, ret = _returned(hold=2)
    rgp = _out(ret, 2)
    svc.supplier_return(rgp["id"], 1)
    with pytest.raises(BadRequestError):
        svc.cancel(rgp["id"], "Changed mind")
    assert db.session.get(SpareRgp, rgp["id"]).status == "RGP_GRN_PENDING"


# ---- supplier / vendor code ----

def test_typed_vendor_code_refused_erp_code_accepted():
    p, ret = _returned(damaged=5)
    other = _part()
    _gate(p.part_no, "VRG-001", "ABC ENGINEERING", date(2026, 7, 1))
    _grn_row(p.part_no, "VRG-GRN", "XYZ REWORKS", date(2026, 7, 3))
    _gate(other.part_no, "VRG-OTHER", "NOT THIS PART'S VENDOR", date(2026, 7, 2))

    with pytest.raises(BadRequestError):               # typed / invented
        _out(ret, 1, ven_cd="FAKE-99", supplier_source="GATE_ENTRY")
    with pytest.raises(BadRequestError):               # an ERP vendor, but of another part
        _out(ret, 1, ven_cd="VRG-OTHER", supplier_source="GATE_ENTRY")
    with pytest.raises(BadRequestError):               # a code never rides on a non-ERP source
        _out(ret, 1, ven_cd="VRG-001", supplier_source="NAME_ONLY")
    with pytest.raises(BadRequestError):
        _out(ret, 1, supplier_id=987654)               # supplier must exist
    with pytest.raises(BadRequestError):
        _out(ret, 1, supplier_source="SUPPLIER_MASTER")  # master pick needs its id
    with pytest.raises(BadRequestError):
        _out(ret, 1, supplier_source="TYPED")
    with pytest.raises(BadRequestError):
        _out(ret, 1, ven_name="  ")                    # a supplier name is required
    assert SpareRgp.query.filter_by(part_id=p.id).count() == 0

    gate = _out(ret, 1, ven_cd=" vrg-001 ", ven_name=None, supplier_source="GATE_ENTRY")
    assert gate["ven_cd"] == "VRG-001"                 # stored in ERP's spelling
    assert gate["ven_name"] == "ABC ENGINEERING"       # name taken from ERP
    grn = _out(ret, 1, ven_cd="VRG-GRN", ven_name=None, supplier_source="ERP_GRN")
    assert grn["ven_cd"] == "VRG-GRN" and grn["ven_name"] == "XYZ REWORKS"
    n = _next()
    s = Supplier(vendor_code=f"RGS{n:04d}", supplier_name=f"Master Rework Co {n}", status="Active")
    db.session.add(s)
    db.session.commit()
    master = _out(ret, 1, supplier_id=s.id, ven_name=None, supplier_source="SUPPLIER_MASTER")
    assert master["supplier_id"] == s.id and master["ven_name"] == s.supplier_name
    assert master["ven_cd"] is None                    # never borrowed from the master


def test_supplier_options_erp_first_deduped_no_fabricated_code():
    p = _part()
    n = _next()
    _gate(p.part_no, f"VG{n}", "GATE OLD", date(2026, 6, 1))
    _gate(p.part_no, f"VG{n}", "GATE OLD", date(2026, 8, 1))       # repeat vendor
    _gate(p.part_no, f"VN{n}", "GATE NEW", date(2026, 9, 1))
    _grn_row(p.part_no, f"VG{n}", "GATE OLD", date(2026, 8, 2))     # also a gate vendor
    _grn_row(p.part_no, f"VR{n}", "GRN ONLY", date(2026, 8, 5))
    linked = Supplier(vendor_code=f"VG{n}", supplier_name=f"Gate Old Master {n}", status="Active")
    extra = Supplier(vendor_code=f"MS{n}", supplier_name=f"Master Only {n}", status="Active")
    dup_name = Supplier(vendor_code=f"MD{n}", supplier_name="GRN ONLY", status="Active")
    gone = Supplier(vendor_code=f"MI{n}", supplier_name=f"Inactive {n}", status="Inactive")
    db.session.add_all([linked, extra, dup_name, gone])
    db.session.commit()

    opts = SpareRgpService().supplier_options(p.id)
    erp = [o for o in opts if o["source"] != "SUPPLIER_MASTER"]
    assert [(o["ven_cd"], o["source"]) for o in erp] == [
        (f"VN{n}", "GATE_ENTRY"), (f"VG{n}", "GATE_ENTRY"), (f"VR{n}", "ERP_GRN")]
    assert erp[1]["last_date"] == "2026-08-01"          # the vendor's latest arrival
    assert erp[1]["supplier_id"] == linked.id           # linked to the master by code
    names = [o["ven_name"] for o in opts]
    assert f"Gate Old Master {n}" not in names          # not listed twice
    assert names.count("GRN ONLY") == 1                 # same name de-duplicated
    assert f"Inactive {n}" not in names
    mine = next(o for o in opts if o["ven_name"] == f"Master Only {n}")
    assert mine == {"ven_cd": None, "ven_name": f"Master Only {n}", "supplier_id": extra.id,
                    "source": "SUPPLIER_MASTER", "last_date": None}
    assert all(o["ven_cd"] is None for o in opts if o["source"] == "SUPPLIER_MASTER")
    # ERP options come before any master row.
    first_master = next(i for i, o in enumerate(opts) if o["source"] == "SUPPLIER_MASTER")
    assert all(o["source"] == "SUPPLIER_MASTER" for o in opts[first_master:])


# ---- dates / overdue ----

def test_dates_and_overdue():
    svc = SpareRgpService()
    p, ret = _returned(damaged=3)
    today = date.today()
    with pytest.raises(BadRequestError):
        _out(ret, 1, rgp_date=today, expected_return_date=today - timedelta(days=1))
    with pytest.raises(BadRequestError):
        _out(ret, 1, rgp_date=today + timedelta(days=1))
    plain = _out(ret, 1)
    assert plain["rgp_date"] == today.isoformat()      # defaults to today
    assert plain["expected_return_date"] is None and plain["overdue"] is False

    late = _out(ret, 2, rgp_date=today - timedelta(days=10),
                expected_return_date=(today - timedelta(days=1)).isoformat())
    assert late["overdue"] is True and late["days_with_supplier"] == 10
    back = svc.supplier_return(late["id"], 2)
    assert back["overdue"] is False                    # nothing with the supplier any more


def test_rgp_numbers_are_sequential_rgp_yyyy_nnnnn():
    p, ret = _returned(damaged=2)
    a = _out(ret, 1)["rgp_no"]
    b = _out(ret, 1)["rgp_no"]
    pattern = re.compile(r"^RGP-(\d{4})-(\d{5})$")
    ma, mb = pattern.match(a), pattern.match(b)
    assert ma and mb
    assert ma.group(1) == mb.group(1) == f"{date.today():%Y}"
    assert int(mb.group(2)) == int(ma.group(2)) + 1


# ---- journal ----

def test_every_step_writes_one_journal_row():
    svc = SpareRgpService()
    p, ret = _returned(damaged=2, hold=1)
    rgp = _out(ret, 2, ven_name="ABC Engineering", remarks="urgent")
    svc.supplier_return(rgp["id"], 2, remarks="came back ok", user="store2")
    done = svc.rgp_grn(rgp["id"], 2, "GRN-J1", user="supervisor")

    rows = (SpareTransaction.query.filter_by(rgp_id=rgp["id"])
            .order_by(SpareTransaction.id.asc()).all())
    assert [r.txn_type for r in rows] == ["RGP_OUT", "RGP_RETURN", "RGP_GRN"]
    out, back, grn = rows
    assert (out.from_bucket, out.to_bucket) == ("DAMAGED", "WITH_SUPPLIER")
    assert (out.prev_status, out.new_status) == ("DAMAGED", "WITH_SUPPLIER")
    assert out.return_id == ret.id and out.issue_id == ret.issue_id
    assert out.rgp_no == rgp["rgp_no"] and out.supplier_name == "ABC Engineering"
    assert "Worn seal" in out.remarks and "urgent" in out.remarks
    assert float(out.qty) == 2.0 and out.created_by == "store1" and out.ledger_id is None
    assert (back.from_bucket, back.to_bucket) == ("WITH_SUPPLIER", "RGP_GRN_PENDING")
    assert back.ledger_id is None and back.created_by == "store2"
    assert (grn.from_bucket, grn.to_bucket) == ("RGP_GRN_PENDING", "AVAILABLE")
    assert grn.grn_no == "GRN-J1" and grn.ledger_id == done["ledger_id"]
    assert grn.created_by == "supervisor"

    other = _out(ret, 1)                               # the held piece
    svc.cancel(other["id"], "Raised twice", user="store1")
    cancel = SpareTransaction.query.filter_by(rgp_id=other["id"], txn_type="CANCEL").one()
    assert (cancel.from_bucket, cancel.to_bucket) == ("WITH_SUPPLIER", "RETURN_HOLD")
    assert cancel.new_status == "CANCELLED" and cancel.remarks == "Raised twice"


# ---- two terminals at once ----

def _race(app, fn):
    """Run `fn` on two threads lined up on a barrier; return their outcomes."""
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
                outcome = f"error:{type(exc).__name__}"
        with guard:
            results.append(outcome)

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    db.session.expire_all()  # see the other sessions' committed writes
    return sorted(results)


def test_concurrent_rgp_out_sends_the_same_piece_once(app):
    p, ret = _returned(damaged=2)
    ret_id = ret.id
    outcome = _race(app, lambda: SpareRgpService().rgp_out(
        ret_id, 2, ven_name="ABC", supplier_source="NAME_ONLY", rework_reason="x"))
    assert outcome == ["ok", "rejected"], outcome
    assert SpareRgp.query.filter_by(part_id=p.id).count() == 1
    r = _ret(ret_id)
    assert r.q("qty_damaged") == 0 and r.q("qty_rgp") == 2


def test_concurrent_rgp_grn_adds_stock_once(app):
    svc = SpareRgpService()
    p, ret = _returned(damaged=2, opening=10)
    rgp_id = _out(ret, 2)["id"]
    svc.supplier_return(rgp_id, 2)
    outcome = _race(app, lambda: SpareRgpService().rgp_grn(rgp_id, 2, "GRN-RACE"))
    assert outcome == ["ok", "rejected"], outcome
    assert SpareStockLedger.query.filter_by(part_id=p.id, txn_type="RECEIPT").count() == 1
    assert _on_hand(p.id) == 10.0


# ---- reads ----

def test_list_open_for_part_and_to_dict():
    svc = SpareRgpService()
    p, ret = _returned(damaged=2)
    rgp = _out(ret, 1)
    closed = _out(ret, 1)
    svc.supplier_return(closed["id"], 1)
    svc.rgp_grn(closed["id"], 1, "GRN-L1")

    open_ids = {r["id"] for r in svc.list("MAINTENANCE", status="OPEN")}
    assert rgp["id"] in open_ids and closed["id"] not in open_ids
    assert rgp["id"] in {r["id"] for r in svc.list("MAINTENANCE", status="WITH_SUPPLIER")}
    assert closed["id"] in {r["id"] for r in svc.list("MAINTENANCE", status="CLOSED")}
    assert rgp["id"] not in {r["id"] for r in svc.list("CHILD_PART")}
    with pytest.raises(BadRequestError):
        svc.list("MAINTENANCE", status="LOST")

    mine = svc.open_for_part(p.id)
    assert [r["id"] for r in mine] == [rgp["id"]]
    d = mine[0]
    assert d["part_no"] == p.part_no and d["part_name"] == p.part_name
    assert d["return_no"] == ret.return_no and d["source_return_id"] == ret.id
    assert d["qty_with_supplier"] == 1.0 and d["qty_grn_pending"] == 0.0


# ---- HTTP ----

@pytest.fixture()
def client(app):
    return app.test_client()


def _login(client, user_id):
    with client.session_transaction() as sess:
        sess["user_id"] = user_id


def _user(stores=("MAINTENANCE",), perms=None, role="STORE_USER"):
    n = _next()
    u = User(username=f"rgpu{n}", role=role, is_active=True)
    u.set_password("pw")
    u.set_permissions({"scan_part": {"view": True, "edit": True}} if perms is None else perms)
    db.session.add(u)
    db.session.flush()
    for code in stores:
        db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
    db.session.commit()
    return u


def test_routes_full_flow(client):
    p, ret = _returned(damaged=2, opening=10)
    _login(client, _user().id)

    r = client.post(f"/api/v1/spare-flow/returns/{ret.id}/rgp-out", json={
        "qty": 2, "ven_name": "ABC Engineering", "supplier_source": "NAME_ONLY",
        "rework_reason": "Crack on housing", "expected_return_date": date.today().isoformat(),
        "erp_challan_no": "CH-77", "scan_source": "QR_SCAN", "scanned_code": p.part_no})
    assert r.status_code == 201, r.get_json()
    rgp = r.get_json()["data"]
    assert rgp["status"] == "WITH_SUPPLIER" and rgp["erp_challan_no"] == "CH-77"
    assert rgp["part_no"] == p.part_no
    journal = SpareTransaction.query.filter_by(rgp_id=rgp["id"], txn_type="RGP_OUT").one()
    assert journal.scan_source == "QR_SCAN" and journal.created_by.startswith("rgpu")

    listed = client.get("/api/v1/spare-flow/rgps?store_code=MAINTENANCE&status=OPEN").get_json()["data"]
    assert rgp["id"] in {x["id"] for x in listed}

    r = client.post(f"/api/v1/spare-flow/rgps/{rgp['id']}/supplier-return", json={"qty": 2})
    assert r.status_code == 201 and r.get_json()["data"]["status"] == "RGP_GRN_PENDING"
    r = client.post(f"/api/v1/spare-flow/rgps/{rgp['id']}/grn",
                    json={"qty": 2, "grn_no": "GRN-H1", "grn_date": date.today().isoformat()})
    assert r.status_code == 201
    assert r.get_json()["data"]["status"] == "CLOSED"
    assert _on_hand(p.id) == 10.0

    opts = client.get(f"/api/v1/spare-flow/parts/{p.id}/supplier-options")
    assert opts.status_code == 200 and isinstance(opts.get_json()["data"], list)


def test_route_business_and_shape_errors(client):
    p, ret = _returned(damaged=1)
    _login(client, _user().id)
    url = f"/api/v1/spare-flow/returns/{ret.id}/rgp-out"
    base = {"qty": 1, "ven_name": "ABC", "supplier_source": "NAME_ONLY", "rework_reason": "x"}
    assert client.post(url, json={**base, "rework_reason": None}).status_code == 422
    assert client.post(url, json={**base, "qty": 0}).status_code == 422
    assert client.post(url, json={**base, "qty": 5}).status_code == 400
    assert client.post(url, json={**base, "ven_cd": "TYPED-1", "supplier_source": "GATE_ENTRY"}).status_code == 400
    assert client.post("/api/v1/spare-flow/returns/987654/rgp-out", json=base).status_code == 404
    assert client.post("/api/v1/spare-flow/rgps/987654/grn", json={"qty": 1, "grn_no": "G"}).status_code == 404
    assert client.get("/api/v1/spare-flow/rgps?store_code=MAINTENANCE&status=LOST").status_code == 400


def test_writes_need_scan_part_edit(client):
    p, ret = _returned(damaged=1)
    _login(client, _user(perms={"scan_part": {"view": True}}).id)
    r = client.post(f"/api/v1/spare-flow/returns/{ret.id}/rgp-out", json={
        "qty": 1, "ven_name": "ABC", "supplier_source": "NAME_ONLY", "rework_reason": "x"})
    assert r.status_code == 403
    assert SpareRgp.query.filter_by(part_id=p.id).count() == 0
    # Reads need only the store.
    assert client.get("/api/v1/spare-flow/rgps?store_code=MAINTENANCE").status_code == 200


def test_store_access_enforced(client):
    p, ret = _returned(damaged=1)
    rgp = _out(ret, 1)
    _login(client, _user(stores=()).id)
    body = {"qty": 1, "ven_name": "ABC", "supplier_source": "NAME_ONLY", "rework_reason": "x"}
    assert client.post(f"/api/v1/spare-flow/returns/{ret.id}/rgp-out", json=body).status_code == 403
    assert client.post(f"/api/v1/spare-flow/rgps/{rgp['id']}/cancel", json={"reason": "x"}).status_code == 403
    assert client.get("/api/v1/spare-flow/rgps?store_code=MAINTENANCE").status_code == 403
    assert client.get(f"/api/v1/spare-flow/parts/{p.id}/supplier-options").status_code == 403


def test_legacy_rgp_report_post_needs_child_store_edit(client):
    _login(client, _user().id)                           # scan_part only
    body = {"store_code": "CHILD_PART", "challan_no": "LEG-1", "item_cd": "X"}
    assert client.post("/api/v1/rgp", json=body).status_code == 403
    _login(client, _user(stores=("CHILD_PART",), perms={"child_store": {"view": True, "edit": True}}).id)
    assert client.post("/api/v1/rgp", json=body).status_code == 201


# ---- where reworked material goes back (store rule, 14 Oct 2026) ----

FRESH, REWORK = "R3-S6-B31(1)", "R2-S6-B35(1)"


def _two_bin_part(location=FRESH, rework_location=REWORK):
    p = _part()
    p.location, p.rework_location = location, rework_location
    db.session.commit()
    return p


def test_rgp_grn_step_names_the_rework_bin(client):
    """A part with a rework location (CNTR3200): the RGP document, Scan Part's
    open RGP, the Work Queue row, the RGP GRN message and the ledger remark all
    say the reworked material goes to the REWORK bin, not the fresh one."""
    svc = SpareRgpService()
    p, ret = _returned(damaged=1, opening=4, part=_two_bin_part())
    rgp = _out(ret, 1)
    assert rgp["rework_bin"] == REWORK
    svc.supplier_return(rgp["id"], 1, user="store1")

    scan = ScanResultService().build(p.id)
    mine = next(g for g in scan["open_rgps"] if g["id"] == rgp["id"])
    assert mine["rework_bin"] == REWORK and mine["qty_grn_pending"] == 1.0
    assert scan["part"]["location"] == FRESH and scan["part"]["rework_location"] == REWORK
    queue = ScanResultService().queues("MAINTENANCE")["rgp_grn_pending"]
    assert next(g for g in queue if g["id"] == rgp["id"])["rework_bin"] == REWORK

    _login(client, _user().id)
    r = client.post(f"/api/v1/spare-flow/rgps/{rgp['id']}/grn", json={"qty": 1, "grn_no": "GRN-RW1"})
    assert r.status_code == 201, r.get_json()
    body = r.get_json()
    assert body["message"].endswith(f"put it in the rework bin {REWORK}")
    assert body["data"]["rework_bin"] == REWORK and body["data"]["status"] == "CLOSED"
    row = SpareStockLedger.query.filter_by(part_id=p.id, txn_type="RECEIPT").one()
    assert row.remarks == f"RGP GRN GRN-RW1 · to the rework bin {REWORK}"
    assert _on_hand(p.id) == 4.0                       # one stock figure, back in full


def test_without_a_separate_rework_bin_it_goes_back_to_its_own_location(client):
    """No rework location, or one that is the fresh bin itself: nothing is said
    about a rework bin and the ledger remark stays as before."""
    assert rework_bin(_two_bin_part(rework_location=None)) is None
    assert rework_bin(_two_bin_part(rework_location="r3-s6-b31 (1)")) is None   # same bin
    assert rework_bin(_two_bin_part(location=None)) == REWORK  # only a rework bin
    assert rework_bin(None) is None

    svc = SpareRgpService()
    p, ret = _returned(damaged=1, part=_two_bin_part(rework_location=None))
    rgp = _out(ret, 1)
    assert rgp["rework_bin"] is None
    svc.supplier_return(rgp["id"], 1)
    _login(client, _user().id)
    r = client.post(f"/api/v1/spare-flow/rgps/{rgp['id']}/grn", json={"qty": 1, "grn_no": "GRN-RW2"})
    assert r.status_code == 201
    assert "rework bin" not in r.get_json()["message"]
    assert SpareStockLedger.query.filter_by(part_id=p.id, txn_type="RECEIPT").one().remarks == "RGP GRN GRN-RW2"
