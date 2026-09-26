import api from "./api";

// ERP Control Center (/api/v1/erp-control) — one read-only status call.
export const erpControlService = {
  // data = { generated_at, stock_snapshot, db_sync, ledger_inbox, write_back, reconciliation, data_sources }
  status: (storeCode) => api.get("/erp-control/status", { params: { store_code: storeCode } }),
};
