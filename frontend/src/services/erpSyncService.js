import api from "./api";

// ERP report-mirror sync (read-only pull from the plant ERP DB, schema termsdb).
export const erpSyncService = {
  run: () => api.post("/erp/sync"),
  status: () => api.get("/erp/sync/status"),
  ping: () => api.get("/erp/sync/ping"),
};
