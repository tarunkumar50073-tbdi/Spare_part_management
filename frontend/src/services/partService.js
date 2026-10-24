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
  // The part's photos — up to 3 angles, the first the main one (24 Oct 2026).
  // An upload replaces them all; remove takes out photo `n`, or all of them.
  uploadImages: (id, blobs) => {
    const formData = new FormData();
    blobs.forEach((blob, i) => formData.append("file", blob, `photo-${i + 1}.jpg`));
    return api.post(`/parts/${id}/image`, formData, { headers: { "Content-Type": "multipart/form-data" } });
  },
  uploadImage: (id, blob) => partService.uploadImages(id, [blob]),
  removeImage: (id, n) => api.delete(`/parts/${id}/image`, { params: n == null ? undefined : { n } }),
  // The file names of the part's photos, main first. A row from a board that
  // carries only image_file has just the main one.
  photosOf: (part) => part?.photos || (part?.image_file ? [part.image_file] : []),
  // For an <img src>: the session cookie goes with it. `v` is the file name,
  // new with every photo, so a cached old picture is never shown.
  imageUrl: (part, thumb = false, n = 0) => {
    const name = partService.photosOf(part)[n];
    return name
      ? `${api.defaults.baseURL}/parts/${part.id}/image?v=${encodeURIComponent(name)}${n ? `&n=${n}` : ""}${thumb ? "&size=thumb" : ""}`
      : null;
  },
};
