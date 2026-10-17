import api from "./api";

// Admin-only application settings. Secrets (SMTP/ERP/API-key) are NOT here —
// system-status reports only whether such things are configured, never a value.
export const settingsService = {
  systemStatus: () => api.get("/admin/system-status"),
  // One database backup on the spot (System status → "Back up now").
  backupNow: () => api.post("/admin/backup-now"),
  labelConfig: () => api.get("/admin/label-config"),
  setLabelConfig: (payload) => api.put("/admin/label-config", payload),
  // SMTP mail server — non-secret settings (no password; that stays in .env).
  smtpConfig: () => api.get("/admin/smtp-config"),
  setSmtpConfig: (payload) => api.put("/admin/smtp-config", payload),
  sendSmtpTest: (to) => api.post("/admin/smtp-test", { to }),
  storeVisibility: () => api.get("/admin/store-visibility"),
  setStoreActive: (code, isActive) => api.put(`/admin/stores/${code}/active`, { is_active: isActive }),
  setSectionActive: (id, isActive) => api.put(`/admin/sections/${id}/active`, { is_active: isActive }),
};
