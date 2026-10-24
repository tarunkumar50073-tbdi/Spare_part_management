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
  // Racks / categories / sub categories of the store (and section), with counts.
  filterOptions: (params) => api.get("/parts/filter-options", { params }),
  // The part's one photo (21 Oct 2026): upload replaces it, remove clears it.
  uploadImage: (id, blob) => {
    const formData = new FormData();
    formData.append("file", blob, "photo.jpg");
    return api.post(`/parts/${id}/image`, formData, { headers: { "Content-Type": "multipart/form-data" } });
  },
  removeImage: (id) => api.delete(`/parts/${id}/image`),
  // For an <img src>: the session cookie goes with it. `v` is the file name,
  // new with every photo, so a cached old picture is never shown.
  imageUrl: (part, thumb = false) =>
    part?.image_file
      ? `${api.defaults.baseURL}/parts/${part.id}/image?v=${encodeURIComponent(part.image_file)}${thumb ? "&size=thumb" : ""}`
      : null,
};
