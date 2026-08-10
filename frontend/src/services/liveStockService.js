import api from "./api";

export const liveStockService = {
  list: (params) => api.get("/live-stock", { params }),
  short: (params) => api.get("/live-stock/short", { params }),
  excess: () => api.get("/live-stock/excess"),
  topOldestExcess: () => api.get("/live-stock/excess/top-oldest"),
};
