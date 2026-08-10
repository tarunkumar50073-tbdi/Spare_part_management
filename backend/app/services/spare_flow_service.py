"""The Spare Parts Store's own material flow, and one part's traceability.

The plant's spare process is:

    Supplier -> Gate Entry -> Material Received -> Physical Verification
    -> SRV/GRN -> Maintenance / Tool Room ERP -> Engineer Clearance
    -> Store Stock -> Issue -> ERP Consumption

Every stage below is read from data that actually exists. Two of them cannot
be: see NOT_CAPTURED. Nothing here invents a count to fill a gap — a stage with
no source reports that it has none, because a fabricated zero and a real zero
look identical on a screen and mean opposite things.
"""
from app.models.srv import SRV
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
    ("srv_created", "SRV / GRN Created", ["SRV_CREATED"]),
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
# point later knows exactly what is wanted.
NOT_CAPTURED = {
    "maintenance_clearance":
        "SRV has a Tool Room forward and clearance timestamp but no Maintenance "
        "equivalent, so Maintenance pending/cleared cannot be split out yet.",
    "issue_department":
        "Nothing records which department an issue went to, so Press Shop / "
        "Maintenance / Tool Room consumption cannot be reported.",
}


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

    def traceability(self, part_id):
        """One part's chain, end to end. Each step says whether it has data —
        an empty step is shown as "nothing recorded", never skipped, because a
        gap in the chain is itself the answer someone is looking for."""
        part = self.part_repo.get_by_id(part_id)
        if not part:
            raise NotFoundError(f"Part {part_id} not found")

        receipts = self.srv_repo.search(part_id=part_id).limit(25).all()
        stock = self.stock_repo.get_by_part(part_id)
        moves = self.ledger_repo.list_for_part(part_id, 25)

        return {
            "part": {
                "id": part.id, "part_no": part.part_no, "part_name": part.part_name,
                "uom": part.uom, "location": part.location,
                "min_stock_level": float(part.min_stock_level or 0),
                "max_stock_level": float(part.max_stock_level) if part.max_stock_level is not None else None,
                "unit_price": float(part.unit_price) if part.unit_price is not None else None,
                # Every spare is currently unmapped to a supplier, so this is
                # usually None. Said plainly rather than left blank.
                "supplier_id": part.supplier_id,
            },
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
