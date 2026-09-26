"""Receiving & GRN monitor for a store's parts — what came in, per source.

Five sources, kept apart on purpose because each one means something different:

    Receiving flow   read from ERP (spec 1 / 9, user decision 2026-09-26): the
                     ERP GRN lines of the store's parts, one per part and GRN
                     no., each in the state ErpGrnPostingService gives it. ONE
                     business flow — ARRIVED AT GATE -> GRN CREATED (ERP) ->
                     QUALITY PENDING (ERP) -> ACCEPTED BY QUALITY (ERP) -> ADDED
                     TO STORE STOCK; there is no separate SRV step for a spare,
                     and the app records none of these steps by hand.
    ERP GRN lines    receiving_register, the mirror of ERP srv_report: ERP's own
                     record that goods were received against a GRN.
    Store receipts   RECEIPT rows in the spare ledger: stock that became
                     available in this app — an ERP-accepted GRN line, an RGP
                     GRN, an in-app quality clearance of the earlier flow (all
                     ERP-origin), or a direct receipt of the flow before that.
    SRV pipeline     the app's SRV records (the ERP-inbound flow) for these
                     parts, mapped onto the monitor's six statuses through
                     SRV_STATUS_MAP — a status with no honest equivalent is
                     shown under its own name, never forced into one. For a
                     spare this is ERP's side of the same GRN step.
    At the gate      ERP gate entries for these parts with no GRN line and no
                     receipt on or after the arrival date. A likely pending,
                     not a finding of loss: ERP's GRN rows carry no gate entry
                     no., so the match is by part and date only, and the GRN
                     mirror may simply not reach that date yet (flagged per row).

Matching is part_no = ERP item code, trimmed and case-insensitive. Both ERP
mirrors carry store_code CHILD_PART on every row, so the store is decided by
the part the item code resolves to, never by the mirror's own store column.
Each source is read with one query; the part map is built once.
"""
from collections import Counter
from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import func, or_

from app.extensions import db
from app.models.gate_entry import GateEntry
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.spare_stock import ERP_ORIGIN_RECEIPT_STATUSES, SpareStockLedger
from app.models.srv import SRV, STATUSES as SRV_STATUSES
from app.models.store import Section, Store
from app.models.supplier import Supplier
from app.services.erp_grn_posting_service import ErpGrnPostingService
from app.services.spare_stock_service import SpareStockService
from app.utils.exceptions import BadRequestError

DEFAULT_DAYS = 90
MAX_DAYS = 365

# Aging buckets in whole days: (label, lowest, highest) — None = open-ended.
AGING_BUCKETS = (("0-3", 0, 3), ("4-7", 4, 7), ("8-15", 8, 15), (">15", 16, None))

# The monitor's SRV statuses, as the receiving spec names them.
PIPELINE_STATUSES = (
    "Verification Pending", "Created", "Engineer Pending", "Approved", "Rejected", "ERP Updated",
)

# Every real SRV status -> (monitor status or None, why). None means no honest
# equivalent exists; such a row keeps its own status on screen. Nothing maps to
# "ERP Updated": no SRV field records that ERP posted the stock. RQC is the
# quality step for every SRV line ERP marks qc_required — spares included.
SRV_STATUS_MAP = {
    "PENDING_UNLOAD": ("Verification Pending", "At the gate; unloading and verification not yet reported"),
    "UNLOADED": ("Verification Pending", "Unloaded; the verified quantity is not yet reported"),
    "VERIFIED": (None, "Verified, SRV number not raised yet — no monitor status sits between the two"),
    "SRV_CREATED": ("Created", "SRV number raised by ERP"),
    "RQC_FORWARDED": ("Verification Pending",
                      "Forwarded to RQC for quality inspection (lines ERP marks qc_required, spares included)"),
    "INSPECTION_PENDING": ("Verification Pending",
                           "SRV raised; awaiting RQC's quality inspection — a quality check, not an engineer's"),
    "FORWARDED_TOOL_ROOM": ("Engineer Pending", "With Tool Room / Maintenance for engineer clearance"),
    "INSPECTED_APPROVED": ("Approved", "Inspection approved"),
    "STORED": ("Approved", "Accepted into store stock — at once when ERP marks no quality check, else after "
                           "RQC approval or Tool Room clearance. No ERP-posting flag, so not 'ERP Updated'"),
    "INSPECTED_REJECTED": ("Rejected", "Inspection rejected"),
    "RETURNED_TO_SUPPLIER": ("Rejected", "Rejected by RQC and returned to the supplier"),
    # Each of these passed STORED (stored_at is set): receiving ended in acceptance.
    "TRANSFERRED": ("Approved", "Accepted into store stock, then moved on to the part store"),
    "SUPPLIED": ("Approved", "Accepted into store stock, then supplied to production"),
    "CONSUMED": ("Approved", "Accepted into store stock, later consumed by production"),
}

# Statuses no committed SRV line rests in under SRVService's flow, and why. A
# monitor status fed only by these can never hold a line, so the screen says
# "not recorded" instead of a zero that could not have been anything else.
SRV_PASS_THROUGH = {
    "SRV_CREATED": "Routed on in the same step it is created — to RQC, or straight into stock",
    "RQC_FORWARDED": "Routed on in the same step the SRV is created",
    "STORED": "Transferred to the part store in the same step it is stored",
    "FORWARDED_TOOL_ROOM": "Reached only by a manual re-route from RQC_FORWARDED, where no line rests",
    "INSPECTED_APPROVED": "Never set — an RQC approval moves the line straight into stock",
    "INSPECTED_REJECTED": "Never set — an RQC rejection moves the line straight to RETURNED_TO_SUPPLIER",
    "SUPPLIED": "Never set — production consumption moves a line from TRANSFERRED straight to CONSUMED",
}


def _uncountable_statuses():
    """{monitor status: why} for the ones no resting SRV status maps onto."""
    out = {}
    for p in PIPELINE_STATUSES:
        feeders = [s for s, (m, _) in SRV_STATUS_MAP.items() if m == p]
        if not feeders:
            out[p] = "No SRV status or field records this"
        elif all(s in SRV_PASS_THROUGH for s in feeders):
            out[p] = "; ".join(f"{s}: {SRV_PASS_THROUGH[s]}" for s in feeders)
    return out

# An SRV still in one of these is waiting on someone, so it stays on the monitor
# even when it entered the flow before the window started.
OPEN_SRV_STATUSES = (
    "PENDING_UNLOAD", "UNLOADED", "VERIFIED", "SRV_CREATED", "RQC_FORWARDED",
    "INSPECTION_PENDING", "FORWARDED_TOOL_ROOM",
)

# A store receipt's (RECEIPT ledger row's) status as recorded when it was
# written. ERP_GRN and RGP_GRN are the only ones written now, both at the END
# of a flow (the stock is available); STOCK_AVAILABLE is the in-app quality
# clearance of the earlier flow, and the rest belong to the direct receive
# before that, which never moved a row on from its first status — so none of
# these is read as "still pending", it is shown as recorded.
RECEIPT_STATUS_LABELS = {
    "ERP_GRN": "Accepted by quality in ERP — in stock",
    "STOCK_AVAILABLE": "Quality cleared — in stock",
    "RGP_GRN": "RGP GRN — rework back in stock",
    "PHYSICALLY_RECEIVED": "Physically received",
    "PENDING_SRV_GRN": "Pending GRN",
    "PENDING_DEPARTMENT_CLEARANCE": "Pending department clearance",
    "ERP_STOCK_UPDATED": "ERP stock updated (store's entry)",
    "IMMEDIATELY_ISSUED": "Issued on arrival",
    "MOVED_TO_STORE_LOCATION": "Moved to store location",
    "REJECTED_OR_HOLD": "Rejected / on hold",
}

CHECK_ISSUES = ("SHORT", "EXCESS", "DAMAGED")

GATE_NOTE = "Arrived at gate, no GRN line or receipt on or after it yet — likely pending"

# The receiving status flow, read from ERP, in order. GATE counts the window's
# gate arrivals of the store's parts on their own: ERP's GRN rows carry no gate
# entry no., so an arrival is never tied to a GRN line. Every other step counts
# the window's ERP GRN lines (one per part and GRN no.) that have REACHED it (a
# funnel); `waiting` is how many are stopped there now — None where a line
# cannot rest.
FLOW_STEPS = (
    ("GATE", "Arrived at gate",
     "ERP gate entries of this store's parts — counted on their own: ERP does not link a gate entry to its GRN"),
    ("GRN_CREATED", "GRN created in ERP",
     "Read from ERP's GRN register (mirrored read-only) — one line per part and GRN no."),
    ("QUALITY_PENDING", "Quality pending (ERP)",
     "Every GRN line goes to Maintenance / Tool Room quality in ERP; waiting = ERP's accepted qty still empty"),
    ("QUALITY_CLEARED", "Accepted by quality (ERP)",
     "ERP shows an accepted qty (a fully rejected line stops before this); waiting = accepted, not yet added "
     "to store stock"),
    ("STOCK_ADDED", "Added to store stock",
     "The app's ERP sync adds the accepted qty to available stock once; a GRN already inside a physical count "
     "is not added again"),
)


def _key(code):
    return (code or "").strip().upper()


def _num(v):
    return float(v) if v is not None else None


def _local_offset():
    """The plant clock's offset from UTC, measured rather than hardcoded."""
    return datetime.now().astimezone().utcoffset() or timedelta(0)


def _naive_utc(ts):
    # SQLite hands created_at back naive (it is stored as UTC); a row still in
    # the session can carry the aware value it was written with.
    if ts is None:
        return None
    return ts.astimezone(timezone.utc).replace(tzinfo=None) if ts.tzinfo else ts


def _iso_utc(ts):
    ts = _naive_utc(ts)
    return ts.replace(tzinfo=timezone.utc).isoformat() if ts else None


def _aging(ages):
    out = {label: 0 for label, _, _ in AGING_BUCKETS}
    for age in ages:
        if age is None:
            continue
        for label, lo, hi in AGING_BUCKETS:
            if age >= lo and (hi is None or age <= hi):
                out[label] += 1
                break
    return out


class ReceivingMonitorService:
    def __init__(self):
        self.erp_grn = ErpGrnPostingService()

    def monitor(self, store_code, days=DEFAULT_DAYS):
        if days is None:
            days = DEFAULT_DAYS
        if not 1 <= days <= MAX_DAYS:
            raise BadRequestError(f"days must be between 1 and {MAX_DAYS}")

        # ERP dates are plant dates, so the window and every age run on the
        # plant clock; ledger timestamps (UTC) are converted onto it.
        offset = _local_offset()
        today = datetime.now().date()
        since = today - timedelta(days=days)
        since_utc = datetime.combine(since, time.min) - offset

        ctx = {
            "today": today, "offset": offset,
            "parts": self._parts(store_code),
            "sections": self._section_names(store_code),
        }
        sources = self._sources(store_code)
        grn = self._grn_lines(ctx, since)
        receipts = self._store_receipts(ctx, store_code, since_utc)
        srv = self._srv_pipeline(ctx, store_code, since_utc)
        erp_lines = self._erp_flow_lines(ctx, store_code, since)
        gate, spare_gate_lines, gate_qty = self._gate_not_received(
            ctx, since, grn, receipts, sources["grn_mirror"]["latest_date"])
        flow = self._flow(erp_lines, spare_gate_lines, gate_qty, self.erp_grn.mirror_freshness())

        return {
            "store_code": store_code,
            "window": {"days": days, "from": since.isoformat(), "to": today.isoformat()},
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "flow": flow,
            "summary": self._summary(grn, receipts, srv, gate, spare_gate_lines),
            "grn": grn,
            "store_receipts": receipts,
            "srv_pipeline": srv,
            "gate_not_received": gate,
            "srv_status_map": [
                {"status": s, "maps_to": SRV_STATUS_MAP[s][0], "note": SRV_STATUS_MAP[s][1],
                 "open": s in OPEN_SRV_STATUSES,
                 "rests": s not in SRV_PASS_THROUGH, "rest_note": SRV_PASS_THROUGH.get(s)}
                for s in SRV_STATUSES
            ],
            "pipeline_statuses": list(PIPELINE_STATUSES),
            "pipeline_not_countable": _uncountable_statuses(),
            "steps": self._steps(grn, receipts, srv, spare_gate_lines, erp_lines),
            "sources": sources,
        }

    # ------------------------------------------------------------- lookups

    @staticmethod
    def _parts(store_code):
        """{ITEM_CODE_UPPER: part} for the store's active parts, built once."""
        rows = (db.session.query(Part.id, Part.part_no, Part.part_name, Part.section_id)
                .filter(Part.store_code == store_code, Part.is_active.is_(True)))
        return {
            _key(pno): {"part_id": pid, "part_no": pno, "part_name": name, "section_id": sid}
            for pid, pno, name, sid in rows if _key(pno)
        }

    @staticmethod
    def _section_names(store_code):
        return dict(
            db.session.query(Section.id, Section.name)
            .join(Store, Store.id == Section.store_id)
            .filter(Store.code == store_code)
            .all()
        )

    @staticmethod
    def _ts_age(ctx, ts):
        """(local date, age in days) of a stored UTC timestamp."""
        ts = _naive_utc(ts)
        if ts is None:
            return None, None
        d = (ts + ctx["offset"]).date()
        return d, max((ctx["today"] - d).days, 0)

    # ------------------------------------------------------------- sources

    def _grn_lines(self, ctx, since):
        parts, sections, today = ctx["parts"], ctx["sections"], ctx["today"]
        RR = ReceivingRegister
        q = (db.session.query(RR.id, RR.grn_no, RR.grn_date, RR.item_cd, RR.item_desc,
                              RR.ven_cd, RR.ven_name, RR.challan_no, RR.po_no,
                              RR.receipt_qty, RR.accept_qty, RR.reject_qty)
             .filter(RR.grn_date >= since, RR.item_cd.isnot(None))
             .order_by(RR.grn_date.desc(), RR.id.desc()))
        out = []
        # The mirror holds the whole plant's GRNs; only lines whose item code is
        # one of this store's parts are kept.
        for (rid, grn_no, grn_date, item_cd, desc, ven_cd, ven_name, challan,
             po_no, receipt_qty, accept_qty, reject_qty) in q:
            p = parts.get(_key(item_cd))
            if not p:
                continue
            accept = accept_qty if accept_qty is not None else receipt_qty
            out.append({
                "id": rid, "source": "ERP GRN",
                "grn_no": grn_no, "grn_date": grn_date.isoformat() if grn_date else None,
                "part_id": p["part_id"], "part_no": p["part_no"], "part_name": p["part_name"],
                "description": (desc or "").strip() or p["part_name"],
                "qty": _num(accept), "receipt_qty": _num(receipt_qty),
                "accept_qty": _num(accept_qty), "reject_qty": _num(reject_qty),
                "supplier": (ven_name or "").strip() or ven_cd, "supplier_code": ven_cd,
                "invoice_no": challan, "po_no": po_no,
                "section_id": p["section_id"], "section": sections.get(p["section_id"]),
                "age_days": max((today - grn_date).days, 0) if grn_date else None,
            })
        return out

    def _store_receipts(self, ctx, store_code, since_utc):
        L = SpareStockLedger
        q = (db.session.query(L.id, L.part_id, L.created_at, L.qty_delta, L.reference, L.remarks,
                              L.invoice_no, L.invoice_date, L.check_result, L.status,
                              L.department, L.created_by, L.erp_pushed_at,
                              Part.part_no, Part.part_name, Part.section_id,
                              Supplier.supplier_name, Supplier.vendor_code)
             .join(Part, Part.id == L.part_id)
             .outerjoin(Supplier, Supplier.id == L.supplier_id)
             .filter(Part.store_code == store_code, L.txn_type == "RECEIPT",
                     L.created_at >= since_utc)
             .order_by(L.created_at.desc(), L.id.desc()))
        out = []
        for r in q:
            local_day, age = self._ts_age(ctx, r.created_at)
            out.append({
                "id": r.id, "source": "DX Store receipt",
                "received_at": _iso_utc(r.created_at),
                "received_day": local_day.isoformat() if local_day else None,
                "part_id": r.part_id, "part_no": r.part_no, "part_name": r.part_name,
                "qty": _num(r.qty_delta),
                "reference": r.reference, "remarks": r.remarks,
                "invoice_no": r.invoice_no,
                "invoice_date": r.invoice_date.isoformat() if r.invoice_date else None,
                "supplier": r.supplier_name, "supplier_code": r.vendor_code,
                "check_result": r.check_result,
                "status": r.status,
                "status_label": RECEIPT_STATUS_LABELS.get(r.status, r.status) if r.status else "Not recorded",
                "department": r.department,
                "received_by": r.created_by,
                "erp_pushed_at": _iso_utc(r.erp_pushed_at),
                # The stock-in already happened in ERP (the supervisor's GRN /
                # RGP GRN), so this row is never pushed and never "not in ERP".
                "erp_origin": r.status in ERP_ORIGIN_RECEIPT_STATUSES,
                "section_id": r.section_id, "section": ctx["sections"].get(r.section_id),
                "age_days": age,
            })
        return out

    def _srv_pipeline(self, ctx, store_code, since_utc):
        q = (db.session.query(SRV, Part.section_id)
             .join(Part, Part.id == SRV.part_id)
             .filter(Part.store_code == store_code,
                     or_(SRV.created_at >= since_utc, SRV.status.in_(OPEN_SRV_STATUSES)))
             .order_by(SRV.created_at.desc(), SRV.id.desc()))
        out = []
        for s, section_id in q:
            maps_to, note = SRV_STATUS_MAP.get(s.status, (None, "Status not in the SRV model's list"))
            started = s.gate_entry_time or s.created_at
            _, age = self._ts_age(ctx, started)
            out.append({
                "id": s.id, "source": "App SRV",
                "srv_no": s.srv_no, "status": s.status,
                "pipeline_status": maps_to, "mapped": maps_to is not None, "status_note": note,
                "open": s.status in OPEN_SRV_STATUSES,
                "part_id": s.part_id, "part_no": s.part_no, "part_name": s.part_name,
                "supplier": s.supplier_name or s.vendor_code, "supplier_code": s.vendor_code,
                "invoice_no": s.invoice_no, "gate_entry_no": s.gate_entry_no,
                "qty_invoiced": _num(s.qty_invoiced), "qty_received": _num(s.qty_received),
                "started_at": _iso_utc(started),
                "section_id": section_id, "section": ctx["sections"].get(section_id),
                "age_days": age,
            })
        return out

    def _erp_flow_lines(self, ctx, store_code, since):
        """The window's ERP GRN lines of the store's active parts — one per
        part and GRN no., in the state ErpGrnPostingService gives it (one read
        covers every part) — with the section and the days since the GRN."""
        by_id = {p["part_id"]: p for p in ctx["parts"].values()}
        since_iso = since.isoformat()
        out = []
        for ln in self.erp_grn.lines(store_code):
            p = by_id.get(ln["part_id"])
            if p is None or not ln["grn_date"] or ln["grn_date"] < since_iso:
                continue
            d = dict(ln)
            d["section_id"] = p["section_id"]
            d["section"] = ctx["sections"].get(p["section_id"])
            d["age_days"] = max((ctx["today"] - date.fromisoformat(ln["grn_date"])).days, 0)
            out.append(d)
        return out

    @staticmethod
    def _flow(lines, gate_lines, gate_qty, erp):
        """The receiving status flow, read from ERP, over the window: gate
        arrivals, then the ERP GRN lines dated in the window (`receipts`, the
        ErpGrnPostingService line shape). Nothing here is recorded by the app;
        `erp` is the mirror's freshness, which every count depends on."""
        by_state = Counter(ln["state"] for ln in lines)
        accepted = [ln for ln in lines if ln["accept_qty"]]
        added = [ln for ln in lines if ln["posted_qty"]]

        def total(rs, key):
            return round(sum(r[key] or 0 for r in rs), 2)

        reached = {
            "GATE": (gate_lines, gate_qty, None),
            "GRN_CREATED": (len(lines), total(lines, "receipt_qty"), None),
            "QUALITY_PENDING": (len(lines), total(lines, "receipt_qty"), by_state["QUALITY_PENDING"]),
            "QUALITY_CLEARED": (len(accepted), total(accepted, "accept_qty"),
                                by_state["WILL_POST"] + by_state["OFF"]),
            "STOCK_ADDED": (len(added), total(added, "posted_qty"), None),
        }
        steps = []
        for key, label, note in FLOW_STEPS:
            count, qty, waiting = reached[key]
            steps.append({"key": key, "label": label, "count": count, "qty": qty,
                          "waiting": waiting, "note": note})
        return {
            "steps": steps,
            "receipts": lines,
            "counts": dict(by_state),
            "open": by_state["QUALITY_PENDING"],
            "check": by_state["CHECK"],
            "skipped": by_state["SKIPPED"],
            "rejected": by_state["REJECTED"],
            "rejected_qty": total(lines, "reject_qty"),
            "erp": erp,
            "basis": ("ERP GRN lines (one per part and GRN no.) dated in the window, read from ERP. count = lines "
                      "that reached the step; waiting = lines stopped there now. Gate arrivals are counted on "
                      "their own."),
        }

    def _gate_not_received(self, ctx, since, grn, receipts, grn_latest):
        """Gate arrivals of the store's parts with no GRN line and no receipt
        (a ledger RECEIPT row) dated on or after the arrival — a likely pending:
        ERP does not link a gate entry to its GRN, so the match is by part and
        date only. Returns (rows, spare lines seen, their qty)."""
        parts, sections, today = ctx["parts"], ctx["sections"], ctx["today"]

        # Latest GRN / receipt day per part — anything on or after an arrival
        # covers it. Both lists are already the window's.
        last_grn, last_receipt = {}, {}
        for g in grn:
            d = g["grn_date"]
            if d and d > last_grn.get(g["part_id"], ""):
                last_grn[g["part_id"]] = d
        for r in receipts:
            d = r["received_day"]
            if d and d > last_receipt.get(r["part_id"], ""):
                last_receipt[r["part_id"]] = d

        G = GateEntry
        q = (db.session.query(G.id, G.gate_entry_no, G.gate_entry_dt, G.gate_entry_time,
                              G.item_code, G.item_desc, G.qty, G.ven_cd, G.ven_name,
                              G.po_no, G.bill_no)
             .filter(G.gate_entry_dt >= since, G.item_code.isnot(None))
             .order_by(G.gate_entry_dt.desc(), G.id.desc()))
        out, seen, seen_qty = [], 0, 0.0
        for (gid, gno, gdt, gtime, item_code, desc, qty, ven_cd, ven_name, po_no, bill_no) in q:
            p = parts.get(_key(item_code))
            if not p or gdt is None:
                continue
            seen += 1
            seen_qty += float(qty or 0)
            day = gdt.isoformat()
            lg, lr = last_grn.get(p["part_id"]), last_receipt.get(p["part_id"])
            if (lg and lg >= day) or (lr and lr >= day):
                continue
            out.append({
                "id": gid, "source": "ERP gate entry", "note": GATE_NOTE,
                "gate_entry_no": gno, "gate_entry_dt": day, "gate_entry_time": gtime,
                "part_id": p["part_id"], "part_no": p["part_no"], "part_name": p["part_name"],
                "description": (desc or "").strip() or p["part_name"],
                "qty": _num(qty),
                "supplier": (ven_name or "").strip() or ven_cd, "supplier_code": ven_cd,
                "po_no": po_no, "invoice_no": bill_no,
                "last_grn_date": lg, "last_receipt_day": lr,
                # The GRN mirror stops before this arrival (or is empty), so "no
                # GRN" here may only mean the mirror has not caught up.
                "beyond_grn_data": grn_latest is None or day > grn_latest,
                "section_id": p["section_id"], "section": sections.get(p["section_id"]),
                "age_days": max((today - gdt).days, 0),
            })
        return out, seen, round(seen_qty, 2)

    @staticmethod
    def _sources(store_code):
        """How far each source reaches — so an empty list can be read as "none
        happened" or "no data yet", and never mistaken for the other."""
        from app.services.erp_sync_service import ERPSyncService

        grn_latest, grn_rows = db.session.query(
            func.max(ReceivingRegister.grn_date), func.count(ReceivingRegister.id)).one()
        gate_latest, gate_rows = db.session.query(
            func.max(GateEntry.gate_entry_dt), func.count(GateEntry.id)).one()
        L = SpareStockLedger
        # Rows per movement type, so an empty receipts list can say what the
        # ledger does hold instead of a sentence that goes stale.
        by_type = (db.session.query(L.txn_type, func.count(L.id), func.min(L.created_at))
                   .join(Part, Part.id == L.part_id)
                   .filter(Part.store_code == store_code)
                   .group_by(L.txn_type).all())
        txn_counts = {t: int(n) for t, n, _ in by_type}
        ledger_start = min((_naive_utc(m) for _, _, m in by_type if m is not None), default=None)
        srv_ever = (db.session.query(func.count(SRV.id))
                    .join(Part, Part.id == SRV.part_id)
                    .filter(Part.store_code == store_code).scalar() or 0)
        sync = ERPSyncService().status()
        return {
            "grn_mirror": {
                "label": "ERP GRN lines (srv_report mirror)",
                "latest_date": grn_latest.isoformat() if grn_latest else None,
                "rows": grn_rows or 0,
            },
            "gate_mirror": {
                "label": "ERP gate entries (mirror)",
                "latest_date": gate_latest.isoformat() if gate_latest else None,
                "rows": gate_rows or 0,
            },
            "store_ledger": {
                "label": "DX Store ledger",
                "starts": _iso_utc(ledger_start),
                "receipts_ever": txn_counts.get("RECEIPT", 0),
                "txn_counts": txn_counts,
            },
            "srv": {"label": "App SRV records", "rows_ever": srv_ever},
            # Held in the running server's memory only: after a restart it reads
            # "never" until the next sync, even though the mirrors still hold data.
            "erp_sync": {
                "configured": sync["configured"],
                "last_sync_at": sync["last_sync_at"],
                "last_error": sync["last_error"],
                "in_memory_only": True,
            },
            "erp_write": SpareStockService.erp_write_status(),
        }

    # ------------------------------------------------------------- roll-ups

    @staticmethod
    def _summary(grn, receipts, srv, gate, spare_gate_lines):
        by_status = {s: 0 for s in PIPELINE_STATUSES}
        unmapped = {}
        for s in srv:
            if s["pipeline_status"]:
                by_status[s["pipeline_status"]] += 1
            else:
                unmapped[s["status"]] = unmapped.get(s["status"], 0) + 1
        open_srv = [s for s in srv if s["open"]]
        return {
            "grn": {
                "lines": len(grn),
                "parts": len({g["part_id"] for g in grn}),
                "with_rejection": sum(1 for g in grn if (g["reject_qty"] or 0) > 0),
                "latest_date": grn[0]["grn_date"] if grn else None,
                "aging": _aging(g["age_days"] for g in grn),
                "aging_basis": "Days since the GRN date",
            },
            "store_receipts": {
                "lines": len(receipts),
                "parts": len({r["part_id"] for r in receipts}),
                "check_recorded": sum(1 for r in receipts if r["check_result"]),
                "check_issues": sum(1 for r in receipts if r["check_result"] in CHECK_ISSUES),
                # A quality-cleared receipt / RGP GRN came in THROUGH ERP (the
                # GRN), so it is not a movement ERP is missing.
                "not_in_erp": sum(1 for r in receipts if not r["erp_pushed_at"] and not r["erp_origin"]),
                "erp_origin": sum(1 for r in receipts if r["erp_origin"]),
                "aging": _aging(r["age_days"] for r in receipts),
                "aging_basis": "Days since the store booked the receipt",
            },
            "srv_pipeline": {
                "lines": len(srv),
                "open": len(open_srv),
                "by_status": by_status,
                "unmapped": unmapped,
                "aging": _aging(s["age_days"] for s in open_srv),
                "aging_basis": "Open SRV lines only — days since gate entry (or since the line was recorded)",
            },
            "gate_not_received": {
                "lines": len(gate),
                "parts": len({g["part_id"] for g in gate}),
                "over_7_days": sum(1 for g in gate if g["age_days"] > 7),
                "beyond_grn_data": sum(1 for g in gate if g["beyond_grn_data"]),
                "oldest_days": max((g["age_days"] for g in gate), default=None),
                "gate_lines_in_window": spare_gate_lines,
                "aging": _aging(g["age_days"] for g in gate),
                "aging_basis": "Days since the gate entry",
            },
        }

    @staticmethod
    def _steps(grn, receipts, srv, spare_gate_lines, erp_lines=()):
        """The receiving workflow, step by step, with what the app can actually
        hold for each: tracked (a real source feeds it), partial (only some of
        the step is recorded) or not_tracked (nothing in the app writes it).
        `count` is the rows behind the step in this window — None when there is
        no source to count.

        Keys are kept for the screens that read them; the labels follow spec 1
        (no separate SRV step for a spare: the SRV records ERP pushes are its
        side of the same GRN step). Receiving is read from ERP: `erp_lines` are
        the window's ERP GRN lines (one per part and GRN no.)."""
        write = SpareStockService.erp_write_status()
        by_status = Counter(r["status"] for r in receipts)
        pushed = sum(1 for r in receipts if r["erp_pushed_at"])
        # ERP's GRN register carries the invoice (challan) but no physical
        # check result; only the direct receipts of the earliest flow recorded
        # one. ERP-origin ledger rows copy their document's invoice / check, so
        # they are not counted again.
        direct = [r for r in receipts if not r.get("erp_origin")]
        checked = sum(1 for r in direct if r["check_result"])
        invoiced = sum(1 for r in direct if r["invoice_no"]) + sum(1 for ln in erp_lines if ln["invoice_no"])
        # Quality has decided a line once ERP shows an accepted or rejected qty.
        decided = sum(1 for ln in erp_lines if ln["state"] != "QUALITY_PENDING")
        # Tool Room SRVs are unreachable by the current SRV flow; shown only if
        # rows really are there.
        engineer = sum(1 for s in srv if s["pipeline_status"] == "Engineer Pending")
        placed = by_status["MOVED_TO_STORE_LOCATION"]
        # The app can only record its own pushes, and only while the write path is on.
        erp_seen = bool(write["active"] or pushed)
        return [
            {"key": "gate_entry", "label": "Gate entry", "state": "tracked",
             "source": "ERP gate entries", "count": spare_gate_lines,
             "note": "Arrivals of these parts at the plant gate"},
            {"key": "physical_check", "label": "Physical check", "state": "partial" if checked else "not_tracked",
             "source": "Check result on older in-app receipts" if checked else "No source in the app",
             "count": checked if checked else None,
             "note": ("Done at receiving; ERP's GRN register carries no check result, so only receipts the "
                      "store recorded in the app earlier show one")},
            {"key": "invoice_verification", "label": "Invoice verification", "state": "partial",
             "source": "Invoice no. on ERP GRN lines (and older in-app receipts)",
             "count": invoiced,
             "note": "The invoice number is read from ERP; no verification outcome is recorded"},
            {"key": "srv_grn", "label": "GRN", "state": "tracked",
             "source": "ERP GRN lines + ERP-pushed SRV records", "count": len(grn) + len(srv),
             "note": ("The GRN is created in ERP and read from its GRN register (mirrored) and the SRV records "
                      "ERP pushes — one GRN step, not a separate SRV step")},
            {"key": "engineer_verification", "label": "Quality clearance (Maintenance / Tool Room)",
             "state": "tracked",
             "source": "Accepted / rejected qty on ERP GRN lines" + (" + SRV Tool Room clearance" if engineer else ""),
             "count": decided + engineer,
             "note": ("Done in ERP and read from it: the accepted quantity is added to available stock once by "
                      "the app's ERP sync, the rejected quantity never is. ERP gives no quality date")},
            {"key": "erp_update", "label": "ERP update", "state": "partial" if erp_seen else "not_tracked",
             "source": "App-to-ERP push of store receipts" if erp_seen else "No source in the app",
             "count": pushed if erp_seen else None,
             "note": (write["reason"] + ". Stock added from an ERP GRN (or an RGP GRN) is never pushed: "
                      "its stock-in happened in ERP")},
            {"key": "store_stock", "label": "Store stock", "state": "tracked",
             "source": "Store receipts (add to available stock)", "count": len(receipts),
             "note": ("An ERP GRN line accepted by quality in ERP (or an RGP GRN) adds its accepted quantity to "
                      "available stock once; a line still pending quality in ERP does not")},
            {"key": "rack_placement", "label": "Rack placement",
             "state": "partial" if placed else "not_tracked",
             "source": "Receipt status 'Moved to store location'" if placed else "No source in the app",
             "count": placed or None,
             "note": "No put-away is recorded for spares — a part has one fixed location and no rack capacity"},
        ]
