"""Short & Rejection (/api/v1/short-rejection, ShortRejectionService) — the
store's request of 17 Oct 2026: which supplier sent short or had a rejection,
since how many days, and against which lot.

The session DB is shared, so every case reads a plant day of its own far in the
future (`_day`, passed as `today`) with GRN lines dated around it, and removes
its rows afterwards; the route cases look only at their own lines.
"""
import io
import uuid
from datetime import date, timedelta

import pytest
from openpyxl import load_workbook

from app.extensions import db
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.user import User, UserStoreAccess
from app.services import short_rejection_service as sr
from app.services.short_rejection_service import AGE_BANDS, ShortRejectionService, age_band
from app.utils.exceptions import BadRequestError, NotFoundError

STORE = "MAINTENANCE"
_seq = {"n": 0, "week": 0}


def _next():
    _seq["n"] += 1
    return _seq["n"]


def _day():
    """A plant day no other case uses, years after any real GRN."""
    _seq["week"] += 1
    return date(2033, 1, 3) + timedelta(weeks=26 * _seq["week"])


@pytest.fixture()
def make():
    """make.part(tag, rate=, store=) and make.grn(part_no, grn_date, ...): real
    parts and ERP GRN mirror rows, removed after the case."""
    parts, rows = [], []

    class Make:
        @staticmethod
        def part(tag="P", rate=100.0, store=STORE, active=True):
            p = Part(part_no=f"SR-{_next()}-{tag}-{uuid.uuid4().hex[:4]}".upper(), part_name=f"Short {tag}",
                     uom="NOS", part_type="OTHER", store_code=store, unit_price=rate, is_active=active)
            db.session.add(p)
            db.session.commit()
            parts.append(p.id)
            return p

        @staticmethod
        def grn(item_cd, grn_date, challan=10, received=10, accepted=None, rejected=None, supplier=("VS-1", "Sharma Steels"),
                grn_no=None, gate=None, desc="ERP text"):
            r = ReceivingRegister(
                store_code="CHILD_PART", grn_no=grn_no or f"GRN-SR-{_next()}", grn_date=grn_date,
                ven_cd=supplier[0], ven_name=supplier[1], gate_entry_no=gate[0] if gate else None,
                gate_entry_dt=gate[1] if gate else None, challan_no="CH-1", challan_dt=None, po_no=None,
                item_cd=item_cd, item_desc=desc, challan_qty=challan, receipt_qty=received,
                accept_qty=accepted, reject_qty=rejected)
            db.session.add(r)
            db.session.commit()
            rows.append(r.id)
            return r

    try:
        yield Make
    finally:
        db.session.rollback()
        if rows:
            ReceivingRegister.query.filter(ReceivingRegister.id.in_(rows)).delete(synchronize_session=False)
        if parts:
            Part.query.filter(Part.id.in_(parts)).delete(synchronize_session=False)
        db.session.commit()


def _report(today, **kw):
    return ShortRejectionService().report(STORE, today=today, **kw)


def _mine(lines, *parts):
    ids = {p.id for p in parts}
    return [ln for ln in lines if ln["part_id"] in ids]


# ---- the figures ----

def test_short_is_challan_minus_received_and_rejected_is_the_reject_qty(make):
    today = _day()
    a, b, c, d = make.part("A", rate=100), make.part("B", rate=40), make.part("C"), make.part("D")
    make.grn(a.part_no, today - timedelta(days=3), challan=10, received=7, accepted=7)        # 3 short
    make.grn(b.part_no, today - timedelta(days=4), challan=5, received=5, accepted=3, rejected=2)  # 2 rejected
    make.grn(c.part_no, today - timedelta(days=5), challan=8, received=6.5, accepted=5.25, rejected=1.25)  # both
    make.grn(d.part_no, today - timedelta(days=6), challan=4, received=6, accepted=6)         # more than the challan
    make.grn(d.part_no, today - timedelta(days=6), challan=4, received=4, accepted=4, rejected=0)  # nothing wrong

    out = _report(today)
    by_part = {ln["part_id"]: ln for ln in out["lines"]}
    assert set(by_part) == {a.id, b.id, c.id}           # an excess receipt is not short; a clean line is not listed
    la, lb, lc = by_part[a.id], by_part[b.id], by_part[c.id]
    assert (la["short_qty"], la["rejected_qty"], la["kind"]) == (3.0, 0.0, "short")
    assert (la["short_value"], la["rejected_value"], la["rate"]) == (300.0, None, 100.0)
    assert (lb["short_qty"], lb["rejected_qty"], lb["kind"]) == (0.0, 2.0, "rejected")
    assert (lb["short_value"], lb["rejected_value"]) == (None, 80.0)
    assert (lc["short_qty"], lc["rejected_qty"], lc["kind"]) == (1.5, 1.25, "both")
    assert (lc["short_value"], lc["rejected_value"]) == (150.0, 125.0)
    assert (lc["challan_qty"], lc["received_qty"], lc["accepted_qty"]) == (8.0, 6.5, 5.25)
    assert lc["description"] == "ERP text" and lc["supplier_code"] == "VS-1" and lc["supplier_name"] == "Sharma Steels"
    assert la["days_pending"] == 3 and la["age_band"] == "0-7"

    t = out["totals"]
    assert (t["lines"], t["short_lines"], t["rejected_lines"], t["suppliers"]) == (3, 2, 2, 1)
    assert (t["short_qty"], t["short_value"], t["rejected_qty"], t["rejected_value"]) == (4.5, 450.0, 3.25, 205.0)


def test_a_line_belongs_to_the_store_through_its_part_no_trimmed_and_case_blind(make):
    today = _day()
    spare = make.part("SP")
    child = make.part("CH", store="CHILD_PART")
    make.grn(f"  {spare.part_no.lower()} ", today - timedelta(days=1), rejected=1, accepted=9)
    make.grn(child.part_no, today - timedelta(days=1), rejected=1, accepted=9)
    make.grn("NOT-A-PART-SR", today - timedelta(days=1), rejected=1, accepted=9)

    out = _report(today)
    spare_lines = out["lines"]
    assert [ln["part_id"] for ln in spare_lines] == [spare.id]
    assert spare_lines[0]["part_no"] == spare.part_no
    child_lines = ShortRejectionService().report("CHILD_PART", today=today)["lines"]
    assert [ln["part_id"] for ln in child_lines] == [child.id]
    # The line no store has a part for is not lost without a word: counted and named.
    assert out["unmatched"] == {"lines": 1, "short_lines": 0, "rejected_lines": 1, "item_count": 1,
                                "items": [{"item_cd": "NOT-A-PART-SR", "item_desc": "ERP text", "lines": 1}]}


def test_lines_of_items_in_no_part_master_are_counted_and_named_in_the_files(make):
    today = _day()
    p = make.part("UM")
    make.grn(p.part_no, today - timedelta(days=1), rejected=1, accepted=9)
    make.grn("CNEI1427-SR", today - timedelta(days=2), challan=80, received=0, accepted=0, desc="Schneider NO Element")
    make.grn("cnei1427-sr ", today - timedelta(days=3), challan=5, received=5, accepted=4, rejected=1)
    make.grn("CNMM6021-SR", today - timedelta(days=4), challan=6, received=5, accepted=5)
    make.grn("CLEAN-SR", today - timedelta(days=4), challan=6, received=6, accepted=6, rejected=0)   # nothing wrong
    out = _report(today)
    um = out["unmatched"]
    assert (um["lines"], um["short_lines"], um["rejected_lines"], um["item_count"]) == (3, 2, 1, 2)
    assert [(i["item_cd"], i["lines"]) for i in um["items"]] == [("CNEI1427-SR", 2), ("CNMM6021-SR", 1)]
    assert [ln["part_id"] for ln in out["lines"]] == [p.id]                     # never listed as a store's line
    notes = sr.file_notes(out)
    assert any(n.startswith("3 short or rejected ERP GRN lines are for item codes that are no store's Part No")
               and "CNEI1427-SR, CNMM6021-SR." in n for n in notes)
    # A supplier or a part filter narrows the list to lines with a part: no count.
    assert _report(today, supplier="VS-1")["unmatched"] is None
    assert _report(today, part_id=p.id)["unmatched"] is None
    # More codes than are named: the rest are counted.
    for i in range(sr.UNMATCHED_ITEMS + 2):
        make.grn(f"ZZ-SR-{i:02d}", today - timedelta(days=5), rejected=1, accepted=9)
    many = _report(today)
    assert many["unmatched"]["item_count"] == 14 and len(many["unmatched"]["items"]) == sr.UNMATCHED_ITEMS
    assert any("and 4 more." in n for n in sr.file_notes(many))


def test_a_rejection_of_a_part_no_longer_active_still_shows(make):
    today = _day()
    old = make.part("OLD", active=False)
    make.grn(old.part_no, today - timedelta(days=2), rejected=1, accepted=0)
    assert [ln["part_id"] for ln in _report(today)["lines"]] == [old.id]


def test_the_window_is_on_the_grn_date_and_defaults_to_the_last_90_days(make):
    today = _day()
    p = make.part("W")
    for days in (0, 89, 90, 200):
        make.grn(p.part_no, today - timedelta(days=days), grn_no=f"W{days}-{_next()}", rejected=1, accepted=0)

    default = _report(today)
    assert default["window"] == {"from": (today - timedelta(days=89)).isoformat(), "to": today.isoformat(),
                                 "days": 90, "default_days": 90, "not_held": None}
    assert sorted(ln["days_pending"] for ln in default["lines"]) == [0, 89]
    # From - To are both inside the window.
    picked = _report(today, date_from=(today - timedelta(days=200)).isoformat(),
                     date_to=(today - timedelta(days=90)).isoformat())
    assert sorted(ln["days_pending"] for ln in picked["lines"]) == [90, 200]
    # A To after today is cut at today; no GRN is dated later.
    later = _report(today, date_to=(today + timedelta(days=30)).isoformat())
    assert later["window"]["to"] == today.isoformat()
    for bad in ({"date_from": today.isoformat(), "date_to": (today - timedelta(days=1)).isoformat()},
                {"date_from": "17-10-2026"}, {"date_to": "yesterday"},
                {"date_from": (today - timedelta(days=sr.MAX_DAYS)).isoformat()}):
        with pytest.raises(BadRequestError):
            _report(today, **bad)
    assert len(_report(today, date_from=(today - timedelta(days=sr.MAX_DAYS - 1)).isoformat())["lines"]) == 4


def test_age_bands_at_their_edges():
    assert [age_band(d) for d in (0, 7, 8, 15, 16, 30, 31, 400)] == [
        "0-7", "0-7", "8-15", "8-15", "16-30", "16-30", "30+", "30+"]
    assert [key for key, _, _ in AGE_BANDS] == ["0-7", "8-15", "16-30", "30+"]


def test_days_pending_are_days_since_the_grn_date_and_banded(make):
    today = _day()
    p = make.part("AGE")
    for days in (7, 8, 15, 16, 30, 31):
        make.grn(p.part_no, today - timedelta(days=days), grn_no=f"AGE{days}-{_next()}", rejected=1, accepted=0)
    out = _report(today)
    assert [(ln["days_pending"], ln["age_band"]) for ln in out["lines"]] == [
        (31, "30+"), (30, "16-30"), (16, "16-30"), (15, "8-15"), (8, "8-15"), (7, "0-7")]   # oldest first
    assert out["totals"]["age_bands"] == {"0-7": 1, "8-15": 2, "16-30": 2, "30+": 1}
    assert out["totals"]["oldest_days"] == 31


def test_supplier_summary_adds_up_to_the_lines_and_puts_the_worst_first(make):
    today = _day()
    p, q, r = make.part("S1", rate=10), make.part("S2", rate=1000), make.part("S3", rate=50)
    old = ("VA-1", "Alpha Tools")
    dear = ("VB-2", "Beta Bearings")
    make.grn(p.part_no, today - timedelta(days=40), challan=10, received=8, supplier=old)       # 2 short, ₹ 20
    make.grn(p.part_no, today - timedelta(days=5), rejected=3, accepted=7, supplier=old)       # 3 rejected, ₹ 30
    make.grn(q.part_no, today - timedelta(days=10), rejected=2, accepted=8, supplier=dear)     # ₹ 2,000
    make.grn(r.part_no, today - timedelta(days=10), challan=5, received=4, supplier=dear)      # 1 short, ₹ 50

    out = _report(today)
    summary = out["summary"]
    assert [s["supplier_code"] for s in summary] == ["VA-1", "VB-2"]            # the longest pending first
    alpha, beta = summary
    assert (alpha["short_lines"], alpha["short_qty"], alpha["short_value"]) == (1, 2.0, 20.0)
    assert (alpha["rejected_lines"], alpha["rejected_qty"], alpha["rejected_value"]) == (1, 3.0, 30.0)
    assert (alpha["oldest_days"], alpha["latest_grn_date"], alpha["lines"]) == (
        40, (today - timedelta(days=5)).isoformat(), 2)
    assert (beta["supplier_name"], beta["short_value"], beta["rejected_value"], beta["oldest_days"]) == (
        "Beta Bearings", 50.0, 2000.0, 10)
    t = out["totals"]
    for key in ("lines", "short_lines", "short_qty", "short_value", "rejected_lines", "rejected_qty",
                "rejected_value", "unrated_lines"):
        assert t[key] == round(sum(s[key] for s in summary), 2), key
    lines = out["lines"]
    assert t["short_qty"] == sum(ln["short_qty"] for ln in lines)
    assert t["rejected_value"] == sum(ln["rejected_value"] or 0 for ln in lines)
    assert t["suppliers"] == 2 and t["oldest_days"] == 40
    # Same days pending: the dearer line first.
    assert [ln["part_id"] for ln in lines] == [p.id, q.id, r.id, p.id]


def test_a_part_with_no_rate_has_no_value_blank_never_zero(make):
    today = _day()
    none, zero, rated = make.part("N", rate=None), make.part("Z", rate=0), make.part("R", rate=10)
    only_unrated = ("VU-1", "Unrated Co")
    make.grn(none.part_no, today - timedelta(days=1), rejected=2, accepted=0, supplier=only_unrated)
    make.grn(zero.part_no, today - timedelta(days=1), challan=5, received=3, supplier=only_unrated)
    make.grn(rated.part_no, today - timedelta(days=1), rejected=1, accepted=0, supplier=("VR-1", "Rated Co"))
    make.grn(none.part_no, today - timedelta(days=1), rejected=1, accepted=0, supplier=("VR-1", "Rated Co"))

    out = _report(today)
    unrated = [ln for ln in out["lines"] if ln["part_id"] in (none.id, zero.id)]
    assert len(unrated) == 3
    assert all(ln["rate"] is None and ln["short_value"] is None and ln["rejected_value"] is None for ln in unrated)
    by = {s["supplier_code"]: s for s in out["summary"]}
    # Every line unrated: the value is not known — None, not 0.
    assert (by["VU-1"]["rejected_value"], by["VU-1"]["short_value"], by["VU-1"]["unrated_lines"]) == (None, None, 2)
    # Some rated: the rated ones' money, and the others counted.
    assert (by["VR-1"]["rejected_value"], by["VR-1"]["unrated_lines"]) == (10.0, 1)
    # Nothing short at all: 0, which is known.
    assert by["VR-1"]["short_value"] == 0.0
    assert out["totals"]["unrated_lines"] == 3 and out["totals"]["rejected_value"] == 10.0
    # The files leave the cell blank and say how many lines have no rate.
    book = load_workbook(io.BytesIO(sr.workbook(out)))
    head = [c.value for c in book["Lines"][1]]
    values = [row[head.index("Rejected Value")] for row in book["Lines"].iter_rows(min_row=2, values_only=True)
              if row[head.index("Part No")] == none.part_no]
    assert values == [None, None]
    notes = [row[0] for row in book["Lines"].iter_rows(values_only=True) if row[0]]
    assert any("3 lines have no rate" in str(n) for n in notes)


def test_filters_supplier_exactly_or_by_text_and_part(make):
    today = _day()
    p, q = make.part("F1"), make.part("F2")
    make.grn(p.part_no, today - timedelta(days=2), rejected=1, accepted=0, supplier=("VK-0016", "Keyence India"))
    make.grn(q.part_no, today - timedelta(days=2), rejected=1, accepted=0, supplier=("VK-00161", "Kirloskar"))

    codes = lambda out: sorted({ln["supplier_code"] for ln in out["lines"]})  # noqa: E731
    assert codes(_report(today, supplier="vk-0016")) == ["VK-0016"]            # a code: that supplier only
    assert codes(_report(today, supplier="VK-001")) == ["VK-0016", "VK-00161"]   # text: in a code
    assert codes(_report(today, supplier="kirlo")) == ["VK-00161"]             # text: in a name
    assert _report(today, supplier="nobody")["lines"] == []
    by_part = _report(today, part_id=q.id)
    assert [ln["part_id"] for ln in by_part["lines"]] == [q.id]
    assert by_part["filters"] == {"supplier": None, "part_id": q.id, "part_no": q.part_no, "part_name": q.part_name}
    assert by_part["title"].startswith(f"Short & Rejection {q.part_no} ")
    child = make.part("FC", store="CHILD_PART")
    with pytest.raises(NotFoundError):
        _report(today, part_id=child.id)
    with pytest.raises(BadRequestError):
        _report(today, part_id="abc")


def test_lot_erp_age_and_what_erp_does_not_give(make):
    today = _day()
    p, q = make.part("L1"), make.part("L2")
    make.grn(p.part_no, today - timedelta(days=3), rejected=1, accepted=0, gate=("GE-77", today - timedelta(days=4)))
    make.grn(q.part_no, today - timedelta(days=3), rejected=1, accepted=0)
    out = _report(today)
    lots = {ln["part_id"]: ln["lot"] for ln in out["lines"]}
    assert lots == {p.id: f"GE-77 dt {(today - timedelta(days=4)):%d.%m.%Y}", q.id: None}
    # One line has a lot, so the lot is not "not given"; no line has a PO no. or a challan date.
    assert out["not_given"] == ["Challan date", "PO no."]
    as_of = out["data_as_of"]
    assert as_of["synced_at"] and as_of["rows"] >= 2
    # The mirror was written today and this case's plant day is years later: not current.
    assert as_of["stale"] is True and as_of["age_days"] > sr.STALE_AFTER_DAYS
    assert set(out["basis"]) >= {"days", "short", "value"}
    assert "until ERP tells the app the item is closed" in out["basis"]["days"]


def test_the_oldest_grn_held_is_given_and_a_window_before_it_is_flagged(make, monkeypatch):
    """The ERP sync keeps only the last ERP_SYNC_SINCE_DAYS of GRNs: an open
    line on an older GRN leaves the data though nothing closed it, so a window
    that reaches before the oldest GRN held must say so, not show "nothing"."""
    today = _day()
    p = make.part("HELD")
    make.grn(p.part_no, today - timedelta(days=89), rejected=1, accepted=0)   # on the window's first day
    make.grn(p.part_no, today - timedelta(days=10), rejected=1, accepted=0)
    out = _report(today)
    as_of = out["data_as_of"]
    # The register is shared by the cases: its oldest GRN is never later than this case's.
    assert as_of["held_from"] <= (today - timedelta(days=89)).isoformat()
    assert as_of["keeps_days"] == (sr.current_app.config.get("ERP_SYNC_SINCE_DAYS") or None)
    assert out["window"]["not_held"] is None                                   # the window is all held

    # The source as it stands on the live register: held from 31 May 2026, kept 120 days.
    held = today - timedelta(days=60)
    real = sr.erp_grn_lines

    def source(first, last):
        rows, as_of = real(first, last)
        return rows, {**as_of, "oldest_grn_date": held, "keeps_days": 120}

    monkeypatch.setattr(sr, "erp_grn_lines", source)
    out = _report(today)                                                        # the last 90 days
    assert out["data_as_of"]["held_from"] == held.isoformat() and out["data_as_of"]["keeps_days"] == 120
    assert out["window"]["not_held"] == {"from": (today - timedelta(days=89)).isoformat(),
                                         "to": (held - timedelta(days=1)).isoformat()}
    notes = sr.file_notes(out)
    assert f"ERP GRN lines are held from {held:%d.%m.%Y} (the ERP sync keeps the last 120 days): " \
           "an open short or rejection on an older GRN is not listed." in notes
    assert f"No GRN line is held for {today - timedelta(days=89):%d.%m.%Y} to {held - timedelta(days=1):%d.%m.%Y}" \
           " - nothing can be listed for those dates." in notes
    # A window wholly before it: all of it is not held.
    early = _report(today, date_from=(today - timedelta(days=200)).isoformat(),
                    date_to=(today - timedelta(days=100)).isoformat())
    assert early["window"]["not_held"] == {"from": (today - timedelta(days=200)).isoformat(),
                                           "to": (today - timedelta(days=100)).isoformat()}
    # The workbook carries the same lines under its tables.
    book = load_workbook(io.BytesIO(sr.workbook(out)))
    written = [r[0] for r in book["Lines"].iter_rows(values_only=True) if r[0]]
    assert any(str(n).startswith("No GRN line is held for") for n in written)


def test_an_empty_window_is_an_empty_list_with_zero_totals(make):
    out = _report(_day())
    assert out["lines"] == [] and out["summary"] == [] and out["not_given"] == []
    t = out["totals"]
    assert (t["lines"], t["suppliers"], t["short_value"], t["rejected_value"], t["oldest_days"]) == (0, 0, 0.0, 0.0, None)


# ---- the files ----

def test_excel_is_one_workbook_with_a_supplier_wise_and_a_lines_sheet(make):
    today = _day()
    p = make.part("X", rate=12.5)
    make.grn(p.part_no, today - timedelta(days=20), challan=10, received=6, rejected=1, accepted=5,
             supplier=("VX-9", "=HYPERLINK(\"x\")"))
    buf, name, mime = ShortRejectionService().export(STORE, "excel", today=today)
    first = today - timedelta(days=89)
    assert name == f"Short & Rejection {first:%d.%m.%Y} to {today:%d.%m.%Y}.xlsx"
    assert mime == sr.XLSX_MIME
    book = load_workbook(io.BytesIO(buf.getvalue()))
    assert book.sheetnames == ["Supplier-wise", "Lines"]
    sup = [list(r) for r in book["Supplier-wise"].iter_rows(values_only=True)]
    assert tuple(sup[0]) == sr.SUPPLIER_COLUMNS
    assert sup[1][:8] == ["VX-9", "=HYPERLINK(\"x\")", 1, 4, 50, 1, 1, 12.5]
    assert sup[2][:3] == ["Total", "1 supplier", 1]                           # the Total row last
    assert book["Supplier-wise"].cell(row=2, column=2).data_type == "s"        # a formula-looking name stays text
    assert book["Supplier-wise"]["A3"].font.bold
    lines = [list(r) for r in book["Lines"].iter_rows(values_only=True)]
    assert tuple(lines[0]) == sr.LINE_COLUMNS
    row = dict(zip(sr.LINE_COLUMNS, lines[1]))
    assert (row["Part No"], row["Short Qty"], row["Rejected Qty"], row["Short Value"], row["Rejected Value"]) == (
        p.part_no, 4, 1, 50, 12.5)
    assert (row["Days Pending"], row["Age"], row["GRN Date"]) == (20, "16-30", f"{today - timedelta(days=20):%d.%m.%Y}")
    age = book["Lines"].cell(row=2, column=sr.LINE_COLUMNS.index("Age") + 1)
    assert age.fill.fgColor.rgb.endswith(sr.AGE_TINTS["16-30"][0])
    notes = [r[0] for r in lines if r[0] and "Days pending are counted from the GRN date" in str(r[0])]
    assert notes                                                                 # the basis travels with the file


def test_pdf_and_a_bad_format(make):
    today = _day()
    p = make.part("PDF")
    make.grn(p.part_no, today - timedelta(days=2), rejected=1, accepted=0, supplier=("VP-1", "Smith & Sons"))
    buf, name, mime = ShortRejectionService().export(STORE, "pdf", today=today)
    assert buf.getvalue().startswith(b"%PDF") and name.endswith(".pdf") and mime == "application/pdf"
    empty, _, _ = ShortRejectionService().export(STORE, "pdf", today=_day())        # nothing in the window
    assert empty.getvalue().startswith(b"%PDF")
    with pytest.raises(BadRequestError):
        ShortRejectionService().export(STORE, "csv", today=today)


# ---- the routes ----

@pytest.fixture()
def client(app):
    return app.test_client()


def _login(client, perms=None, stores=(STORE,)):
    u = User(username=f"sruser{_next()}_{uuid.uuid4().hex[:6]}", role="STORE_USER", is_active=True)
    u.set_password("pw")
    if perms:
        u.set_permissions(perms)
    db.session.add(u)
    db.session.flush()
    for code in stores:
        db.session.add(UserStoreAccess(user_id=u.id, store_code=code))
    db.session.commit()
    with client.session_transaction() as s:
        s["user_id"] = u.id
    return client


URL = "/api/v1/short-rejection"


def test_routes_need_the_receiving_right_and_the_store(client):
    c = _login(client)
    assert c.get(f"{URL}?store_code={STORE}").status_code == 403
    assert c.get(f"{URL}/export?store_code={STORE}&format=excel").status_code == 403
    c = _login(client, perms={"spare_store": {"view": True}})
    assert c.get(f"{URL}?store_code=CHILD_PART").status_code == 403
    assert c.get(f"{URL}/export?store_code=CHILD_PART&format=excel").status_code == 403
    assert c.get(URL).status_code == 400
    assert client.application.test_client().get(f"{URL}?store_code={STORE}").status_code == 401


def test_routes_read_and_export(client, make):
    today = sr.plant_today()
    p = make.part("RT", rate=10)
    make.grn(p.part_no, today - timedelta(days=9), rejected=2, accepted=1, supplier=("VR-77", "Route Rubber"))
    c = _login(client, perms={"spare_store": {"view": True}})
    body = c.get(f"{URL}?store_code={STORE}").get_json()["data"]
    assert {"summary", "lines", "totals", "data_as_of", "basis", "window", "filters", "title"} <= set(body)
    mine = _mine(body["lines"], p)
    assert [(ln["rejected_qty"], ln["rejected_value"], ln["days_pending"], ln["age_band"]) for ln in mine] == [
        (2.0, 20.0, 9, "8-15")]
    narrowed = c.get(f"{URL}?store_code={STORE}&supplier=VR-77&part_id={p.id}").get_json()["data"]
    assert [ln["part_id"] for ln in narrowed["lines"]] == [p.id] and narrowed["summary"][0]["supplier_code"] == "VR-77"
    assert c.get(f"{URL}?store_code={STORE}&from=2026-13-01").status_code == 400
    assert c.get(f"{URL}?store_code={STORE}&part_id=999999999").status_code == 404

    xl = c.get(f"{URL}/export?store_code={STORE}&format=excel&supplier=VR-77")
    assert xl.status_code == 200 and xl.mimetype == sr.XLSX_MIME
    assert "Short & Rejection VR-77 " in xl.headers["Content-Disposition"]
    assert load_workbook(io.BytesIO(xl.data)).sheetnames == ["Supplier-wise", "Lines"]
    pdf = c.get(f"{URL}/export?store_code={STORE}&format=pdf")
    assert pdf.status_code == 200 and pdf.data.startswith(b"%PDF")
    assert c.get(f"{URL}/export?store_code={STORE}&format=csv").status_code == 400
