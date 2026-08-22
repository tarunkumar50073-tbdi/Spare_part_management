import api from "./api";

export const partService = {
  list: (params) => api.get("/parts", { params }),
  // Counts for the Missing Max / Rate / Location chips, in one call.
  missingCounts: (params) => api.get("/parts/missing-counts", { params }),
  get: (id) => api.get(`/parts/${id}`),
  create: (payload) => api.post("/parts", payload),
  update: (id, payload) => api.put(`/parts/${id}`, payload),
  remove: (id) => api.delete(`/parts/${id}`),
  // store_code/section_id ride along as form fields so rows created by the
  // upload land in the store it was uploaded from rather than nowhere.
  import: (file, { store_code, section_id } = {}) => {
    const formData = new FormData();
    formData.append("file", file);
    if (store_code) formData.append("store_code", store_code);
    if (section_id) formData.append("section_id", section_id);
    return api.post("/parts/import", formData, { headers: { "Content-Type": "multipart/form-data" } });
  },
  // Dry-run before committing: per-row INSERT/UPDATE/ERROR + counts.
  previewImport: (file) => {
    const formData = new FormData();
    formData.append("file", file);
    return api.post("/parts/import/preview", formData, { headers: { "Content-Type": "multipart/form-data" } });
  },
  importHistory: (limit) => api.get("/parts/import/history", { params: { limit } }),
};
