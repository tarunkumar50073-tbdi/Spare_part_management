"""Pending RGP (Returnable Gate Pass) — the report the store carries and the
'Pending RGP' count the Live Dashboard shows. ERP is the eventual source; rows
can be created / snapshot-synced here, and the pending count is real either way.
"""
from app.models.rgp import RGP
from app.repositories.rgp_repository import RGPRepository


class RGPService:
    def __init__(self):
        self.repo = RGPRepository()

    def list_rgps(self, store_code, pending_only=False):
        return [r.to_dict() for r in self.repo.list_for_store(store_code, pending_only=pending_only)]

    def pending_count(self, store_code=None):
        return self.repo.pending_count(store_code)

    def create_rgp(self, data):
        return self.repo.create(**data).to_dict()

    def replace_from_rows(self, store_code, rows):
        """Replace a store's RGP snapshot with `rows` (list of dicts) — the shape
        an ERP sync / Excel import will use. Fills Balance Qty from Challan −
        Receipt when it isn't supplied."""
        insts = []
        for r in rows:
            d = {k: v for k, v in r.items() if k != "store_code"}
            if d.get("balance_qty") is None and d.get("challan_qty") is not None:
                d["balance_qty"] = float(d["challan_qty"]) - float(d.get("receipt_qty") or 0)
            insts.append(RGP(store_code=store_code, **d))
        return self.repo.replace_all(store_code, insts)
