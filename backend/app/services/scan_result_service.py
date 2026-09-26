"""The one scan result, the part's full timeline and the store's work queues
(spec 2 / 10 / 21 / 22 / 27 / 30).

The QR carries only the Part No., so a scan answers at PART level: how much of
the part sits in each bucket (available, quality pending, issued out, returned
for inspection, on hold, damaged, with a supplier, waiting for its RGP GRN), one
headline status, the open documents behind those numbers and the actions valid
for them. Nothing is stored twice: every bucket is summed from the documents
(spare_returns / spare_rgps / the ISSUE rows), from spare_stock.qty_on_hand and
— for quality pending — from ERP's own GRN register, so the screen can never
disagree with the paperwork. It never says "this unit is on machine X" — it
says which issue documents are still out, and where each one was recorded as
fitted.

Scanning is mainly for issuance (user decision 2026-09-26): ISSUE is the first
action and the guided one whenever there is stock to issue. Receiving, the GRN
and the quality clearance are done in ERP and only READ here
(ErpGrnPostingService.lines): the part's GRN lines, what quality still holds and
what was added to stock, each carrying the mirror's freshness. The app records
no receipt by hand any more. The part's barcodes (internal QR + mapped supplier
codes) and the label count its newest ERP GRN suggests ride along, so Scan Part
also covers supplier-barcode mapping and receive-and-label.

Honest by construction: a bucket no document feeds is 0, an unknown is None,
and a step the supervisor RECORDED here (the RGP GRN) is worded as recorded —
never as "ERP updated". ERP's own gate / GRN feeds appear as ERP rows,
read-only; a gate entry is never tied to a GRN (ERP's GRN rows carry no gate
entry no.).
"""
from datetime import date, datetime, timezone

from sqlalchemy.orm import joinedload

from app.extensions import db
from app.models.base import utcnow
from app.models.label_print_audit import LabelPrintAudit
from app.models.location_history import SpareLocationHistory
from app.models.part import Part
from app.models.spare_flow import (
    RETURN_OPEN, RGP_OPEN, SpareReceipt, SpareReturn, SpareRgp, SpareTransaction,
)
from app.models.spare_stock import (
    ERP_ORIGIN_RECEIPT_STATUSES, LEGACY_RETURN_REASONS, RETURN_ROW_INSPECTED, SpareStockLedger,
)
from app.models.store import Section
from app.repositories.part_repository import PartRepository
from app.repositories.spare_stock_repository import SpareStockRepository
from app.services.barcode_service import BarcodeService
from app.services.erp_grn_posting_service import STATUS as ERP_GRN_STATUS, ErpGrnPostingService
from app.services.spare_flow_service import SpareFlowService
from app.services.spare_stock_service import SpareStockService
from app.utils.exceptions import NotFoundError

# Headline / chip wording — the same words as frontend lib/scanStatus.js
# SCAN_STATUS, so an API consumer and the screen say the same thing.
STATUS_LABELS = {
    "STOCK_AVAILABLE": "Stock Available",
    "QUALITY_PENDING": "Quality Pending",
    "ISSUED": "Issued",
    "RETURN_INSPECTION": "Returned – Inspection",
    "RETURN_HOLD": "Return Hold",
    "WITH_SUPPLIER": "With Supplier – Rework",
    "RGP_GRN_PENDING": "Supplier Returned – RGP GRN Pending",
    "DAMAGED": "Damaged",
    "OUT_OF_STOCK": "Out of Stock",
    "NOT_COUNTED": "Not Counted",
}

# scan_result.buckets key -> the status key of its chip (scanStatus.js
# BUCKETS[].status), in display order.
BUCKET_STATUS = (
    ("available", "STOCK_AVAILABLE"),
    ("quality_pending", "QUALITY_PENDING"),
    ("issued_out", "ISSUED"),
    ("return_pending", "RETURN_INSPECTION"),
    ("return_hold", "RETURN_HOLD"),
    ("damaged", "DAMAGED"),
    ("with_supplier", "WITH_SUPPLIER"),
    ("rgp_grn_pending", "RGP_GRN_PENDING"),
)
BUCKET_KEYS = tuple(k for k, _ in BUCKET_STATUS)

# The step the operator is guided to first. Scanning is mainly for issuance
# (user decision 2026-09-26), so ISSUE wins whenever there is stock to issue;
# otherwise whatever finishes a flow already under way, material coming back
# into stock before material going out.
PRIMARY_ACTIONS = ("ISSUE", "RGP_GRN", "RGP_RETURN", "INSPECT", "RETURN")
INACTIVE_REASON = "Part is inactive"

SCAN_TIMELINE_ROWS = 30
OPEN_ISSUES_MAX = 50

# The part's ERP GRN lines the scan shows: the ones still in play, plus the
# newest few already added to store stock (the full list is on Receiving & GRN).
ERP_LINE_OPEN_STATES = ("QUALITY_PENDING", "WILL_POST", "CHECK")
ERP_POSTED_SHOWN = 5
# A queue holds what someone has to act on or look at: quality ERP has not
# cleared yet, and lines whose ERP figures no longer match what was added.
ERP_QUEUE_STATES = ("QUALITY_PENDING", "CHECK")

# Every key an open-issue row carries in the payload (contract shape). The
# taker's mobile is for the Scan Part card; the timeline never prints it.
ISSUE_FIELDS = (
    "id", "issued_at", "issued_qty", "returned_qty", "outstanding_qty", "actual_qty",
    "department", "issued_to", "issued_to_mobile", "issued_to_code", "line_name", "line_no",
    "machine", "die_no", "status", "confirmed_at", "confirmed_by", "reference", "issued_by",
)

TIMELINE_KEYS = (
    "at", "kind", "title", "detail", "qty", "qty_delta", "prev_status", "new_status",
    "department", "issued_to", "line_name", "line_no", "machine", "die_no", "supplier",
    "rgp_no", "grn_no", "return_no", "reference", "user", "source",
)

INSPECTION_TITLES = {
    "GOOD": "Return inspected – Good / Reusable",
    "INSPECTION_REQUIRED": "Return inspected – Inspection Required",
    "DAMAGED": "Return inspected – Damaged",
    "SCRAP": "Return inspected – Scrap",
}
# Where an inspected quantity went (journal to_bucket), said plainly.
BUCKET_WORDS = {
    "AVAILABLE": "back to store stock",
    "RETURN_HOLD": "kept on return hold",
    "DAMAGED": "moved to damaged stock",
    "SCRAPPED": "scrapped / disposal",
    "WITH_SUPPLIER": "with the supplier",
    "REJECTED": "rejected",
}
PRINT_SOURCE_LABELS = {
    "SUPPLIER_BARCODE": "Supplier Barcode", "ERP_SEARCH": "ERP Search",
    "MANUAL_ENTRY": "Manual Entry", "QR_SCAN": "QR Scan", "REPRINT": "Reprint",
    "PART_MASTER": "Part Master", "STORE_STOCK": "Store Stock",
}


# ---- small helpers ------------------------------------------------------------

def _naive(v):
    """UTC without tzinfo — how SQLite hands a stored stamp back — so rows read
    back from the DB and rows still in the session sort together. A plain date
    (an ERP gate / GRN date) becomes midnight of that day."""
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.astimezone(timezone.utc).replace(tzinfo=None) if v.tzinfo else v
    if isinstance(v, date):
        return datetime(v.year, v.month, v.day)
    return None


def _iso(v):
    v = _naive(v) if isinstance(v, datetime) else v
    return v.isoformat() if v is not None else None


def _f(v):
    return float(v) if v is not None else None


def _q(v):
    return round(float(v or 0), 2)


def _g(v):
    """A quantity in a sentence: 2 not 2.0."""
    return f"{float(v):g}"


def _join(*parts):
    text = " · ".join(str(p) for p in parts if p)
    return text or None


def _now():
    return _naive(utcnow())


def _age_days(created_at, now):
    at = _naive(created_at)
    return max(0, (now - at).days) if at else None


def _grn_age_days(grn_date, today):
    """Whole days since an ERP GRN date (a plant date, ISO text in a line)."""
    try:
        d = date.fromisoformat(grn_date[:10]) if grn_date else None
    except ValueError:
        return None
    return max(0, (today - d).days) if d else None


def _quality_pending(erp_lines):
    """The part's ERP GRN lines whose quality ERP has not cleared yet."""
    return [ln for ln in erp_lines if ln["state"] == "QUALITY_PENDING"]


def _reason(r):
    """Spec 13 wording for a return reason; older wording stays as typed in
    history but reads under its current name."""
    return LEGACY_RETURN_REASONS.get(r, r) if r else None


def _still(waiting, qty, what):
    """ "Waiting for <what>" on a history row whose quantity has not moved on
    yet — "1 of 3 still waiting for <what>" once part of it has. None when
    nothing waits any more (see ScanResultService._still_waiting)."""
    if not waiting:
        return None
    if qty is not None and waiting < qty:
        return f"{_g(waiting)} of {_g(qty)} still waiting for {what}"
    return f"Waiting for {what}"


def _handed_to(name, code=None):
    """ "Handed to Ravi Kumar (E1001)" — who took an issue, with the employee
    code when the Employee master gave one. Never the mobile number: the
    timeline is read far more widely than the counter screen."""
    if not name:
        return None
    return f"Handed to {name} ({code})" if code else f"Handed to {name}"


def _where(line_name=None, line_no=None, machine=None, die_no=None):
    """ "Line 03 / Press 07 / Die-12" — where an issue was recorded as fitted."""
    if line_name and line_no:
        line = f"{line_name} {line_no}"
    elif line_no:
        line = line_no if str(line_no).lower().startswith("line") else f"Line {line_no}"
    else:
        line = line_name
    return " / ".join(str(x) for x in (line, machine, die_no) if x) or None


def _row(**fields):
    row = dict.fromkeys(TIMELINE_KEYS)
    row.update(fields)
    return row


def primary_status(buckets, counted):
    """The one headline for a part (spec 22): the first state that is true, in
    the order the store acts on. Available stock wins — a part with something
    on the rack is "Stock Available" even while other units are out — then what
    the store holds but may not issue, then what is outside the store. Held
    returns (inspection required) read as "Returned – Inspection": they still
    wait on the store's decision. With every bucket empty, a part that has a
    stock row is out of stock; one that never had a row was never counted."""
    b = buckets
    checks = (
        ("STOCK_AVAILABLE", b["available"] > 0),
        ("QUALITY_PENDING", b["quality_pending"] > 0),
        ("RETURN_INSPECTION", b["return_pending"] + b["return_hold"] > 0),
        ("ISSUED", b["issued_out"] > 0),
        ("WITH_SUPPLIER", b["with_supplier"] > 0),
        ("RGP_GRN_PENDING", b["rgp_grn_pending"] > 0),
        ("DAMAGED", b["damaged"] > 0),
        ("OUT_OF_STOCK", bool(counted)),
        ("NOT_COUNTED", True),
    )
    key = next(k for k, ok in checks if ok)
    return {"key": key, "label": STATUS_LABELS[key]}


class ScanResultService:
    def __init__(self):
        self.stock = SpareStockService()
        self.flow = SpareFlowService()
        self.erp_grn = ErpGrnPostingService()
        self.barcode = BarcodeService()
        self.parts = PartRepository()
        self.stock_repo = SpareStockRepository()

    # ------------------------------------------------------------ open documents

    def _part(self, part_id):
        part = self.parts.get_by_id(part_id)
        if not part:
            raise NotFoundError(f"Part {part_id} not found")
        return part

    def _erp_lines(self, part):
        """This part's ERP GRN lines, each with what the app does with it
        (ErpGrnPostingService owns those rules). Read once per request."""
        return self.erp_grn.lines(part.store_code, part_id=part.id)

    @staticmethod
    def _open_returns(part_id):
        return (SpareReturn.query
                .filter(SpareReturn.part_id == part_id, SpareReturn.status.in_(RETURN_OPEN))
                .order_by(SpareReturn.created_at.desc(), SpareReturn.id.desc()).all())

    @staticmethod
    def _open_rgps(part_id):
        return (SpareRgp.query
                .filter(SpareRgp.part_id == part_id, SpareRgp.status.in_(RGP_OPEN))
                .order_by(SpareRgp.created_at.desc(), SpareRgp.id.desc()).all())

    def _open_issues(self, part_id):
        """Issues still out on the floor (issued − returned > 0), newest first.

        The list comes from SpareStockService.returnable_issues_for_part, the
        one place the "returned against an issue" rule lives, so the Issued
        bucket, the Return form and this list can never disagree. Trimmed to
        the payload's keys (a key the helper does not carry reads None)."""
        out = []
        for r in self.stock.returnable_issues_for_part(part_id):
            item = {k: r.get(k) for k in ISSUE_FIELDS}
            item["returned_qty"] = _q(item["returned_qty"])
            item["outstanding_qty"] = _q(item["outstanding_qty"])
            out.append(item)
        return out

    # ------------------------------------------------------------------ buckets

    @staticmethod
    def _sum_buckets(stock_row, erp_lines, issues, returns, rgps):
        return {
            "available": _q(stock_row.qty_on_hand) if stock_row is not None else 0.0,
            # What ERP received against a GRN and quality has not cleared yet.
            "quality_pending": _q(sum(ln["receipt_qty"] or 0 for ln in _quality_pending(erp_lines))),
            # Installed parts count: they are on the line, and may still come back.
            "issued_out": _q(sum(max(0.0, float(i.get("outstanding_qty") or 0)) for i in issues)),
            "return_pending": _q(sum(r.q("qty_pending") for r in returns)),
            "return_hold": _q(sum(r.q("qty_hold") for r in returns)),
            "damaged": _q(sum(r.q("qty_damaged") for r in returns)),
            "with_supplier": _q(sum(max(0.0, g.qty_with_supplier) for g in rgps)),
            "rgp_grn_pending": _q(sum(max(0.0, g.qty_grn_pending) for g in rgps)),
        }

    def buckets(self, part_id):
        """Where every unit of this part is, per bucket — summed from the open
        documents, ERP's GRN lines and spare_stock, never stored (see the module
        docstring)."""
        part = self._part(part_id)
        return self._sum_buckets(
            self.stock_repo.get_by_part(part.id), self._erp_lines(part),
            self._open_issues(part.id), self._open_returns(part.id), self._open_rgps(part.id),
        )

    @staticmethod
    def _statuses(buckets):
        return [{"key": st, "label": STATUS_LABELS[st], "qty": buckets[k]}
                for k, st in BUCKET_STATUS if buckets[k] > 0]

    @staticmethod
    def _locations(part, buckets, erp_lines, issues, returns, rgps):
        """Where the quantity physically is, one entry per document (spec 22
        CURRENT LOCATION). `kind` is the document family: STORE (available on
        the rack), QUALITY (ERP GRN lines quality has not cleared), LINE
        (issues), RETURN_HOLD (returns held in the store), SUPPLIER (RGPs —
        with the supplier, or back and waiting for the RGP GRN; the label says
        which)."""
        out = []
        if buckets["available"] > 0:
            out.append({"kind": "STORE",
                        "label": f"Store – {part.location}" if part.location else "Store – location not set",
                        "qty": buckets["available"]})
        for ln in _quality_pending(erp_lines):
            out.append({"kind": "QUALITY", "label": f"GRN {ln['grn_no']} — quality pending in ERP",
                        "qty": _q(ln["receipt_qty"]), "supplier": ln["ven_name"] or ln["ven_cd"],
                        "ref_type": "erp_grn", "ref_id": ln["grn_no"]})
        for i in issues[:OPEN_ISSUES_MAX]:
            where = _where(i.get("line_name"), i.get("line_no"), i.get("machine"), i.get("die_no"))
            out.append({
                "kind": "LINE",
                "label": "Issued – " + (_join(i.get("department"), where) or "department not recorded"),
                "qty": i["outstanding_qty"], "department": i.get("department"),
                "issued_to": i.get("issued_to"), "line_name": i.get("line_name"),
                "line_no": i.get("line_no"), "machine": i.get("machine"), "die_no": i.get("die_no"),
                "ref_type": "issue", "ref_id": i.get("id"),
            })
        for r in returns:
            # One entry per non-empty bucket: a return can be part pending, part
            # held, part damaged, and each is a different place on the floor.
            for col, what in (("qty_pending", "awaiting inspection"),
                              ("qty_hold", "return hold, inspection required"),
                              ("qty_damaged", "damaged")):
                if r.q(col) > 0:
                    out.append({"kind": "RETURN_HOLD", "label": f"Store – {what} ({r.return_no})",
                                "qty": _q(r.q(col)), "department": r.department,
                                "issued_to": r.issued_to, "ref_type": "return", "ref_id": r.id})
        for g in rgps:
            if g.qty_with_supplier > 0:
                out.append({"kind": "SUPPLIER", "label": f"With {g.ven_name} – rework ({g.rgp_no})",
                            "qty": _q(g.qty_with_supplier), "supplier": g.ven_name,
                            "ref_type": "rgp", "ref_id": g.id})
            if g.qty_grn_pending > 0:
                out.append({"kind": "SUPPLIER",
                            "label": f"Back from {g.ven_name} – RGP GRN pending ({g.rgp_no})",
                            "qty": _q(g.qty_grn_pending), "supplier": g.ven_name,
                            "ref_type": "rgp", "ref_id": g.id})
        return out

    # ----------------------------------------------------------- document dicts

    @staticmethod
    def _erp_receiving(erp_lines, freshness):
        """The part's ERP GRN lines still in play (quality pending, to be added,
        to check) plus the newest few already added to store stock — the same
        line shape ErpGrnPostingService.lines gives, with the mirror's
        freshness so a stale ERP read is never taken for today's."""
        lines, posted = [], 0
        for ln in erp_lines:                      # newest GRN first
            if ln["state"] == "POSTED":
                posted += 1
                if posted > ERP_POSTED_SHOWN:
                    continue
            elif ln["state"] not in ERP_LINE_OPEN_STATES:
                continue
            lines.append(ln)
        return {"lines": lines, "erp": freshness}

    @staticmethod
    def _return_dict(r):
        issue = r.issue
        return {
            "id": r.id, "return_no": r.return_no, "issue_id": r.issue_id, "qty": _q(r.qty),
            "qty_pending": r.q("qty_pending"), "qty_hold": r.q("qty_hold"),
            "qty_damaged": r.q("qty_damaged"), "qty_good": r.q("qty_good"),
            "qty_scrap": r.q("qty_scrap"), "qty_rgp": r.q("qty_rgp"),
            "reason": r.reason, "returned_by": r.returned_by, "department": r.department,
            "issued_to": r.issued_to, "line_name": r.line_name, "line_no": r.line_no,
            "machine": r.machine, "die_no": r.die_no,
            "issue_date": _iso(issue.created_at) if issue is not None else None,
            "issued_qty": abs(float(issue.qty_delta)) if issue is not None else None,
            "status": r.status, "created_at": _iso(r.created_at),
        }

    @staticmethod
    def _rgp_dict(g, today):
        # "Today" is the plant's calendar day (the server clock is plant time,
        # see SpareStockService._today_shift_start), the same clock the
        # expected-return date was typed in.
        with_supplier = g.qty_with_supplier
        return {
            "id": g.id, "rgp_no": g.rgp_no, "erp_challan_no": g.erp_challan_no,
            "ven_name": g.ven_name, "ven_cd": g.ven_cd,
            "qty_out": _q(g.qty_out), "qty_returned": _q(g.qty_returned), "qty_grn": _q(g.qty_grn),
            "qty_with_supplier": _q(with_supplier), "qty_grn_pending": _q(g.qty_grn_pending),
            "rework_reason": g.rework_reason, "rgp_date": _iso(g.rgp_date),
            "expected_return_date": _iso(g.expected_return_date),
            "overdue": bool(with_supplier > 0 and g.expected_return_date is not None
                            and g.expected_return_date < today),
            "status": g.status, "source_return_id": g.source_return_id,
            "return_no": g.source_return.return_no if g.source_return is not None else None,
            "created_at": _iso(g.created_at),
        }

    @staticmethod
    def _with_part(d, part):
        d.update({
            "part_id": part.id if part else None,
            "part_no": part.part_no if part else None,
            "part_name": part.part_name if part else None,
            "location": part.location if part else None,
        })
        return d

    # ------------------------------------------------------------------- label

    @staticmethod
    def _prints(part_id):
        return (LabelPrintAudit.query.filter_by(part_id=part_id)
                .order_by(LabelPrintAudit.created_at.desc(), LabelPrintAudit.id.desc()).all())

    @staticmethod
    def _label_summary(part, prints):
        """How the physical label stands. location_changed_since_print tells the
        operator the rack text on the label is stale — judged only when the last
        print recorded the location it printed (older prints did not)."""
        if not prints:
            return {"printed_count": 0, "copies_total": 0, "last_printed_at": None,
                    "last_printed_by": None, "last_location_printed": None,
                    "location_changed_since_print": False}
        last = prints[0]
        printed_loc = last.location_printed
        return {
            "printed_count": len(prints),
            "copies_total": sum(int(p.copies or 0) for p in prints),
            "last_printed_at": _iso(last.created_at),
            "last_printed_by": last.printed_by,
            "last_location_printed": printed_loc,
            "location_changed_since_print": bool(
                printed_loc is not None
                and printed_loc.strip() != (part.location or "").strip()),
        }

    def _barcodes(self, part):
        """Every code that reaches this part — the internal QR first, then the
        supplier barcodes mapped to it (BarcodeService.list_part_barcodes
        shape), so Scan Part shows and manages them without a separate screen.

        The internal row is allocated on the first label print. Before that the
        part's internal code is still its Part No. (the QR payload, and what a
        scan resolves), so it is listed as such with id / created_at None —
        "no label printed yet", never a made-up allocation."""
        rows = self.barcode.list_part_barcodes(part.id)
        # The repository puts the primary first; a supplier code must never
        # lead even if one was flagged primary. Stable, so the rest keep order.
        rows.sort(key=lambda b: b["source"] != "INTERNAL")
        if not any(b["source"] == "INTERNAL" for b in rows):
            rows.insert(0, {
                "id": None, "code": part.part_no,
                "symbology": self.barcode.label_config()["symbology"], "source": "INTERNAL",
                "supplier_id": None, "supplier_name": None, "is_primary": True,
                "is_active": True, "created_by": None, "created_at": None,
            })
        return rows

    @staticmethod
    def _label_qty_hint(erp_lines):
        """How many internal QR labels the newest delivery needs, from the
        part's newest ERP GRN line (`erp_lines` is newest GRN first): the qty
        quality accepted when ERP has it, else the qty received. A GRN rejected
        outright is skipped — it brought nothing to label. None when ERP has no
        GRN for the part: the operator picks the count. Only a suggestion; a
        label print never adds stock."""
        for ln in erp_lines:
            if ln["state"] == "REJECTED":
                continue
            if ln["accept_qty"]:
                qty, basis = ln["accept_qty"], "accepted"
            else:
                qty, basis = ln["receipt_qty"], "received"
            if qty and qty > 0:
                return {"grn_no": ln["grn_no"], "grn_date": ln["grn_date"],
                        "qty": _q(qty), "basis": basis}
        return None

    # ----------------------------------------------------------------- actions

    @staticmethod
    def _actions(part, buckets, issues, returns, rgps, printed_count, history_count):
        """Every action key, in the contract's order, each saying whether it is
        valid for the part's documents right now and — when not — why (spec 27 /
        28: only what fits the current state is offered, and a greyed button
        explains itself). ISSUE comes first: scanning is mainly for issuance.
        There is no receive / GRN / quality clearance: those are done in ERP and
        read from it. There is no RGP from fresh stock: RGP_OUT needs a return
        held or damaged in the store."""
        n_rgp_grn = sum(1 for g in rgps if g.qty_grn_pending > 0)
        n_rgp_back = sum(1 for g in rgps if g.qty_with_supplier > 0)
        n_inspect = sum(1 for r in returns
                        if r.q("qty_pending") + r.q("qty_hold") + r.q("qty_damaged") > 0)
        n_rgp_out = sum(1 for r in returns if r.q("qty_hold") + r.q("qty_damaged") > 0)
        n_out = sum(1 for i in issues if (i.get("outstanding_qty") or 0) > 0)
        nothing_out = "Nothing issued is still out"
        rules = (
            ("ISSUE", buckets["available"] > 0, None, "No stock available to issue"),
            ("RGP_GRN", n_rgp_grn > 0, n_rgp_grn, "No supplier return is waiting for its RGP GRN"),
            ("RGP_RETURN", n_rgp_back > 0, n_rgp_back, "Nothing is with a supplier for rework"),
            ("INSPECT", n_inspect > 0, n_inspect, "No returned material is waiting for inspection"),
            ("RETURN", n_out > 0, n_out, nothing_out),
            ("UPDATE_INSTALLATION", n_out > 0, n_out, nothing_out),
            ("RGP_OUT", n_rgp_out > 0, n_rgp_out,
             "RGP is only for returned material on hold or damaged — there is no direct RGP"),
            ("REPRINT_LABEL" if printed_count else "PRINT_LABEL", True,
             printed_count or None, None),
            ("UPDATE_LOCATION", True, None, None),
            ("HISTORY", True, history_count, None),
        )
        out = []
        for key, enabled, count, why in rules:
            # History only reads; everything else writes, and nothing is written
            # against a part the master has switched off.
            if not part.is_active and key != "HISTORY":
                enabled, why = False, INACTIVE_REASON
            out.append({"key": key, "enabled": bool(enabled),
                        "reason": None if enabled else why, "count": count})
        return out

    @staticmethod
    def _primary_action(actions):
        enabled = {a["key"] for a in actions if a["enabled"]}
        return next((k for k in PRIMARY_ACTIONS if k in enabled), None)

    # ------------------------------------------------------------ scan result

    def build(self, part_id):
        """The one payload the Scan Part workstation renders (spec 22 / 30):
        what the part is, where every unit is, which documents are open, what
        the operator can do next, the codes that reach it and the latest
        history."""
        part = self._part(part_id)
        stock_row = self.stock_repo.get_by_part(part.id)
        health = SpareStockService._row_dict(part, stock_row)
        erp_lines = self._erp_lines(part)
        returns = self._open_returns(part.id)
        rgps = self._open_rgps(part.id)
        issues = self._open_issues(part.id)
        buckets = self._sum_buckets(stock_row, erp_lines, issues, returns, rgps)
        counted = stock_row is not None

        prints = self._prints(part.id)
        history = self._timeline_rows(part, prints, erp_lines)
        label = self._label_summary(part, prints)
        actions = self._actions(part, buckets, issues, returns, rgps,
                                label["printed_count"], len(history))
        section = db.session.get(Section, part.section_id) if part.section_id else None
        today = datetime.now().date()

        return {
            "part": {
                "id": part.id, "part_no": part.part_no, "part_name": part.part_name,
                "uom": part.uom, "location": part.location,
                "rework_location": part.rework_location, "section_id": part.section_id,
                "section_name": section.name if section else None,
                "category": part.category, "sub_category": part.sub_category,
                "unit_price": _f(part.unit_price),
                "min_stock_level": float(part.min_stock_level or 0),
                "reorder_level": _f(part.reorder_level),
                "max_stock_level": _f(part.max_stock_level),
                "is_active": bool(part.is_active),
            },
            "stock": {
                "qty_on_hand": health["qty_on_hand"], "status": health["status"],
                "counted": counted, "last_counted_at": health["last_counted_at"],
            },
            "buckets": buckets,
            "primary_status": primary_status(buckets, counted),
            "statuses": self._statuses(buckets),
            "locations": self._locations(part, buckets, erp_lines, issues, returns, rgps),
            # Receiving is read from ERP: the part's GRN lines still in play and
            # the latest ones added to store stock, with the mirror's freshness.
            "erp_receiving": self._erp_receiving(erp_lines, self.erp_grn.mirror_freshness()),
            "open_issues": issues[:OPEN_ISSUES_MAX],
            "open_returns": [self._return_dict(r) for r in returns],
            "open_rgps": [self._rgp_dict(g, today) for g in rgps],
            "actions": actions,
            "primary_action": self._primary_action(actions),
            "label": label,
            # The part's internal QR and mapped supplier codes, and the label
            # count the newest ERP GRN suggests (Receive & Label mode).
            "barcodes": self._barcodes(part),
            "label_qty_hint": self._label_qty_hint(erp_lines),
            "timeline": {"rows": history[:SCAN_TIMELINE_ROWS],
                         "has_more": len(history) > SCAN_TIMELINE_ROWS},
        }

    # ----------------------------------------------------------------- timeline

    def timeline(self, part_id, limit=200):
        """The part's whole history, newest first (spec 21) — no fixed row cap;
        `limit` only pages it, and has_more says there is more."""
        part = self._part(part_id)
        rows = self._timeline_rows(part, erp_lines=self._erp_lines(part))
        limit = max(1, int(limit or 200))
        return {"rows": rows[:limit], "has_more": len(rows) > limit}

    def _timeline_rows(self, part, prints=None, erp_lines=()):
        """Merge every source of the part's history onto one timeline:

        * the journal (spare_transactions) — every business event since the QR
          flow, with its before / after status. An ERP GRN whose accepted qty
          the app added to stock reads as "Quality accepted in ERP";
        * stock-ledger rows the journal does not explain — opening counts,
          adjustments, and receipts / issues / returns from before the journal;
          plus ONE "Added to store stock" row for each ledger row that put
          quantity back on the rack (ERP-accepted GRN, GOOD return inspection,
          RGP GRN, an older in-app quality clearance), so the moment it became
          issuable is visible;
        * an installation recorded on an ISSUE row with no journal row for it;
        * the receiving history, read from ERP: gate entries and the part's GRN
          lines (`erp_lines`, one per GRN no., from ErpGrnPostingService);
        * label prints and location moves.

        A ledger row a journal row already points at is not shown twice.
        Receipts the store recorded in the app before receiving moved to ERP
        stay in the history as they were recorded."""
        journal = (SpareTransaction.query.filter_by(part_id=part.id)
                   .order_by(SpareTransaction.created_at.asc(), SpareTransaction.id.asc()).all())
        ledger = SpareStockLedger.query.filter_by(part_id=part.id).all()
        ledger_by_id = {row.id: row for row in ledger}
        receipts = {r.id: r for r in SpareReceipt.query.filter_by(part_id=part.id).all()}
        returns = {r.id: r for r in SpareReturn.query.filter_by(part_id=part.id).all()}
        rgps = {g.id: g for g in SpareRgp.query.filter_by(part_id=part.id).all()}
        explained = {t.ledger_id for t in journal if t.ledger_id}
        installed_in_journal = {t.issue_id for t in journal
                                if t.txn_type == "INSTALLATION" and t.issue_id}
        waiting = self._still_waiting(journal, returns, rgps)

        # (sort stamp, rank, id, row). Rank only breaks exact ties: the
        # "Added to store stock" row sits just above the event that caused it.
        events = []
        added = set()
        for t in journal:
            led = ledger_by_id.get(t.ledger_id)
            events.append((t.created_at, 1, t.id, self._journal_row(
                t, led, receipts, returns, rgps, waiting=waiting.get(t.id))))
            if led is not None and led.id not in added and self._adds_available(led):
                added.add(led.id)
                events.append((t.created_at, 2, t.id, self._stock_available_row(led, t, returns)))
        for led in ledger:
            if led.id not in explained:
                events.append((led.created_at, 0, led.id, self._ledger_row(led)))
            if (led.txn_type == "ISSUE" and led.confirmed_at is not None
                    and led.id not in installed_in_journal):
                events.append((led.confirmed_at, 0, led.id, self._ledger_installation_row(led)))

        arrivals, _ = self.flow._gate_history(part.part_no)
        for a in arrivals:
            events.append((self._erp_day(a["gate_entry_dt"]), -1, 0, self._gate_row(a)))
        for ln in erp_lines:
            events.append((self._erp_day(ln["grn_date"]), -1, 0, self._erp_grn_row(ln)))

        for p in (prints if prints is not None else self._prints(part.id)):
            events.append((p.created_at, 0, p.id, self._label_row(p)))
        for m in (SpareLocationHistory.query.filter_by(part_id=part.id).all()):
            events.append((m.created_at, 0, m.id, self._location_row(m)))

        events.sort(key=lambda e: (_naive(e[0]) or datetime.min, e[1], e[2]), reverse=True)
        return [e[3] for e in events]

    @staticmethod
    def _erp_day(iso):
        try:
            return date.fromisoformat(iso[:10]) if iso else None
        except ValueError:
            return None

    @staticmethod
    def _still_waiting(journal, returns, rgps):
        """How much of each RETURN_TO_STORE / RGP_RETURN event still waits on
        the step after it, as {journal id: qty} (absent = nothing).

        Those rows say "waiting for …", which is true only while the document
        is still in that state; once the inspection or the RGP GRN is recorded,
        the rows above say so and the note must go. So the state is read from
        the document as it is NOW, never assumed from the event:

        * an in-app receipt (RECEIVE) waits for nothing here any more: its GRN
          and quality clearance are done in ERP and appear as ERP rows, so a
          receipt left RECEIVED in the app is history, not a pending step;
        * a return waits for the store inspection for its qty_pending (the
          part not inspected yet);
        * an RGP GRN is recorded against the RGP, not against one supplier
          return, so the GRN'd quantity is matched to the supplier returns
          oldest first (`journal` is oldest first) — the units are the same
          part, the QR is part level — and a supplier return waits only for
          what that leaves uncovered. What is left over adds up to the RGP's
          qty_grn_pending."""
        waiting = {}
        grn_left = {}
        for t in journal:
            if t.txn_type == "RETURN_TO_STORE":
                ret = returns.get(t.return_id)
                if ret is not None and ret.q("qty_pending") > 0:
                    waiting[t.id] = _q(ret.q("qty_pending"))
            elif t.txn_type == "RGP_RETURN":
                rgp = rgps.get(t.rgp_id)
                if rgp is None or rgp.qty_grn_pending <= 0:
                    continue
                covered = grn_left.setdefault(rgp.id, float(rgp.qty_grn or 0))
                qty = float(t.qty or 0)
                used = min(qty, covered)
                grn_left[rgp.id] = covered - used
                if _q(qty - used) > 0:
                    waiting[t.id] = _q(qty - used)
        return waiting

    @staticmethod
    def _adds_available(led):
        """A ledger row that put quantity back on the rack: a RECEIPT (an
        ERP-accepted GRN / an in-app quality clearance / RGP GRN) or a RETURN
        (GOOD inspection)."""
        return led.txn_type in ("RECEIPT", "RETURN") and float(led.qty_delta) > 0

    @staticmethod
    def _erp_posting(t, led):
        """The journal row ErpGrnPostingService writes when it adds an
        ERP-accepted GRN line to stock: txn_type GRN over a RECEIPT row with
        status ERP_GRN (remarks "ERP GRN …" when the ledger row is not loaded)."""
        if t.txn_type != "GRN":
            return False
        if led is not None:
            return led.status == ERP_GRN_STATUS
        return (t.remarks or "").startswith("ERP GRN ")

    @staticmethod
    def _journal_row(t, led, receipts, returns, rgps, waiting=None):
        """One journal event as a timeline row. `waiting` is how much of it
        still waits on the next step (_still_waiting): a "waiting for …" note
        is added only while that is true, so an old row never contradicts the
        inspection / RGP GRN rows recorded after it."""
        rec = receipts.get(t.receipt_id)
        ret = returns.get(t.return_id)
        rgp = rgps.get(t.rgp_id)
        kind = t.txn_type
        supplier = t.supplier_name or (rgp.ven_name if rgp else None) or (rec.ven_name if rec else None)
        rgp_no = t.rgp_no or (rgp.rgp_no if rgp else None)
        grn_no = t.grn_no or (rec.grn_no if rec and kind in ("GRN", "QUALITY_CLEARANCE") else None)
        return_no = ret.return_no if ret else None
        department = t.department or (ret.department if ret else None)
        reference = (rec.receipt_no if rec else None) or (led.reference if led is not None else None)
        where = _where(t.line_name, t.line_no, t.machine, t.die_no)
        qty = _f(t.qty)
        remarks = t.remarks

        if kind == "RECEIVE":
            # A receipt recorded in the app before receiving moved to ERP —
            # shown as recorded.
            title = f"Received from supplier – {supplier}" if supplier else "Received from supplier"
            detail = _join(t.invoice_no and f"Invoice {t.invoice_no}",
                           rec and rec.check_result and f"Check {rec.check_result}")
        elif ScanResultService._erp_posting(t, led):
            # ERP's quality accepted the GRN line and the app's ERP sync added
            # the accepted qty to stock. ERP gives no quality date: the row is
            # stamped when the sync read it, and says so. Its remark only
            # repeats that, so it is not shown.
            kind = "QUALITY_CLEARANCE"
            title = f"Quality accepted in ERP – GRN {grn_no}" if grn_no else "Quality accepted in ERP"
            detail = _join(t.invoice_no and f"Invoice {t.invoice_no}",
                           "Read from ERP by the app's sync — ERP gives no quality date")
            remarks = None
        elif kind == "GRN":
            title = f"GRN created – {grn_no}" if grn_no else "GRN created"
            detail = _join("GRN no. recorded by the store supervisor",
                           rec and rec.quality_by and f"Quality by {rec.quality_by}")
        elif kind == "QUALITY_CLEARANCE":
            by = t.department or (rec.quality_by if rec else None)
            if t.to_bucket == "REJECTED" or t.inspection_result == "REJECTED":
                kind = "QUALITY_REJECT"
                title = f"Rejected by quality – {by}" if by else "Rejected by quality"
            else:
                title = f"Quality cleared – {by}" if by else "Quality cleared"
            detail = None
        elif kind == "ISSUE":
            title = f"Issued to {department}" if department else "Issued"
            detail = _handed_to(t.issued_to, t.issued_to_code)
        elif kind == "INSTALLATION":
            if not where:
                title = "Installation updated"
            elif t.new_status == "PARTIALLY_USED":
                title = f"Partly used – {where}"
            else:
                title = f"Installed – {where}"
            detail = _join(qty is not None and f"Actual usage {_g(qty)}")
        elif kind == "RETURN_TO_STORE":
            reason = _reason(t.return_reason or (ret.reason if ret else None))
            title = f"Returned to store – {reason}" if reason else "Returned to store"
            detail = _join(department and f"From {department}",
                           ret and ret.returned_by and f"By {ret.returned_by}",
                           _still(waiting, qty, "store inspection"))
        elif kind == "RETURN_INSPECTION":
            title = INSPECTION_TITLES.get(t.inspection_result, "Return inspected")
            detail = _join(BUCKET_WORDS.get(t.to_bucket, "").capitalize() or None)
        elif kind == "RGP_OUT":
            tail = f" ({rgp_no})" if rgp_no else ""
            title = (f"Issued to supplier for rework – {supplier}{tail}" if supplier
                     else f"Issued to supplier for rework{tail}")
            detail = _join(rgp and rgp.rework_reason,
                           rgp and rgp.expected_return_date
                           and f"Expected back {rgp.expected_return_date.strftime('%d %b %Y')}")
        elif kind == "RGP_RETURN":
            tail = f" ({rgp_no})" if rgp_no else ""
            title = f"Supplier returned – {supplier}{tail}" if supplier else f"Supplier returned{tail}"
            still = _still(waiting, qty, "the RGP GRN")
            detail = still and f"{still} — not in store stock yet"
        elif kind == "RGP_GRN":
            title = f"RGP GRN completed – {grn_no}" if grn_no else "RGP GRN completed"
            detail = _join(rgp_no, "GRN no. recorded by the store supervisor")
        elif kind == "STOCK_ADJUSTMENT":
            title = "Stock adjusted"
            detail = None
        elif kind == "CANCEL":
            if rec is not None:
                title = f"Receipt cancelled – {rec.receipt_no}"
            elif rgp is not None:
                title = f"RGP cancelled – {rgp.rgp_no}"
            else:
                title = "Cancelled"
            detail = None
        else:
            title = kind.replace("_", " ").capitalize()
            detail = None

        # Remarks that only repeat what the detail already says (the RGP's
        # rework reason is also its remark) are not shown twice.
        remarks = remarks if remarks and remarks not in (detail or "") else None
        # When the event put quantity back on the rack, the stock change is
        # shown once, on its own "Added to store stock" row — not here as well,
        # where it would read as a second +qty.
        shows_delta = led is not None and not ScanResultService._adds_available(led)
        return _row(
            at=_iso(t.created_at), kind=kind, title=title,
            detail=_join(detail, remarks), qty=qty,
            qty_delta=_f(led.qty_delta) if shows_delta else None,
            prev_status=t.prev_status, new_status=t.new_status,
            department=department, issued_to=t.issued_to, line_name=t.line_name,
            line_no=t.line_no, machine=t.machine, die_no=t.die_no, supplier=supplier,
            rgp_no=rgp_no, grn_no=grn_no, return_no=return_no, reference=reference,
            user=t.created_by, source="journal",
        )

    @staticmethod
    def _stock_available_row(led, t, returns):
        ret = returns.get(t.return_id)
        delta = float(led.qty_delta)
        return _row(
            at=_iso(t.created_at), kind="STOCK_AVAILABLE", title="Added to store stock",
            detail=f"{_g(led.balance_after)} available after this",
            qty=abs(delta), qty_delta=delta, new_status="AVAILABLE",
            supplier=t.supplier_name, rgp_no=t.rgp_no, grn_no=t.grn_no,
            return_no=led.return_no or (ret.return_no if ret else None),
            reference=led.reference, user=led.created_by, source="ledger",
        )

    @staticmethod
    def _ledger_row(led):
        """A stock movement with no journal row — the opening count, a
        correction, or a receipt / issue / return from before the journal."""
        delta = float(led.qty_delta)
        balance = _g(led.balance_after)
        supplier = led.supplier.supplier_name if led.supplier is not None else None
        fields = {"return_no": None, "line_name": None, "line_no": None, "die_no": None,
                  "machine": led.machine, "supplier": supplier}
        t = led.txn_type
        if t == "OPENING":
            kind, title, detail = "OPENING", "Opening stock", f"Counted {balance} on the shelf"
        elif t == "ADJUSTMENT":
            kind, title, detail = "STOCK_ADJUSTMENT", f"Stock adjusted {delta:+g}", f"Corrected to {balance}"
        elif t == "RECEIPT" and led.status in ERP_ORIGIN_RECEIPT_STATUSES:
            kind, title, detail = "STOCK_AVAILABLE", "Added to store stock", f"{balance} available after this"
        elif t == "RECEIPT":
            # The former direct receive: it went straight onto the rack.
            kind = "RECEIVE"
            title = f"Received into store stock – {supplier}" if supplier else "Received into store stock"
            detail = _join(led.invoice_no and f"Invoice {led.invoice_no}",
                           led.check_result and f"Check {led.check_result}")
        elif t == "RETURN" and led.status == RETURN_ROW_INSPECTED:
            kind, title, detail = "STOCK_AVAILABLE", "Added to store stock", "Return inspected good"
            fields["return_no"] = led.return_no
        elif t == "RETURN":
            # A return slip from before the store inspection existed: it went
            # straight back onto the rack.
            reason = _reason(led.return_reason)
            kind = "RETURN_TO_STORE"
            title = f"Returned to store – {reason}" if reason else "Returned to store"
            detail = _join(led.return_no and f"Slip {led.return_no}",
                           led.returned_by and f"By {led.returned_by}",
                           "Straight back to store stock")
            fields["return_no"] = led.return_no
        elif t == "ISSUE":
            kind = "ISSUE"
            title = f"Issued to {led.department}" if led.department else "Issued"
            detail = _handed_to(led.issued_to, led.issued_to_code)
            # line / die on an ISSUE row are where it was fitted later — they go
            # on the installation row, not on the moment it left the store.
            if led.confirmed_at is not None:
                fields["machine"] = None
        else:
            kind, title, detail = t, t.replace("_", " ").capitalize(), None
        return _row(
            at=_iso(led.created_at), kind=kind, title=title,
            detail=_join(detail, led.remarks if led.remarks != led.return_reason else None),
            qty=abs(delta), qty_delta=delta, new_status=led.status,
            department=led.department, issued_to=led.issued_to if t == "ISSUE" else None,
            reference=led.reference, user=led.created_by, source="ledger", **fields,
        )

    @staticmethod
    def _ledger_installation_row(led):
        """Line / machine / die recorded on an ISSUE row by a confirmation that
        wrote no journal row (the two-stage issue before the journal)."""
        where = _where(led.line_name, led.line_no, led.machine, getattr(led, "die_no", None))
        issued = abs(float(led.qty_delta))
        used = _f(led.actual_qty)
        partly = used is not None and used < issued
        if not where:
            title = "Installation confirmed"
        else:
            title = f"{'Partly used' if partly else 'Installed'} – {where}"
        return _row(
            at=_iso(led.confirmed_at), kind="INSTALLATION", title=title,
            detail=_join(used is not None and f"Actual usage {_g(used)} of {_g(issued)}"),
            qty=used, department=led.department, issued_to=led.issued_to,
            line_name=led.line_name, line_no=led.line_no, machine=led.machine,
            die_no=getattr(led, "die_no", None), reference=led.reference,
            user=led.confirmed_by, source="ledger",
        )

    @staticmethod
    def _gate_row(a):
        """An ERP gate entry of this part. ERP's GRN rows carry no gate entry
        no., so the arrival is never tied to a GRN here."""
        who = a.get("ven_name") or a.get("ven_cd")
        return _row(
            at=a.get("gate_entry_dt"), kind="ERP_GATE",
            title=f"Received at gate – {who}" if who else "Received at gate",
            detail=_join(a.get("gate_entry_no") and f"Gate entry {a['gate_entry_no']}",
                         a.get("gate_entry_time") and f"Gate time {a['gate_entry_time']}",
                         a.get("bill_no") and f"Bill {a['bill_no']}",
                         a.get("po_no") and f"PO {a['po_no']}"),
            qty=a.get("qty"), supplier=who, reference=a.get("gate_entry_no"), source="erp_gate",
        )

    @staticmethod
    def _erp_grn_row(ln):
        """One ERP GRN line of this part (ErpGrnPostingService.lines — one per
        GRN no.): what ERP received and what its quality decided. A line the
        app has not added to stock (yet, or ever) says why; one it has added
        is followed by its "Quality accepted in ERP" row."""
        who = ln["ven_name"] or ln["ven_cd"]
        accepted, rejected = ln["accept_qty"], ln["reject_qty"]
        if ln["state"] == "QUALITY_PENDING":
            verdict = f"received {_g(ln['receipt_qty'])} · quality pending"
        else:
            verdict = ", ".join(x for x in (accepted is not None and f"accepted {_g(accepted)}",
                                            rejected and f"rejected {_g(rejected)}") if x) or None
        why = ln["reason"] if ln["state"] in ("WILL_POST", "CHECK", "SKIPPED", "OFF") else None
        return _row(
            at=ln["grn_date"], kind="ERP_GRN",
            title=f"GRN created in ERP – {ln['grn_no']}",
            detail=_join(verdict, why, who, ln["invoice_no"] and f"Invoice {ln['invoice_no']}"),
            qty=ln["receipt_qty"], new_status=ln["state"], supplier=who,
            grn_no=ln["grn_no"], reference=ln["grn_no"], source="erp_grn",
        )

    @staticmethod
    def _label_row(p):
        copies = int(p.copies or 1)
        title = "Label reprinted" if p.is_reprint else "Label printed"
        if copies > 1:
            title += f" – {copies} copies"
        return _row(
            at=_iso(p.created_at), kind="LABEL_PRINT", title=title,
            detail=_join(PRINT_SOURCE_LABELS.get(p.source, p.source), p.printer_name,
                         p.location_printed and f"Location {p.location_printed}",
                         p.reason and f"Reason: {p.reason}"),
            reference=p.barcode_value, user=p.printed_by, source="label",
        )

    @staticmethod
    def _location_row(m):
        return _row(
            at=_iso(m.created_at), kind="LOCATION_MOVE",
            title=f"Location changed – {m.old_location or '—'} → {m.new_location or '—'}",
            detail=m.reason, qty=_f(m.qty), user=m.moved_by, source="location",
        )

    # -------------------------------------------------------------- work queues

    def queues(self, store_code):
        """Everything in the store waiting on a step, oldest first so the queue
        is worked in the order material arrived: ERP GRN lines quality has not
        cleared in ERP (or whose ERP figures need a check) — read-only, the
        step is ERP's —, returns for inspection, RGPs with a supplier or
        waiting for their RGP GRN, and issues waiting for the user's line /
        machine confirmation."""
        now = _now()
        today = datetime.now().date()
        # One read of the store's ERP GRN lines covers every part.
        erp_lines = [ln for ln in self.erp_grn.lines(store_code) if ln["state"] in ERP_QUEUE_STATES]
        erp_lines.sort(key=lambda ln: (ln["grn_date"] or "", ln["grn_no"]))
        part_ids = {ln["part_id"] for ln in erp_lines}
        erp_parts = ({p.id: p for p in Part.query.filter(Part.id.in_(part_ids)).all()}
                     if part_ids else {})
        returns = (SpareReturn.query.options(joinedload(SpareReturn.part))
                   .filter(SpareReturn.store_code == store_code,
                           SpareReturn.status.in_(RETURN_OPEN))
                   .order_by(SpareReturn.created_at.asc(), SpareReturn.id.asc()).all())
        rgps = (SpareRgp.query.options(joinedload(SpareRgp.part))
                .filter(SpareRgp.store_code == store_code, SpareRgp.status.in_(RGP_OPEN))
                .order_by(SpareRgp.created_at.asc(), SpareRgp.id.asc()).all())

        quality = []
        for ln in erp_lines:
            d = self._with_part(dict(ln), erp_parts.get(ln["part_id"]))
            d["age_days"] = _grn_age_days(ln["grn_date"], today)
            quality.append(d)
        inspection = []
        for r in returns:
            d = self._with_part(self._return_dict(r), r.part)
            d["age_days"] = _age_days(r.created_at, now)
            inspection.append(d)
        with_supplier = [self._with_part(self._rgp_dict(g, today), g.part)
                         for g in rgps if g.qty_with_supplier > 0]
        grn_pending = [self._with_part(self._rgp_dict(g, today), g.part)
                       for g in rgps if g.qty_grn_pending > 0]
        awaiting = self.stock.pending_confirmations(store_code)
        return {
            "quality": quality,
            "inspection": inspection,
            "with_supplier": with_supplier,
            "rgp_grn_pending": grn_pending,
            "awaiting_confirmation": awaiting,
            "counts": {
                "quality": len(quality), "inspection": len(inspection),
                "with_supplier": len(with_supplier), "rgp_grn_pending": len(grn_pending),
                "awaiting_confirmation": len(awaiting),
            },
            # How current the ERP GRN mirror behind `quality` is.
            "erp": self.erp_grn.mirror_freshness(),
        }
