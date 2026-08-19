"""Receiving Register (PO base) — a part's GRN receiving history: what came in,
when, from whom, accepted vs rejected. ERP will feed it; the shape is stable."""
from app.models.receiving_register import ReceivingRegister
from app.repositories.receiving_register_repository import ReceivingRegisterRepository


class ReceivingRegisterService:
    def __init__(self):
        self.repo = ReceivingRegisterRepository()

    def list_rows(self, store_code=None, item_cd=None, limit=None):
        return [r.to_dict() for r in self.repo.list_rows(store_code, item_cd, limit)]

    def item_history(self, item_cd, store_code=None):
        """One part's full receipt timeline, with accept/reject totals."""
        rows = [r.to_dict() for r in self.repo.list_rows(store_code, item_cd)]
        totals = {
            "receipts": len(rows),
            "receipt_qty": round(sum(r["receipt_qty"] or 0 for r in rows), 2),
            "accept_qty": round(sum(r["accept_qty"] or 0 for r in rows), 2),
            "reject_qty": round(sum(r["reject_qty"] or 0 for r in rows), 2),
        }
        return {"item_cd": item_cd, "rows": rows, "totals": totals}

    def replace_from_rows(self, store_code, rows):
        """Replace a store's snapshot with `rows` (list of dicts) — the ERP sync
        / import path."""
        insts = [ReceivingRegister(store_code=store_code, **{k: v for k, v in r.items() if k != "store_code"})
                 for r in rows]
        return self.repo.replace_all(store_code, insts)
