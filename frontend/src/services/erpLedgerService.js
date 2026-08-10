import api from "./api";

export const erpLedgerService = {
  import: (file) => {
    const formData = new FormData();
    formData.append("file", file);
    return api.post("/store/dashboard/erp-ledger/import", formData, {
      headers: { "Content-Type": "multipart/form-data" },
    });
  },
  inboxStatus: () => api.get("/store/dashboard/erp-ledger/inbox-status"),
  scanNow: () => api.post("/store/dashboard/erp-ledger/scan-now"),
};
