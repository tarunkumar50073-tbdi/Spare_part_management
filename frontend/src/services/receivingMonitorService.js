import api from "./api";

// Receiving & GRN (/api/v1/receiving-monitor): ERP GRN lines, the store's own
// receipts, the SRV pipeline and gate arrivals with no receipt, in one read.
export const receivingMonitorService = {
  monitor: (storeCode, days) =>
    api.get("/receiving-monitor", { params: { store_code: storeCode, days } }),
};
