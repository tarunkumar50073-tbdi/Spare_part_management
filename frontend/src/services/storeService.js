import api from "./api";

export const storeService = {
  // `summary=1` adds the part/short/excess counts the dashboard cards show.
  list: (withSummary) => api.get("/stores", { params: withSummary ? { summary: 1 } : {} }),
  sections: (storeCode) => api.get(`/stores/${storeCode}/sections`),
  createSection: (storeCode, payload) => api.post(`/stores/${storeCode}/sections`, payload),
  updateSection: (sectionId, payload) => api.put(`/stores/sections/${sectionId}`, payload),
};
