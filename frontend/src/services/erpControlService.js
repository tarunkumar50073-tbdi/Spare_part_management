import api from "./api";

// ERP Control Center (/api/v1/erp-control) — one read-only status call.
export const erpControlService = {
  // data = { generated_at, stock_snapshot, db_sync, ledger_inbox, write_back, reconciliation, data_sources }
  status: (storeCode) => api.get("/erp-control/status", { params: { store_code: storeCode } }),
  // Read every ERP table now (read only on ERP); a read already running is not started twice.
  syncNow: () => api.post("/erp-control/sync-now"),
};
