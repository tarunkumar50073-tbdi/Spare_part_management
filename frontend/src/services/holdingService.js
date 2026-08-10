import api from "./api";

export const holdingService = {
  list: (params) => api.get("/holding", { params }),
  transfer: (id, payload) => api.post(`/holding/${id}/transfer`, payload),
  history: (id) => api.get(`/holding/${id}/history`),
};
