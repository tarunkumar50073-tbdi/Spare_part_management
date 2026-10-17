import api from "./api";

// Notification Engine (admin only): the durable mail queue + log, the scheduled
// rules, templates, the manual alert and the reminder / escalation settings.
export const mailEngineService = {
  status: () => api.get("/mail-engine/status"),
  saveSettings: (payload) => api.put("/mail-engine/settings", payload),
  processNow: () => api.post("/mail-engine/process"),
  messages: (params) => api.get("/mail-engine/messages", { params }),
  message: (id) => api.get(`/mail-engine/messages/${id}`),
  retry: (id) => api.post(`/mail-engine/messages/${id}/retry`),
  cancel: (id) => api.post(`/mail-engine/messages/${id}/cancel`),
  rules: () => api.get("/mail-engine/rules"),
  saveRule: (key, payload) => api.put(`/mail-engine/rules/${key}`, payload),
  runRule: (key) => api.post(`/mail-engine/rules/${key}/run`),
  previewRule: (key) => api.get(`/mail-engine/rules/${key}/preview`),
  templates: () => api.get("/mail-engine/templates"),
  saveTemplate: (mailType, payload) => api.put(`/mail-engine/templates/${mailType}`, payload),
  saveIdentity: (payload) => api.put("/mail-engine/templates-identity", payload),
  sendAlert: (payload) => api.post("/mail-engine/send-alert", payload),
  reminders: () => api.get("/mail-engine/reminders"),
  saveReminders: (payload) => api.put("/mail-engine/reminders", payload),
  runReminders: () => api.post("/mail-engine/reminders/run"),
  recipients: () => api.get("/mail-engine/recipients"),
};

// react-query keys — all under "mail" (never "stock": that prefix is refetched on every stock movement)
export const mailKeys = {
  status: ["mail", "status"],
  messages: (params) => ["mail", "messages", params],
  message: (id) => ["mail", "message", id],
  rules: ["mail", "rules"],
  templates: ["mail", "templates"],
  reminders: ["mail", "reminders"],
  recipients: ["mail", "recipients"],
};
