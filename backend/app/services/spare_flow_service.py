"""The Spare Parts Store's own material flow, and one part's traceability.

The plant's spare process is (spec 1 — the GRN is the one receiving document;
there is no separate SRV step for a spare):

    Supplier -> Gate Entry -> Material Received -> Physical Verification
    -> GRN (supervisor, in ERP) -> Maintenance / Tool Room ERP ID
    -> Quality Clearance -> Store Stock -> Issue -> ERP Consumption

Everything from the gate to the quality clearance happens in ERP and is READ
here (gate entries, the GRN register); the accepted qty reaches store stock
through ErpGrnPostingService.

Every stage below is read from data that actually exists. One of them cannot
be: see NOT_CAPTURED. Nothing here invents a count to fill a gap — a stage with
no source reports that it has none, because a fabricated zero and a real zero
look identical on a screen and mean opposite things.
"""
from app.extensions import db
from app.models.gate_entry import GateEntry
from app.models.receiving_register import ReceivingRegister
from app.models.spare_flow import SpareTransaction
from app.models.spare_stock import ERP_ORIGIN_RECEIPT_STATUSES, SpareStockLedger
from app.models.srv import SRV
from app.models.supplier import Supplier
from app.repositories.part_repository import PartRepository
from app.repositories.spare_stock_repository import (
    SpareStockLedgerRepository, SpareStockRepository,
)
from app.repositories.srv_repository import SRVRepository
from app.utils.exceptions import NotFoundError

# SRV statuses grouped onto the spare store's stages. The SRV model's own flow
# was built for Child Parts (it carries RQC and put-away states); only the
# stages the spare process actually passes through are mapped.
STAGES = [
    ("gate_entry", "Gate Entry", ["PENDING_UNLOAD"]),
    ("received", "Material Received", ["UNLOADED"]),
    ("verified", "Physical Verification", ["VERIFIED"]),
    # Key kept for existing readers; the spare store's receiving document is
    # the GRN alone (spec 1), so that is what the stage is called.
    ("srv_created", "GRN Created", ["SRV_CREATED"]),
    ("with_engineer", "Engineer Clearance", ["FORWARDED_TOOL_ROOM"]),
    ("in_store", "Store Stock", ["STORED"]),
    ("consumed", "ERP Consumption", ["CONSUMED"]),
]

# "SRV Pending" as the store means it: arrived but no SRV yet, or the SRV is
# sitting with an engineer for clearance.
PENDING_SRV_STATUSES = ["PENDING_UNLOAD", "UNLOADED", "VERIFIED"]
PENDING_CLEARANCE_STATUSES = ["FORWARDED_TOOL_ROOM"]

# Stages the database has no field for. Named so the screen can say what is
# missing instead of drawing an empty box, and so whoever adds the capture
# point later knows exactly what is wanted. The department an issue went to is
# NOT listed: every ISSUE records it (spare_stock_ledger.department, validated
# against the department master), and department-wise consumption reads it.
NOT_CAPTURED = {
    "maintenance_clearance":
        "SRV has a Tool Room forward and clearance timestamp but no Maintenance "
        "equivalent, so Maintenance pending/cleared cannot be split out yet.",
}

# RECEIPT ledger statuses booked against a supplier GRN (reference = the GRN
# no.): ERP_GRN — the ERP sync added an ERP-accepted GRN line
# (ErpGrnPostingService); STOCK_AVAILABLE — an in-app quality clearance of the
# earlier flow. RGP_GRN is reworked material, not a supplier delivery.
GRN_BOOKED_STATUSES = ("ERP_GRN", "STOCK_AVAILABLE")


class SpareFlowService:
    def __init__(self):
        self.srv_repo = SRVRepository()
        self.stock_repo = SpareStockRepository()
        self.ledger_repo = SpareStockLedgerRepository()
        self.part_repo = PartRepository()

    def material_flow(self, store_code):
        """Line counts at each stage, plus what is on the shelf and what has
        been issued — the two stages that live in stock rather than in SRV."""
        by_status = self.srv_repo.count_by_status_for_store(store_code)
        stages = [{
            "key": key,
            "label": label,
            "count": sum(by_status.get(s, 0) for s in statuses),
            "source": "srv",
        } for key, label, statuses in STAGES]

        # Store Stock and Issue are answered by the store's own ledger, not by
        # SRV: a spare counted in during a stock-take never had an SRV at all.
        counted = self.stock_repo.count_counted(store_code)
        for stage in stages:
            if stage["key"] == "in_store":
                stage["count"] = counted
                stage["source"] = "stock"
                stage["hint"] = "Parts with a counted quantity on the shelf"

        return {
            "stages": stages,
            "srv_total": sum(by_status.values()),
            "by_status": by_status,
            "not_captured": NOT_CAPTURED,
        }

    def pending_summary(self, store_code):
        """The SRV Pending KPI, split so the number can be explained: waiting
        for an SRV to be raised, versus waiting on an engineer."""
        by_status = self.srv_repo.count_by_status_for_store(store_code)
        awaiting_srv = sum(by_status.get(s, 0) for s in PENDING_SRV_STATUSES)
        awaiting_clearance = sum(by_status.get(s, 0) for s in PENDING_CLEARANCE_STATUSES)
        return {
            "awaiting_srv": awaiting_srv,
            "awaiting_clearance": awaiting_clearance,
            "total": awaiting_srv + awaiting_clearance,
            # Real, from tool_room_cleared_at. Maintenance has no such field.
            "tool_room": {
                "pending": by_status.get("FORWARDED_TOOL_ROOM", 0),
                "cleared": self._tool_room_cleared(store_code),
            },
            "maintenance": None,
            "not_captured": {"maintenance": NOT_CAPTURED["maintenance_clearance"]},
        }

    def clearance_rate(self, store_code):
        """Cleared SRV lines against every line that has reached the stage of
        needing clearance. None when there are no SRVs at all — a clearance
        rate with nothing to clear is not 0%, it is unmeasured."""
        by_status = self.srv_repo.count_by_status_for_store(store_code)
        total = sum(by_status.values())
        pending = sum(by_status.get(s, 0) for s in PENDING_CLEARANCE_STATUSES)
        cleared = self._tool_room_cleared(store_code)
        denominator = cleared + pending
        return {
            "pct": round(cleared / denominator * 100, 1) if denominator else None,
            "cleared": cleared,
            "pending": pending,
            "srv_total": total,
        }

    def _tool_room_cleared(self, store_code):
        from app.extensions import db
        from app.models.part import Part
        from sqlalchemy import func
        return (
            db.session.query(func.count(SRV.id))
            .join(Part, Part.id == SRV.part_id)
            .filter(Part.store_code == store_code, SRV.tool_room_cleared_at.isnot(None))
            .scalar() or 0
        )

    def list_pending(self, store_code, kind="all", limit=None):
        statuses = {
            "srv": PENDING_SRV_STATUSES,
            "clearance": PENDING_CLEARANCE_STATUSES,
        }.get(kind, PENDING_SRV_STATUSES + PENDING_CLEARANCE_STATUSES)
        return [{
            "id": s.id,
            "srv_no": s.srv_no,
            "part_no": s.part_no,
            "part_name": s.part_name,
            "supplier_name": s.supplier_name or s.vendor_code,
            "invoice_no": s.invoice_no,
            "gate_entry_no": s.gate_entry_no,
            "gate_entry_time": s.gate_entry_time.isoformat() if s.gate_entry_time else None,
            "qty_invoiced": float(s.qty_invoiced) if s.qty_invoiced is not None else None,
            "qty_received": float(s.qty_received) if s.qty_received is not None else None,
            "status": s.status,
        } for s in self.srv_repo.list_for_store_by_statuses(store_code, statuses, limit)]

    def _gate_history(self, part_no):
        """This part's arrival history, read live from ERP gate entries.

        A part is not tied to one supplier — the same item_code arrives from
        several vendors over time (e.g. a taper pin from three traders). Its
        identity is the part_no (= ERP item_code); the suppliers are whoever the
        gate entries say brought it. So this is derived, never stored.

        Returns (arrivals, suppliers): `arrivals` is every gate entry — when it
        came and from whom, newest first; `suppliers` rolls those up per vendor.
        One query feeds both."""
        if not part_no:
            return [], []
        rows = (GateEntry.query
                .filter(db.func.upper(GateEntry.item_code) == part_no.upper())
                .order_by(GateEntry.gate_entry_dt.desc(), GateEntry.id.desc())
                .all())
        arrivals = []
        agg = {}
        for r in rows:
            dt = r.gate_entry_dt.isoformat() if r.gate_entry_dt else None
            qty = float(r.qty) if r.qty is not None else None
            arrivals.append({
                "gate_entry_dt": dt,
                # The gate clock reading as ERP typed it (plant time, text) —
                # shown as-is, never merged into the date as if it were UTC.
                "gate_entry_time": r.gate_entry_time,
                "gate_entry_no": r.gate_entry_no,
                "ven_cd": r.ven_cd,
                "ven_name": (r.ven_name or r.ven_cd),
                "qty": qty,
                "bill_no": r.bill_no,
                "po_no": r.po_no,
            })
            key = (r.ven_cd or r.ven_name or "").strip() or "—"
            a = agg.get(key)
            if a is None:
                a = agg[key] = {
                    "ven_cd": r.ven_cd, "ven_name": (r.ven_name or r.ven_cd),
                    "arrivals": 0, "total_qty": 0.0,
                    "first_dt": None, "last_dt": None,
                }
            a["arrivals"] += 1
            if qty is not None:
                a["total_qty"] += qty
            if dt:
                if a["last_dt"] is None or dt > a["last_dt"]:
                    a["last_dt"] = dt
                if a["first_dt"] is None or dt < a["first_dt"]:
                    a["first_dt"] = dt
        suppliers = sorted(agg.values(),
                           key=lambda x: (x["last_dt"] or "", x["arrivals"]),
                           reverse=True)
        return arrivals, suppliers

    def _grn_events(self, part_no):
        """The GRN / material-received events from the ERP receiving register —
        what was formally received into stores and how much was accepted vs
        rejected. Keyed on item_cd = part_no, newest first. ERP leaves the
        accepted qty empty until its quality accepts the line, so accept_qty is
        None then — never the received qty standing in for it."""
        if not part_no:
            return []
        rows = (ReceivingRegister.query
                .filter(db.func.upper(ReceivingRegister.item_cd) == part_no.upper())
                .order_by(ReceivingRegister.grn_date.desc(), ReceivingRegister.id.desc())
                .all())
        out = []
        for r in rows:
            reject = float(r.reject_qty) if r.reject_qty is not None else 0.0
            out.append({
                "ts": r.grn_date.isoformat() if r.grn_date else None,
                "grn_no": r.grn_no, "challan_no": r.challan_no, "po_no": r.po_no,
                "ven_cd": r.ven_cd, "ven_name": (r.ven_name or r.ven_cd),
                "receipt_qty": float(r.receipt_qty) if r.receipt_qty is not None else None,
                "accept_qty": float(r.accept_qty) if r.accept_qty is not None else None,
                "reject_qty": reject,
            })
        return out

    @staticmethod
    def _booked_grns(movements):
        """The store's own GRN-backed RECEIPT rows and the GRN numbers they were
        booked against: an ERP-accepted GRN line the ERP sync added or an
        in-app quality clearance (reference = the GRN no.), or an RGP GRN (its
        journal row carries the GRN no.). ERP's GRN row with the same number is
        that same receipt seen from ERP."""
        booked = [m for m in movements
                  if m.txn_type == "RECEIPT" and getattr(m, "status", None) in ERP_ORIGIN_RECEIPT_STATUSES]
        nos = {m.reference.strip().upper() for m in booked
               if m.status in GRN_BOOKED_STATUSES and m.reference}
        ids = [m.id for m in booked]
        if ids:
            for (grn_no,) in (db.session.query(SpareTransaction.grn_no)
                              .filter(SpareTransaction.ledger_id.in_(ids),
                                      SpareTransaction.grn_no.isnot(None)).all()):
                nos.add(grn_no.strip().upper())
        return booked, nos

    def _unify_ledger(self, movements, gate_arrivals, grn_events):
        """One chronological ledger for the part — every event on one timeline:
        material arriving at the gate, being received into stores (GRN, with
        accept/reject), the opening count, each issue (to which department /
        person / machine / line), returns and corrections. Newest first. Merges
        the ERP gate + GRN feeds with the store's own stock ledger so nothing
        about the part's life is on a separate screen.

        Gate entry and GRN are two stages of the SAME receipt, so counting both
        as stock-in would double the received total: where a GRN exists it is the
        counted "Received", and the gate row is shown only as an "Arrival" marker
        (direction 'arrival', not summed). A part with no GRN keeps its gate
        arrivals as the counted inflow, so nothing is lost.

        The same holds one step later: once a GRN's accepted quantity is booked
        into stock (the RECEIPT row the ERP sync writes for an ERP-accepted GRN
        line — or an older in-app quality clearance — which carries the
        balance), ERP's RECEIVED row for that GRN number is the same material
        again — it stays on the timeline as a marker (direction 'matched', not
        summed), and a GRN-backed stock-in counts as the GRN for the gate rule.
        A GRN line ERP's quality has not accepted is not stock at all: it shows
        its received qty as 'pending' (or 'rejected'), never summed."""
        sup_ids = {m.supplier_id for m in movements if getattr(m, "supplier_id", None)}
        sup_map = {}
        if sup_ids:
            for s in Supplier.query.filter(Supplier.id.in_(sup_ids)).all():
                sup_map[s.id] = {"name": s.supplier_name, "code": s.vendor_code}

        booked, booked_grns = self._booked_grns(movements)
        # RGP GRN rows are reworked material coming back, not a supplier
        # delivery, so only a GRN-backed stock-in stands in for a missing ERP
        # GRN (the mirror keeps a limited window).
        has_grn = bool(grn_events) or any(m.status in GRN_BOOKED_STATUSES for m in booked)
        entries = []
        for a in gate_arrivals:
            entries.append({
                "ts": a["gate_entry_dt"], "kind": "GATE_ARRIVAL",
                "direction": "arrival" if has_grn else "in",
                "qty": a["qty"], "balance_after": None,
                "supplier_name": a["ven_name"], "supplier_code": a["ven_cd"],
                "reference": a["gate_entry_no"], "po_no": a["po_no"],
                "invoice_no": a["bill_no"],
                "department": None, "issued_to": None, "machine": None, "line": None,
                "remarks": None, "by": None, "status": None,
            })
        for g in grn_events:
            rej = g["reject_qty"]
            matched = bool(g["grn_no"]) and g["grn_no"].strip().upper() in booked_grns
            # A line ERP's quality has not accepted is not stock: shown with
            # what was received, never summed as an inflow.
            undecided = g["accept_qty"] is None
            if matched:
                direction = "matched"
            elif undecided:
                direction = "rejected" if rej else "pending"
            else:
                direction = "in"
            notes = [f"{int(rej) if rej == int(rej) else rej} rejected" if rej else None,
                     "quality pending in ERP — not stock yet" if direction == "pending" else None,
                     "counted on the store's own stock-in row" if matched else None]
            entries.append({
                "ts": g["ts"], "kind": "RECEIVED", "direction": direction,
                "qty": g["receipt_qty"] if undecided else g["accept_qty"], "balance_after": None,
                "supplier_name": g["ven_name"], "supplier_code": g["ven_cd"],
                "reference": g["grn_no"], "po_no": g["po_no"],
                "invoice_no": g["challan_no"],
                "department": None, "issued_to": None, "machine": None, "line": None,
                "remarks": " · ".join(n for n in notes if n) or None,
                "by": None, "status": None,
            })
        for m in movements:
            delta = float(m.qty_delta)
            if m.txn_type == "OPENING":
                direction = "count"
            elif delta > 0:
                direction = "in"
            elif delta < 0:
                direction = "out"
            else:
                direction = "count"
            ln, lno = getattr(m, "line_name", None), getattr(m, "line_no", None)
            line = " ".join(str(x) for x in (ln, lno) if x) or None
            sup = sup_map.get(getattr(m, "supplier_id", None))
            entries.append({
                "ts": m.created_at.isoformat() if m.created_at else None,
                "kind": m.txn_type, "direction": direction,
                "qty": delta,
                "balance_after": float(m.balance_after) if m.balance_after is not None else None,
                "supplier_name": sup["name"] if sup else None,
                "supplier_code": sup["code"] if sup else None,
                # The store return slip (RET-…) shows in place of the reference on
                # a RETURN row; every other row keeps its own reference.
                "reference": (getattr(m, "return_no", None) or m.reference) if m.txn_type == "RETURN" else m.reference,
                "po_no": None,
                "invoice_no": getattr(m, "invoice_no", None),
                "department": getattr(m, "department", None),
                # On a RETURN row, issued_to carries the person who returned it so
                # the ledger reads "back from <name>" without a new column here.
                "issued_to": getattr(m, "returned_by", None) if m.txn_type == "RETURN" else getattr(m, "issued_to", None),
                "machine": getattr(m, "machine", None),
                "line": line,
                "remarks": (getattr(m, "return_reason", None) or m.remarks) if m.txn_type == "RETURN" else m.remarks,
                "by": m.created_by,
                "status": getattr(m, "status", None),
            })
        entries.sort(key=lambda e: (e["ts"] or ""), reverse=True)
        return entries

    def traceability(self, part_id):
        """One part's chain, end to end. Each step says whether it has data —
        an empty step is shown as "nothing recorded", never skipped, because a
        gap in the chain is itself the answer someone is looking for."""
        part = self.part_repo.get_by_id(part_id)
        if not part:
            raise NotFoundError(f"Part {part_id} not found")

        receipts = self.srv_repo.search(part_id=part_id).limit(25).all()
        stock = self.stock_repo.get_by_part(part_id)
        # The part's WHOLE ledger, not the latest 25: the Part Ledger's received
        # / issued totals and the issue count are summed from these rows, and a
        # truncated list would quietly under-report them. One part's history is
        # a few hundred rows at most.
        moves = (SpareStockLedger.query.filter_by(part_id=part_id)
                 .order_by(SpareStockLedger.created_at.desc(), SpareStockLedger.id.desc())
                 .all())
        gate_arrivals, gate_suppliers = self._gate_history(part.part_no)
        grn_events = self._grn_events(part.part_no)

        return {
            "part": {
                "id": part.id, "part_no": part.part_no, "part_name": part.part_name,
                "uom": part.uom, "location": part.location,
                "min_stock_level": float(part.min_stock_level or 0),
                "max_stock_level": float(part.max_stock_level) if part.max_stock_level is not None else None,
                "unit_price": float(part.unit_price) if part.unit_price is not None else None,
                # A part is not tied to one supplier — see gate_suppliers below,
                # which is the live list. This stays only as an optional default.
                "supplier_id": part.supplier_id,
            },
            # Suppliers derived live from ERP gate entries (item_code match) —
            # a part can have several, so this is a list, newest arrival first.
            "gate_suppliers": gate_suppliers,
            # The full arrival log: when this part came and from whom, each gate
            # entry a row, newest first. Answers "kab-kab, kis-kis se aaya".
            "gate_arrivals": gate_arrivals,
            # The whole part ledger on one timeline — arrivals + GRN receipts +
            # opening + issues (to dept/person/machine) + returns + corrections,
            # newest first.
            "ledger": self._unify_ledger(moves, gate_arrivals, grn_events),
            "receipts": [{
                "srv_no": s.srv_no,
                "supplier_name": s.supplier_name or s.vendor_code,
                "invoice_no": s.invoice_no,
                "gate_entry_no": s.gate_entry_no,
                "gate_entry_time": s.gate_entry_time.isoformat() if s.gate_entry_time else None,
                "verified_at": s.verified_at.isoformat() if s.verified_at else None,
                "srv_created_at": s.srv_created_at.isoformat() if s.srv_created_at else None,
                "tool_room_cleared_at": s.tool_room_cleared_at.isoformat() if s.tool_room_cleared_at else None,
                "stored_at": s.stored_at.isoformat() if s.stored_at else None,
                "consumed_at": s.consumed_at.isoformat() if s.consumed_at else None,
                "qty_received": float(s.qty_received) if s.qty_received is not None else None,
                "status": s.status,
            } for s in receipts],
            "stock": {
                "qty_on_hand": float(stock.qty_on_hand) if stock else None,
                "last_counted_at": stock.last_counted_at.isoformat() if stock and stock.last_counted_at else None,
            },
            "movements": [{
                "at": m.created_at.isoformat() if m.created_at else None,
                "txn_type": m.txn_type,
                "qty_delta": float(m.qty_delta),
                "balance_after": float(m.balance_after),
                "reference": m.reference,
                "remarks": m.remarks,
                "created_by": m.created_by,
            } for m in moves],
            "not_captured": NOT_CAPTURED,
        }
