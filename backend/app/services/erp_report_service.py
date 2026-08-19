"""Current Stock / Pending GRN / Stock Valuation — read-only ERP report mirrors.
ERP will feed them; the shapes stay stable. Current Stock is the ERP on-hand the
ERP-vs-Physical gap should reconcile against."""
from app.extensions import db
from app.models.current_stock import CurrentStock
from app.models.pending_grn import PendingGRN
from app.models.stock_valuation import StockValuation


def _replace(model, store_code, rows):
    model.query.filter_by(store_code=store_code).delete()
    db.session.add_all([
        model(store_code=store_code, **{k: v for k, v in r.items() if k != "store_code"}) for r in rows
    ])
    db.session.commit()
    return len(rows)


class ERPReportService:
    # ---- Current Stock (ERP on-hand) ----
    def current_stock(self, store_code=None, item_cd=None, limit=None):
        q = CurrentStock.query
        if store_code:
            q = q.filter_by(store_code=store_code)
        if item_cd:
            q = q.filter_by(item_cd=item_cd)
        q = q.order_by(CurrentStock.item_cd.asc())
        rows = q.limit(limit).all() if limit else q.all()
        return [r.to_dict() for r in rows]

    def replace_current_stock(self, store_code, rows):
        return _replace(CurrentStock, store_code, rows)

    # ---- Pending GRN For Inspection ----
    def pending_grn(self, store_code=None, limit=None):
        q = PendingGRN.query
        if store_code:
            q = q.filter_by(store_code=store_code)
        q = q.order_by(PendingGRN.pending_days.desc(), PendingGRN.id.desc())
        rows = q.limit(limit).all() if limit else q.all()
        return [r.to_dict() for r in rows]

    def pending_grn_count(self, store_code=None):
        q = PendingGRN.query
        if store_code:
            q = q.filter_by(store_code=store_code)
        return q.count()

    def replace_pending_grn(self, store_code, rows):
        return _replace(PendingGRN, store_code, rows)

    # ---- Stock Valuation (Std. Rate) ----
    def stock_valuation(self, store_code=None, item_cd=None, limit=None):
        q = StockValuation.query
        if store_code:
            q = q.filter_by(store_code=store_code)
        if item_cd:
            q = q.filter_by(item_cd=item_cd)
        q = q.order_by(StockValuation.tran_dt.desc(), StockValuation.id.desc())
        rows = q.limit(limit).all() if limit else q.all()
        return [r.to_dict() for r in rows]

    def replace_stock_valuation(self, store_code, rows):
        return _replace(StockValuation, store_code, rows)
