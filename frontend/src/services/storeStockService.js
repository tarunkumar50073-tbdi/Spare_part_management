import api from "./api";

export const storeStockService = {
  summary: () => api.get("/store/stock"),
};
