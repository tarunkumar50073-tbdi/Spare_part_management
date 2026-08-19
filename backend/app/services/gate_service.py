"""Gate Entry / Gate Exit — vehicle in-time / out-time and material arrival
history. Read-only ERP mirrors; ERP will feed them, the shapes stay stable."""
from app.extensions import db
from app.models.gate_entry import GateEntry
from app.models.gate_exit import GateExit


def _replace(model, store_code, rows):
    model.query.filter_by(store_code=store_code).delete()
    db.session.add_all([
        model(store_code=store_code, **{k: v for k, v in r.items() if k != "store_code"}) for r in rows
    ])
    db.session.commit()
    return len(rows)


class GateService:
    def list_entries(self, store_code=None, item_code=None, limit=None):
        q = GateEntry.query
        if store_code:
            q = q.filter_by(store_code=store_code)
        if item_code:
            q = q.filter_by(item_code=item_code)
        q = q.order_by(GateEntry.gate_entry_dt.desc(), GateEntry.id.desc())
        rows = q.limit(limit).all() if limit else q.all()
        return [r.to_dict() for r in rows]

    def item_arrivals(self, item_code, store_code=None):
        """When did this item come in — its gate-entry arrival history."""
        rows = self.list_entries(store_code, item_code)
        return {"item_code": item_code, "arrivals": len(rows), "rows": rows}

    def list_exits(self, store_code=None, vehicle_number=None, limit=None):
        q = GateExit.query
        if store_code:
            q = q.filter_by(store_code=store_code)
        if vehicle_number:
            q = q.filter_by(vehicle_number=vehicle_number)
        q = q.order_by(GateExit.gate_exit_date.desc(), GateExit.id.desc())
        rows = q.limit(limit).all() if limit else q.all()
        return [r.to_dict() for r in rows]

    def replace_entries(self, store_code, rows):
        return _replace(GateEntry, store_code, rows)

    def replace_exits(self, store_code, rows):
        return _replace(GateExit, store_code, rows)
