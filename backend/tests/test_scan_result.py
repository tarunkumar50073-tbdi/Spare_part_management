"""The one scan result, the part timeline and the work queues (spec 2 / 10 / 21 /
22 / 27 / 30) — /api/v1/spare-flow/parts/<id>/scan-result, /timeline, /queues.

Fixtures build the documents straight from the models (returns / RGPs / journal
/ ledger / ERP GRN mirror rows), plus SpareStockService for stock and issues, so
these tests pin how the scan READS the documents — not how the other flows write
them. Receiving is read from ERP (test_erp_receiving.py covers it in depth).
"""
from datetime import date, datetime, timedelta

import pytest

from app.extensions import db
from app.models.base import utcnow
from app.models.gate_entry import GateEntry
from app.models.label_print_audit import LabelPrintAudit
from app.models.location_history import SpareLocationHistory
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.spare_flow import SpareReceipt, SpareReturn, SpareRgp
from app.models.spare_stock import SpareStockLedger
from app.models.store import Store
from app.models.user import User, UserStoreAccess
from app.services.scan_result_service import (
    BUCKET_KEYS, INACTIVE_REASON, ScanResultService, primary_status,
)
from app.services.spare_flow_service import SpareFlowService
from app.services.spare_journal_service import SpareJournalService
from app.services.spare_part_overview_service import SparePartOverviewService
from app.services.spare_return_service import SpareReturnService
from app.services.spare_rgp_service import SpareRgpService
from app.services.spare_stock_service import SpareStockService

_seq = {"n": 0}

# Issuance first; receiving (receive / GRN / quality) is read from ERP.
ACTION_ORDER = [
    "ISSUE", "RGP_GRN", "RGP_RETURN", "INSPECT", "RETURN", "UPDATE_INSTALLATION", "RGP_OUT",
    "PRINT_LABEL", "UPDATE_LOCATION", "HISTORY",
]


def _n():
    _seq["n"] += 1
    return _seq["n"]


def _part(store="MAINTENANCE", **kw):
    p = Part(part_no=f"SR-{_n():04d}", part_name="Proximity Sensor", uom="NO",
             part_type="OTHER", store_code=store, **kw)
    db.session.add(p)
    db.session.commit()
    return p


def _issue(part, qty, **kw):
    res = SpareStockService().issue(part.id, qty, "Maintenance", **kw)
    return db.session.get(SpareStockLedger, res["issue"]["id"])


def _legacy_receipt(part, status, qty, **kw):
    """A receipt the store recorded in the app before receiving moved to ERP."""
    r = SpareReceipt(receipt_no=f"RCV-T-{_n():05d}", part_id=part.id, store_code=part.store_code,
                     status=status, qty_received=qty, **kw)
    db.session.add(r)
    db.session.commit()
    return r


def _erp_grn(part, receipt, accept=None, reject=None, days_ago=3):
    """An ERP GRN mirror row for the part. accept_qty empty = quality pending in
    ERP. The part is counted today, so an accepted GRN dated before today is
    already inside that count (never added again)."""
    grn_no = f"GRN-SR-{_n():05d}"
    db.session.add(ReceivingRegister(store_code="CHILD_PART", item_cd=part.part_no, grn_no=grn_no,
                                     grn_date=date.today() - timedelta(days=days_ago), ven_cd="VA-1",
                                     ven_name="ABC Engineering", receipt_qty=receipt, accept_qty=accept,
                                     reject_qty=reject))
    db.session.commit()
    return grn_no


def _return(part, issue, qty, **split):
    """A return against `issue`; the issue's status follows (RETURNED when
    nothing is left out), as the return flow sets it."""
    r = SpareReturn(return_no=f"RET-T-{_n():05d}", part_id=part.id, store_code=part.store_code,
                    issue_id=issue.id, qty=qty, reason="Fitment Issue",
                    department=issue.department, issued_to=issue.issued_to,
                    **{k: split.get(k, 0) for k in ("qty_pending", "qty_hold", "qty_damaged",
                                                    "qty_good", "qty_scrap", "qty_rgp")})
    r.refresh_status()
    db.session.add(r)
    db.session.flush()
    returned = sum(float(x.qty) for x in SpareReturn.query.filter_by(issue_id=issue.id).all())
    issue.status = "RETURNED" if returned >= abs(float(issue.qty_delta)) else "PARTIALLY_RETURNED"
    db.session.commit()
    return r


def _rgp(part, ret, qty_out, qty_returned=0, qty_grn=0, **kw):
    g = SpareRgp(rgp_no=f"RGP-T-{_n():05d}", part_id=part.id, store_code=part.store_code,
                 source_return_id=ret.id, source_bucket="DAMAGED",
                 ven_name=kw.pop("ven_name", "ABC Engineering"), qty_out=qty_out,
                 qty_returned=qty_returned, qty_grn=qty_grn, rework_reason="Re-machining",
                 rgp_date=date.today(), **kw)
    g.refresh_status()
    db.session.add(g)
    db.session.commit()
    return g


def _acts(scan):
    return {a["key"]: a for a in scan["actions"]}


# ---- headline -------------------------------------------------------------------

def _b(**kw):
    b = dict.fromkeys(BUCKET_KEYS, 0.0)
    b.update(kw)
    return b


def test_primary_status_is_the_first_true_state_in_priority_order():
    order = [("available", "STOCK_AVAILABLE"), ("quality_pending", "QUALITY_PENDING"),
             ("return_pending", "RETURN_INSPECTION"), ("issued_out", "ISSUED"),
             ("with_supplier", "WITH_SUPPLIER"), ("rgp_grn_pending", "RGP_GRN_PENDING"),
             ("damaged", "DAMAGED")]
    for i, (_, key) in enumerate(order):
        # every later state is also true — the earlier one still wins
        assert primary_status(_b(**{k: 1 for k, _ in order[i:]}), counted=True)["key"] == key
    # held returns still wait on the store's decision
    assert primary_status(_b(return_hold=2), True)["key"] == "RETURN_INSPECTION"
    assert primary_status(_b(), True) == {"key": "OUT_OF_STOCK", "label": "Out of Stock"}
    assert primary_status(_b(), False) == {"key": "NOT_COUNTED", "label": "Not Counted"}


def test_headline_and_primary_action_follow_the_documents():
    p = _part(location="A1-03")
    SpareStockService().set_quantity(p.id, 2, txn_type="OPENING")
    scan = ScanResultService()

    r = scan.build(p.id)
    assert r["primary_status"]["key"] == "STOCK_AVAILABLE" and r["primary_action"] == "ISSUE"
    assert r["stock"] == {"qty_on_hand": 2.0, "status": "Healthy", "counted": True,
                          "last_counted_at": r["stock"]["last_counted_at"]}

    _issue(p, 2)                                      # rack empty, 2 out on the floor
    r = scan.build(p.id)
    assert (r["buckets"]["available"], r["buckets"]["issued_out"]) == (0.0, 2.0)
    assert r["primary_status"]["key"] == "ISSUED" and r["primary_action"] == "RETURN"
    assert r["stock"]["status"] == "Out of Stock"

    _erp_grn(p, 3)                                    # GRN in ERP, quality pending there
    r = scan.build(p.id)
    assert r["primary_status"]["key"] == "QUALITY_PENDING"
    assert r["primary_action"] == "RETURN"            # quality is ERP's step, not the scan's


def test_never_counted_part_with_nothing_open():
    r = ScanResultService().build(_part().id)
    assert r["primary_status"]["key"] == "NOT_COUNTED" and r["stock"]["counted"] is False
    assert r["statuses"] == [] and r["locations"] == [] and r["primary_action"] is None
    assert r["timeline"] == {"rows": [], "has_more": False}


# ---- actions --------------------------------------------------------------------

def test_with_supplier_offers_rgp_return_and_never_issue():
    p = _part()
    SpareStockService().set_quantity(p.id, 1, txn_type="OPENING")
    iss = _issue(p, 1)
    ret = _return(p, iss, 1, qty_rgp=1)               # inspected damaged, sent for rework
    g = _rgp(p, ret, 1)
    scan = ScanResultService()

    r = scan.build(p.id)
    assert r["buckets"]["with_supplier"] == 1.0
    assert r["buckets"]["available"] == 0.0 and r["buckets"]["issued_out"] == 0.0
    assert r["primary_status"] == {"key": "WITH_SUPPLIER", "label": "With Supplier – Rework"}
    acts = _acts(r)
    assert [a["key"] for a in r["actions"]] == ACTION_ORDER      # every key, in order
    assert acts["RGP_RETURN"]["enabled"] and acts["RGP_RETURN"]["count"] == 1
    assert not acts["ISSUE"]["enabled"] and acts["ISSUE"]["reason"] == "No stock available to issue"
    for key in ("RETURN", "UPDATE_INSTALLATION", "INSPECT", "RGP_GRN"):
        assert not acts[key]["enabled"] and acts[key]["reason"]
    assert "no direct RGP" in acts["RGP_OUT"]["reason"]
    assert acts["HISTORY"]["enabled"] and acts["UPDATE_LOCATION"]["enabled"]
    assert r["primary_action"] == "RGP_RETURN"
    sup = [loc for loc in r["locations"] if loc["kind"] == "SUPPLIER"]
    assert sup == [{"kind": "SUPPLIER", "label": f"With ABC Engineering – rework ({g.rgp_no})",
                    "qty": 1.0, "supplier": "ABC Engineering", "ref_type": "rgp", "ref_id": g.id}]
    assert r["open_rgps"][0]["return_no"] == ret.return_no and r["open_rgps"][0]["overdue"] is False

    # the supplier sends it back: now it waits for the RGP GRN — still not issuable
    g.qty_returned = 1
    g.refresh_status()
    db.session.commit()
    r = scan.build(p.id)
    acts = _acts(r)
    assert r["primary_status"]["key"] == "RGP_GRN_PENDING"
    assert acts["RGP_GRN"]["enabled"] and not acts["RGP_RETURN"]["enabled"]
    assert not acts["ISSUE"]["enabled"] and r["primary_action"] == "RGP_GRN"


def test_inactive_part_disables_every_write():
    p = _part(is_active=False)
    SpareStockService().set_quantity(p.id, 5, txn_type="OPENING")
    _erp_grn(p, 2)
    r = ScanResultService().build(p.id)
    assert r["part"]["is_active"] is False
    for a in r["actions"]:
        if a["key"] == "HISTORY":
            assert a["enabled"] and a["reason"] is None
        else:
            assert (a["enabled"], a["reason"]) == (False, INACTIVE_REASON), a["key"]
    assert r["primary_action"] is None
    assert r["primary_status"]["key"] == "STOCK_AVAILABLE"      # the facts don't change


# ---- buckets / statuses / locations / open documents -----------------------------

def test_buckets_sum_the_open_documents():
    p = _part(location="B2-01")
    SpareStockService().set_quantity(p.id, 10, txn_type="OPENING")
    iss_a = _issue(p, 2, issued_to="Ravi")            # nothing back: 2 out
    iss_b = _issue(p, 4)                              # 3 back: 1 out
    r1 = _return(p, iss_b, 2, qty_pending=1, qty_hold=1)
    r2 = _return(p, iss_b, 1, qty_damaged=1)
    iss_c = _issue(p, 3)                              # all back, all went on RGP
    r3 = _return(p, iss_c, 3, qty_rgp=3)
    g1 = _rgp(p, r3, 3, qty_returned=1, expected_return_date=date.today() - timedelta(days=2))
    _rgp(p, r3, 5, status="CANCELLED")                # cancelled: counts nowhere
    grn_a = _erp_grn(p, 2, days_ago=4)                # quality pending in ERP
    grn_b = _erp_grn(p, 3, days_ago=2)
    _erp_grn(p, 5, accept=5)                          # accepted, inside today's count: nowhere
    _erp_grn(p, 1, reject=1)                          # rejected by quality: nowhere
    _legacy_receipt(p, "RECEIVED", 9)                 # in-app, before the change: nowhere either

    r = ScanResultService().build(p.id)
    assert r["buckets"] == {
        "available": 1.0, "quality_pending": 5.0, "issued_out": 3.0,
        "return_pending": 1.0, "return_hold": 1.0, "damaged": 1.0,
        "with_supplier": 2.0, "rgp_grn_pending": 1.0,
    }
    assert ScanResultService().buckets(p.id) == r["buckets"]
    assert [(s["key"], s["qty"]) for s in r["statuses"]] == [
        ("STOCK_AVAILABLE", 1.0), ("QUALITY_PENDING", 5.0), ("ISSUED", 3.0),
        ("RETURN_INSPECTION", 1.0), ("RETURN_HOLD", 1.0), ("DAMAGED", 1.0),
        ("WITH_SUPPLIER", 2.0), ("RGP_GRN_PENDING", 1.0),
    ]
    assert r["primary_status"]["key"] == "STOCK_AVAILABLE"

    kinds = [loc["kind"] for loc in r["locations"]]
    assert kinds.count("STORE") == 1 and kinds.count("QUALITY") == 2
    assert kinds.count("LINE") == 2 and kinds.count("RETURN_HOLD") == 3 and kinds.count("SUPPLIER") == 2
    assert r["locations"][0] == {"kind": "STORE", "label": "Store – B2-01", "qty": 1.0}
    line_a = next(loc for loc in r["locations"] if loc.get("ref_id") == iss_a.id)
    assert (line_a["qty"], line_a["department"], line_a["issued_to"]) == (2.0, "Maintenance", "Ravi")
    # every location quantity adds back up to the buckets
    assert round(sum(loc["qty"] for loc in r["locations"]), 2) == round(sum(r["buckets"].values()), 2)

    quality = [loc for loc in r["locations"] if loc["kind"] == "QUALITY"]
    assert [(loc["ref_id"], loc["qty"]) for loc in quality] == [(grn_b, 3.0), (grn_a, 2.0)]   # newest GRN first
    assert [ln["grn_no"] for ln in r["erp_receiving"]["lines"]] == [grn_b, grn_a]
    assert {i["id"] for i in r["open_issues"]} == {iss_a.id, iss_b.id}
    b = next(i for i in r["open_issues"] if i["id"] == iss_b.id)
    assert (b["issued_qty"], b["returned_qty"], b["outstanding_qty"]) == (4.0, 3.0, 1.0)
    assert {x["id"] for x in r["open_returns"]} == {r1.id, r2.id}      # r3 is closed
    assert [g["id"] for g in r["open_rgps"]] == [g1.id]
    assert r["open_rgps"][0]["overdue"] is True                        # past expected, still out
    assert (r["open_rgps"][0]["qty_with_supplier"], r["open_rgps"][0]["qty_grn_pending"]) == (2.0, 1.0)

    acts = _acts(r)
    counts = {k: acts[k]["count"] for k in ("RGP_GRN", "RGP_RETURN", "INSPECT", "RETURN", "RGP_OUT")}
    assert counts == {"RGP_GRN": 1, "RGP_RETURN": 1, "INSPECT": 2, "RETURN": 2, "RGP_OUT": 2}
    assert all(acts[k]["enabled"] for k in counts) and acts["ISSUE"]["enabled"]
    # Scanning is mainly for issuance: with stock on the rack, ISSUE leads.
    assert r["primary_action"] == "ISSUE"


# ---- label ----------------------------------------------------------------------

def test_label_block_print_then_reprint_and_stale_location():
    p = _part(location="A1-03")
    scan = ScanResultService()
    r = scan.build(p.id)
    keys = [a["key"] for a in r["actions"]]
    assert "PRINT_LABEL" in keys and "REPRINT_LABEL" not in keys
    assert r["label"]["printed_count"] == 0 and r["label"]["location_changed_since_print"] is False

    db.session.add(LabelPrintAudit(part_id=p.id, barcode_value=p.part_no, copies=2,
                                   printed_by="store1", source="SUPPLIER_BARCODE",
                                   printer_name="Spare Parts Store Label Printer",
                                   symbology="QR", location_printed="A1-03"))
    db.session.commit()
    r = scan.build(p.id)
    keys = [a["key"] for a in r["actions"]]
    assert "REPRINT_LABEL" in keys and "PRINT_LABEL" not in keys
    lab = r["label"]
    assert (lab["printed_count"], lab["copies_total"], lab["last_printed_by"]) == (1, 2, "store1")
    assert lab["last_location_printed"] == "A1-03" and lab["location_changed_since_print"] is False

    # the part moves rack: the printed location is now stale
    db.session.add(SpareLocationHistory(part_id=p.id, old_location="A1-03", new_location="B4-02",
                                        reason="Rack re-layout", moved_by="store1"))
    p.location = "B4-02"
    db.session.commit()
    assert scan.build(p.id)["label"]["location_changed_since_print"] is True

    # an older-style print that recorded no location cannot be judged
    db.session.add(LabelPrintAudit(part_id=p.id, barcode_value=p.part_no, copies=1, is_reprint=True,
                                   reason="Torn"))
    db.session.commit()
    assert scan.build(p.id)["label"]["location_changed_since_print"] is False


# ---- timeline -------------------------------------------------------------------

def test_timeline_merges_every_source_newest_first_without_duplicates():
    p = _part(location="A1-03")
    stock = SpareStockService()
    journal = SpareJournalService()
    stock.set_quantity(p.id, 5, txn_type="OPENING")               # legacy: ledger only
    legacy = SpareStockLedger(part_id=p.id, txn_type="ISSUE", qty_delta=-1, balance_after=4,
                              department="Tool Room", line_name="Seat Slider", line_no="2",
                              machine="OP-30", status="INSTALLED", actual_qty=1,
                              confirmed_by="fitter", confirmed_at=utcnow())
    db.session.add(legacy)
    db.session.commit()
    db.session.add(SpareStockLedger(part_id=p.id, txn_type="RETURN", qty_delta=1, balance_after=5,
                                    return_of_id=legacy.id, return_no="RET-OLD-1",
                                    return_reason="Did not fit", returned_by="Amit"))
    db.session.commit()

    iss = _issue(p, 2, issued_to="Ravi")                          # journal + ledger
    journal.record(p.id, "INSTALLATION", 2, store_code=p.store_code, user="fitter",
                   prev_status="PENDING_USER_CONFIRMATION", new_status="INSTALLED",
                   issue_id=iss.id, department="Maintenance", line_no="03",
                   machine="Press 07", die_no="Die-12")

    # The in-app receiving of the earlier flow stays in history as recorded.
    rec = _legacy_receipt(p, "RECEIVED", 4, ven_name="ABC Engineering", invoice_no="INV-9")
    journal.record(p.id, "RECEIVE", 4, store_code=p.store_code, receipt_id=rec.id,
                   from_bucket="SUPPLIER", to_bucket="QUALITY_PENDING",
                   supplier_name="ABC Engineering", invoice_no="INV-9", new_status="RECEIVED")
    journal.record(p.id, "GRN", 4, store_code=p.store_code, receipt_id=rec.id, grn_no="GRN-77",
                   prev_status="RECEIVED", new_status="QUALITY_PENDING")
    led = SpareStockLedger(part_id=p.id, txn_type="RECEIPT", qty_delta=4, balance_after=7,
                           status="STOCK_AVAILABLE", reference="GRN-77")
    db.session.add(led)
    db.session.commit()
    journal.record(p.id, "QUALITY_CLEARANCE", 4, store_code=p.store_code, receipt_id=rec.id,
                   ledger_id=led.id, grn_no="GRN-77", department="Maintenance",
                   from_bucket="QUALITY_PENDING", to_bucket="AVAILABLE",
                   prev_status="QUALITY_PENDING", new_status="STOCK_AVAILABLE")

    db.session.add(LabelPrintAudit(part_id=p.id, barcode_value=p.part_no, copies=1,
                                   printed_by="store1", source="QR_SCAN", location_printed="A1-03"))
    db.session.add(SpareLocationHistory(part_id=p.id, old_location="A1-03", new_location="B4-02",
                                        moved_by="store1"))
    db.session.add(GateEntry(store_code="MAINTENANCE", item_code=p.part_no, ven_cd="VA-1",
                             ven_name="ABC Engineering", gate_entry_dt=date(2026, 6, 16),
                             gate_entry_time="09:20", qty=4, gate_entry_no=f"GE-{p.part_no}"))
    db.session.add(ReceivingRegister(store_code="MAINTENANCE", item_cd=p.part_no, grn_no="GRN-77",
                                     grn_date=date(2026, 6, 16), ven_cd="VA-1",
                                     ven_name="ABC Engineering", receipt_qty=4, accept_qty=4))
    db.session.commit()

    out = ScanResultService().timeline(p.id)
    rows = out["rows"]
    assert out["has_more"] is False

    stamps = [datetime.fromisoformat(r["at"]) for r in rows]
    assert stamps == sorted(stamps, reverse=True)                  # newest first
    kinds = [r["kind"] for r in rows]
    assert {"OPENING", "ISSUE", "INSTALLATION", "RETURN_TO_STORE", "RECEIVE", "GRN",
            "QUALITY_CLEARANCE", "STOCK_AVAILABLE", "LABEL_PRINT", "LOCATION_MOVE",
            "ERP_GATE", "ERP_GRN"} <= set(kinds)

    # two ISSUE ledger rows -> two ISSUE rows: the journal one is not repeated
    issues = [r for r in rows if r["kind"] == "ISSUE"]
    assert sorted(r["source"] for r in issues) == ["journal", "ledger"]
    assert next(r for r in issues if r["source"] == "journal")["title"] == "Issued to Maintenance"
    assert next(r for r in issues if r["source"] == "ledger")["title"] == "Issued to Tool Room"
    assert kinds.count("RECEIVE") == 1 and kinds.count("QUALITY_CLEARANCE") == 1

    titles = {r["title"] for r in rows}
    assert "Installed – Line 03 / Press 07 / Die-12" in titles          # journal installation
    assert "Installed – Seat Slider 2 / OP-30" in titles                # legacy, from the ISSUE row
    assert "Returned to store – Fitment Issue" in titles                # legacy wording mapped
    assert "Received from supplier – ABC Engineering" in titles
    assert "GRN created – GRN-77" in titles and "GRN created in ERP – GRN-77" in titles
    assert "Received at gate – ABC Engineering" in titles
    assert "Location changed – A1-03 → B4-02" in titles
    # The old receipt is still RECEIVED in the app, but its GRN / quality are
    # ERP's now: the row does not claim it is waiting for anything.
    receive = next(r for r in rows if r["kind"] == "RECEIVE")
    assert receive["detail"] == "Invoice INV-9"

    # the clearance's RECEIPT row is shown once, as "Added to store stock",
    # right above the quality clearance that caused it
    added = [i for i, r in enumerate(rows) if r["kind"] == "STOCK_AVAILABLE"]
    assert len(added) == 1
    assert rows[added[0] + 1]["kind"] == "QUALITY_CLEARANCE"
    assert rows[added[0]]["qty_delta"] == 4.0 and rows[added[0]]["title"] == "Added to store stock"

    erp_gate = next(r for r in rows if r["kind"] == "ERP_GATE")
    assert erp_gate["source"] == "erp_gate" and "09:20" in erp_gate["detail"]
    # no app-recorded step claims to have updated ERP
    assert not any("ERP updated" in (r["title"] or "") + (r["detail"] or "") for r in rows)

    # the scan carries the newest 30 of the same timeline
    scan_tl = ScanResultService().build(p.id)["timeline"]
    assert scan_tl["rows"] == rows[:30] and scan_tl["has_more"] is False


def test_waiting_notes_hold_only_while_the_document_still_waits():
    """RETURN_TO_STORE / RGP_RETURN rows say "waiting for …" only while that is
    still true — never under the inspection / RGP GRN rows that settled it.
    Driven through the real services end to end."""
    p = _part(location="A1-03")
    SpareStockService().set_quantity(p.id, 3, txn_type="OPENING")
    scan = ScanResultService()

    def row(kind, nth=0):
        """The nth-oldest row of `kind` (the timeline is newest first)."""
        return [r for r in scan.timeline(p.id)["rows"] if r["kind"] == kind][::-1][nth]

    def detail(kind, nth=0):
        return row(kind, nth)["detail"] or ""

    iss = _issue(p, 3)
    ret = SpareReturnService().return_to_store(iss.id, 3, reason="Fitment Issue", user="store1")
    assert "Waiting for store inspection" in detail("RETURN_TO_STORE")
    SpareReturnService().inspect(ret["id"], "GOOD", 1, user="store1")
    assert "2 of 3 still waiting for store inspection" in detail("RETURN_TO_STORE")
    SpareReturnService().inspect(ret["id"], "DAMAGED", 2, user="store1")
    assert "waiting" not in detail("RETURN_TO_STORE").lower()

    rgps = SpareRgpService()
    g = rgps.rgp_out(ret["id"], 2, ven_name="ABC Engineering", supplier_source="NAME_ONLY",
                     rework_reason="Re-machining", user="store1")
    rgps.supplier_return(g["id"], 1, user="store1")
    rgps.supplier_return(g["id"], 1, user="store1")
    both = "Waiting for the RGP GRN — not in store stock yet"
    assert detail("RGP_RETURN", 0) == both and detail("RGP_RETURN", 1) == both
    # One RGP GRN covers the oldest supplier return first; the newer one still waits.
    rgps.rgp_grn(g["id"], 1, "GRN-R1", user="sup")
    assert detail("RGP_RETURN", 0) == "" and detail("RGP_RETURN", 1) == both
    rgps.rgp_grn(g["id"], 1, "GRN-R2", user="sup")

    # Everything is settled: no row anywhere claims something still waits.
    rows = scan.timeline(p.id)["rows"]
    assert not [r for r in rows if "waiting" in ((r["title"] or "") + (r["detail"] or "")).lower()]
    assert [r["title"] for r in rows].count("Added to store stock") == 3   # GOOD, 2 RGP GRNs


def test_rgp_return_partly_covered_by_its_grn_says_how_much_still_waits():
    p = _part()
    SpareStockService().set_quantity(p.id, 3, txn_type="OPENING")
    iss = _issue(p, 3)
    ret = SpareReturnService().return_to_store(iss.id, 3, reason="Fitment Issue", user="store1")
    SpareReturnService().inspect(ret["id"], "DAMAGED", 3, user="store1")
    rgps = SpareRgpService()
    g = rgps.rgp_out(ret["id"], 3, ven_name="ABC Engineering", supplier_source="NAME_ONLY",
                     rework_reason="Re-machining", user="store1")
    rgps.supplier_return(g["id"], 3, user="store1")
    rgps.rgp_grn(g["id"], 1, "GRN-P1", user="sup")
    row = next(r for r in ScanResultService().timeline(p.id)["rows"] if r["kind"] == "RGP_RETURN")
    assert row["detail"] == "2 of 3 still waiting for the RGP GRN — not in store stock yet"


def test_timeline_pages_with_has_more():
    p = _part()
    svc = SpareStockService()
    for q in (4, 3, 5, 2):
        svc.set_quantity(p.id, q, txn_type="OPENING" if q == 4 else "ADJUSTMENT")
    scan = ScanResultService()
    page = scan.timeline(p.id, limit=2)
    assert len(page["rows"]) == 2 and page["has_more"] is True
    assert page["rows"][0]["kind"] == "STOCK_ADJUSTMENT" and page["rows"][0]["qty_delta"] == -3.0
    full = scan.timeline(p.id, limit=10)
    assert len(full["rows"]) == 4 and full["has_more"] is False
    assert full["rows"][-1]["kind"] == "OPENING"


# ---- work queues ----------------------------------------------------------------

@pytest.fixture()
def queue_store():
    """A store of its own, so the counts see only this test's documents. It is
    switched off afterwards (its parts still point at it): a store left active
    would stop MAINTENANCE being the last active store for later tests."""
    code = f"QT{_n()}"
    db.session.add(Store(code=code, name="Queue Test Store"))
    db.session.commit()
    yield code
    db.session.rollback()
    Store.query.filter_by(code=code).update({"is_active": False})
    db.session.commit()


def test_queues_list_and_count_the_stores_open_work(queue_store):
    code = queue_store
    p = _part(store=code)
    SpareStockService().set_quantity(p.id, 10, txn_type="OPENING")
    first = _erp_grn(p, 2, days_ago=6)                             # quality pending in ERP
    _erp_grn(p, 3, days_ago=2)
    _erp_grn(p, 1, accept=1)                                       # accepted: not queued
    _legacy_receipt(p, "RECEIVED", 5)                              # in-app, before the change: not queued
    iss = _issue(p, 4)
    open_ret = _return(p, iss, 1, qty_pending=1)
    rgp_src = _return(p, iss, 3, qty_rgp=3)
    _rgp(p, rgp_src, 1)                                            # with the supplier
    _rgp(p, rgp_src, 2, qty_returned=2)                            # back, RGP GRN pending
    _issue(p, 1)                                                   # waits for line / machine
    _erp_grn(_part(), 9)                                           # another store's work

    q = ScanResultService().queues(code)
    assert q["counts"] == {"quality": 2, "inspection": 1, "with_supplier": 1,
                           "rgp_grn_pending": 1, "awaiting_confirmation": 1}
    assert q["quality"][0]["grn_no"] == first                      # oldest GRN first
    assert q["quality"][0]["state"] == "QUALITY_PENDING" and q["quality"][0]["age_days"] == 6
    assert all(r["part_no"] == p.part_no for r in q["quality"] + q["inspection"])
    assert set(q["erp"]) == {"synced_at", "newest_grn_date"}
    assert q["inspection"][0]["id"] == open_ret.id
    assert q["with_supplier"][0]["qty_with_supplier"] == 1.0
    assert q["rgp_grn_pending"][0]["qty_grn_pending"] == 2.0
    assert q["awaiting_confirmation"][0]["part_no"] == p.part_no


# ---- part drawer + traceability ---------------------------------------------------

def test_part_overview_carries_buckets_and_primary_status():
    p = _part()
    _erp_grn(p, 3)                                                 # quality pending in ERP
    ov = SparePartOverviewService().overview(p.id)
    assert ov["buckets"]["quality_pending"] == 3.0 and ov["buckets"]["available"] == 0.0
    assert ov["primary_status"]["key"] == "QUALITY_PENDING"
    assert {"part", "stock", "location", "consumption", "erp", "label", "alerts"} <= set(ov)


def test_traceability_reads_the_whole_ledger_and_says_grn():
    p = _part()
    svc = SpareStockService()
    for i in range(30):
        svc.set_quantity(p.id, 10 + i % 2, txn_type="ADJUSTMENT")
    trace = SpareFlowService().traceability(p.id)
    assert len(trace["movements"]) == 30 and len(trace["ledger"]) == 30
    assert "issue_department" not in trace["not_captured"]
    stages = {s["key"]: s["label"] for s in SpareFlowService().material_flow("MAINTENANCE")["stages"]}
    assert stages["srv_created"] == "GRN Created"


def test_traceability_does_not_count_a_booked_grn_twice():
    p = _part()
    db.session.add(GateEntry(store_code="MAINTENANCE", item_code=p.part_no, ven_cd="VA-1",
                             ven_name="ABC Engineering", gate_entry_dt=date(2026, 6, 16), qty=4,
                             gate_entry_no=f"GE-{p.part_no}"))
    for grn in ("IN-55", "IN-56"):
        db.session.add(ReceivingRegister(store_code="MAINTENANCE", item_cd=p.part_no, grn_no=grn,
                                         grn_date=date(2026, 6, 16), ven_cd="VA-1",
                                         ven_name="ABC Engineering", receipt_qty=4, accept_qty=4))
    # the store's quality clearance booked IN-55 into stock itself
    db.session.add(SpareStockLedger(part_id=p.id, txn_type="RECEIPT", qty_delta=4, balance_after=4,
                                    status="STOCK_AVAILABLE", reference="IN-55"))
    db.session.commit()

    led = SpareFlowService().traceability(p.id)["ledger"]
    by_ref = {(e["kind"], e["reference"]): e for e in led}
    assert by_ref[("RECEIVED", "IN-55")]["direction"] == "matched"      # same material
    assert by_ref[("RECEIVED", "IN-56")]["direction"] == "in"           # not booked by the store
    assert by_ref[("RECEIPT", "IN-55")]["direction"] == "in"
    assert sum(e["qty"] for e in led if e["direction"] == "in") == 8.0


def test_store_clearance_demotes_the_gate_row_without_an_erp_grn():
    p = _part()
    db.session.add(GateEntry(store_code="MAINTENANCE", item_code=p.part_no, ven_cd="VA-1",
                             ven_name="ABC Engineering", gate_entry_dt=date(2026, 6, 16), qty=4,
                             gate_entry_no=f"GE-{p.part_no}"))
    db.session.add(SpareStockLedger(part_id=p.id, txn_type="RECEIPT", qty_delta=4, balance_after=4,
                                    status="STOCK_AVAILABLE", reference="IN-57"))
    db.session.commit()
    led = SpareFlowService().traceability(p.id)["ledger"]
    assert next(e for e in led if e["kind"] == "GATE_ARRIVAL")["direction"] == "arrival"


# ---- routes ---------------------------------------------------------------------

@pytest.fixture()
def client(app):
    return app.test_client()


def _login_store_user(client, store="MAINTENANCE"):
    u = User(username=f"scanuser{_n()}", role="STORE_USER", is_active=True)
    u.set_password("pw")
    db.session.add(u)
    db.session.flush()
    db.session.add(UserStoreAccess(user_id=u.id, store_code=store))
    db.session.commit()
    with client.session_transaction() as s:
        s["user_id"] = u.id


def test_routes_are_store_scoped(client):
    _login_store_user(client)
    mine, theirs = _part(), _part("CHILD_PART")
    base = "/api/v1/spare-flow"

    res = client.get(f"{base}/parts/{mine.id}/scan-result")
    assert res.status_code == 200
    data = res.get_json()["data"]
    assert data["part"]["part_no"] == mine.part_no
    assert {"stock", "buckets", "primary_status", "statuses", "locations", "erp_receiving",
            "open_issues", "open_returns", "open_rgps", "actions", "primary_action", "label",
            "timeline"} <= set(data)
    assert "open_receipts" not in data
    assert client.get(f"{base}/parts/{theirs.id}/scan-result").status_code == 403
    assert client.get(f"{base}/parts/99999999/scan-result").status_code == 404

    assert client.get(f"{base}/parts/{mine.id}/timeline?limit=5").status_code == 200
    assert client.get(f"{base}/parts/{theirs.id}/timeline").status_code == 403
    assert client.get(f"{base}/parts/99999999/timeline").status_code == 404

    assert client.get(f"{base}/queues?store_code=MAINTENANCE").status_code == 200
    assert client.get(f"{base}/queues?store_code=CHILD_PART").status_code == 403
    assert client.get(f"{base}/queues").status_code == 400
