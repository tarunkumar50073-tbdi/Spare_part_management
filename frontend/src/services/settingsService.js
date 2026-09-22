import api from "./api";

// Admin-only application settings. Secrets (SMTP/ERP/API-key) are NOT here —
// system-status reports only whether such things are configured, never a value.
export const settingsService = {
  systemStatus: () => api.get("/admin/system-status"),
  labelConfig: () => api.get("/admin/label-config"),
  setLabelConfig: (payload) => api.put("/admin/label-config", payload),
  storeVisibility: () => api.get("/admin/store-visibility"),
  setStoreActive: (code, isActive) => api.put(`/admin/stores/${code}/active`, { is_active: isActive }),
  setSectionActive: (id, isActive) => api.put(`/admin/sections/${id}/active`, { is_active: isActive }),
};
