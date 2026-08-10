"""Live part stock + movement ledger data access layer."""
from sqlalchemy import func
from app.extensions import db
from app.models.store_stock import PartStock, StockLedger
from app.repositories.base_repository import BaseRepository
from app.utils.db_tx import maybe_commit


class PartStockRepository(BaseRepository):
    model = PartStock

    def get_or_create(self, part_id, location):
        row = self.model.query.filter_by(part_id=part_id, location=location).first()
        if not row:
            row = self.model(part_id=part_id, location=location, qty_on_hand=0)
            db.session.add(row)
            db.session.flush()
        return row

    def adjust(self, part_id, location, qty_delta):
        row = self.get_or_create(part_id, location)
        new_qty = (row.qty_on_hand or 0) + qty_delta
        if new_qty < 0:
            # Stock can never physically go negative — a double consumption,
            # a replayed ERP call, or a wrong quantity would otherwise leave
            # a silent negative that poisons every downstream COV / Short /
            # Excess figure. Fail loudly so the enclosing atomic() rolls back.
            from app.utils.exceptions import BadRequestError
            raise BadRequestError(
                f"Insufficient stock: {location} for part {part_id} has {row.qty_on_hand or 0}, "
                f"cannot apply {qty_delta}"
            )
        row.qty_on_hand = new_qty
        maybe_commit()
        return row

    def list_by_part(self, part_id):
        return self.model.query.filter_by(part_id=part_id).all()

    def list_all(self):
        return self.model.query.all()


class StockLedgerRepository(BaseRepository):
    model = StockLedger

    def record(self, part_id, location, qty_delta, reason, srv_id=None, production_receipt_id=None,
               source_type=None, ext_ref=None, created_at=None):
        kwargs = dict(
            part_id=part_id, location=location, qty_delta=qty_delta, reason=reason,
            srv_id=srv_id, production_receipt_id=production_receipt_id, source_type=source_type,
            ext_ref=ext_ref,
        )
        # Historical imports stamp the real ERP transaction date; live moves
        # leave it None so BaseModel's default (now) applies.
        if created_at is not None:
            kwargs["created_at"] = created_at
        return self.create(**kwargs)

    def existing_ext_refs(self):
        """Set of all external references already in the ledger — the dedupe
        guard for ERP-ledger imports and later ERP API pushes."""
        rows = (
            db.session.query(self.model.ext_ref)
            .filter(self.model.ext_ref.isnot(None))
            .all()
        )
        return {r[0] for r in rows}

    def list_by_part(self, part_id):
        return self.model.query.filter_by(part_id=part_id).order_by(self.model.created_at.desc()).all()

    def consumption_history_by_part(self, part_id):
        """Full PRODUCTION_CONSUMPTION history for one part, newest first —
        powers the PartDetailModal consumption tab."""
        return (
            self.model.query
            .filter_by(part_id=part_id, reason="PRODUCTION_CONSUMPTION")
            .order_by(self.model.created_at.desc())
            .all()
        )

    def todays_consumption_rows(self, on_date):
        """Today's Issue detail list: every PRODUCTION_CONSUMPTION ledger
        row for on_date, joined to Part for display fields."""
        from app.models.part import Part
        rows = (
            db.session.query(self.model, Part.part_no, Part.part_name)
            .join(Part, Part.id == self.model.part_id)
            .filter(self.model.reason == "PRODUCTION_CONSUMPTION")
            .filter(func.date(self.model.created_at) == on_date)
            .order_by(self.model.created_at.desc())
            .all()
        )
        return [
            {
                "part_id": ledger.part_id, "part_no": part_no, "part_name": part_name,
                "qty": float(-ledger.qty_delta), "time": ledger.created_at.isoformat(),
                "srv_id": ledger.srv_id,
            }
            for ledger, part_no, part_name in rows
        ]

    def count_todays_consumption(self, on_date):
        return (
            db.session.query(func.count(self.model.id))
            .filter(self.model.reason == "PRODUCTION_CONSUMPTION")
            .filter(func.date(self.model.created_at) == on_date)
            .scalar()
        ) or 0

    def source_breakdown_map(self):
        """part_id -> {"purchased_qty": cumulative BUY receipts, "inhouse_qty":
        cumulative MAKE receipts} — one grouped query for every part, batched
        the same way COVService.get_latest_map()/PartSupplierRepository.map_by_part()
        are, to avoid an N+1 loop over parts."""
        from sqlalchemy import func
        rows = (
            db.session.query(self.model.part_id, self.model.source_type, func.sum(self.model.qty_delta))
            .filter(self.model.source_type.isnot(None))
            .group_by(self.model.part_id, self.model.source_type)
            .all()
        )
        result = {}
        for part_id, source_type, total in rows:
            bucket = result.setdefault(part_id, {"purchased_qty": 0.0, "inhouse_qty": 0.0})
            key = "purchased_qty" if source_type == "BUY" else "inhouse_qty"
            bucket[key] = float(total or 0)
        return result

    def source_breakdown_monthly(self, part_id, months=6):
        """Per-calendar-month BUY vs MAKE receipts for one part, newest month
        first, capped to the last `months` months that actually have activity.
        Same BUY/MAKE split as source_breakdown_map(), but sliced by month so
        the numbers can be read against the (separate, monthly) BOP purchase
        and in-house production schedules. Bucketed in Python so it stays
        DB-agnostic — per-part row volume is small."""
        rows = (
            self.model.query
            .filter(self.model.part_id == part_id, self.model.source_type.isnot(None))
            .with_entities(self.model.created_at, self.model.source_type, self.model.qty_delta)
            .all()
        )
        buckets = {}
        for created_at, source_type, qty_delta in rows:
            key = created_at.strftime("%Y-%m")
            bucket = buckets.setdefault(key, {"month": key, "purchased_qty": 0.0, "inhouse_qty": 0.0})
            field = "purchased_qty" if source_type == "BUY" else "inhouse_qty"
            bucket[field] += float(qty_delta or 0)
        ordered = sorted(buckets.values(), key=lambda b: b["month"], reverse=True)
        return ordered[:months]

    def daily_movement(self, since_date):
        """Daily Stock Movement chart — total qty in vs out per day since the given date."""
        from sqlalchemy import func, case
        from app.extensions import db
        rows = (
            db.session.query(
                func.date(self.model.created_at).label("day"),
                func.sum(case((self.model.qty_delta > 0, self.model.qty_delta), else_=0)).label("qty_in"),
                func.sum(case((self.model.qty_delta < 0, -self.model.qty_delta), else_=0)).label("qty_out"),
            )
            .filter(func.date(self.model.created_at) >= since_date)
            .group_by(func.date(self.model.created_at))
            .order_by(func.date(self.model.created_at))
            .all()
        )
        return [{"day": str(r.day), "qty_in": float(r.qty_in or 0), "qty_out": float(r.qty_out or 0)} for r in rows]
