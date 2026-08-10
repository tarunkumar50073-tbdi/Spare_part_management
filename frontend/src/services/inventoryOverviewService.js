import api from "./api";

export const inventoryOverviewService = {
  categories: () => api.get("/inventory-overview/categories"),
  list: (params) => api.get("/inventory-overview", { params }),
  valueByCategory: () => api.get("/inventory-overview/value-by-category"),
  stockStatusSummary: () => api.get("/inventory-overview/stock-status-summary"),
  topShortParts: () => api.get("/inventory-overview/top-short-parts"),
};
