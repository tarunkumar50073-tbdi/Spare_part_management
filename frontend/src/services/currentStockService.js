import api from "./api";

// Current Stock — ERP's real on-hand per item (read-only ERP mirror). Populates
// when ERP exposes the Current Stock source table.
export const currentStockService = {
  list: (params) => api.get("/current-stock", { params }),
};
