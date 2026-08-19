import api from "./api";

// Pending RGP (Returnable Gate Pass). Real app data now; ERP will feed the same
// endpoints later. "pending" = Balance Qty still greater than 0.
export const rgpService = {
  pendingCount: (storeCode) => api.get("/rgp/pending-count", { params: { store_code: storeCode } }),
  list: (storeCode, pendingOnly) =>
    api.get("/rgp", { params: { store_code: storeCode, pending: pendingOnly ? 1 : undefined } }),
  create: (payload) => api.post("/rgp", payload),
};
