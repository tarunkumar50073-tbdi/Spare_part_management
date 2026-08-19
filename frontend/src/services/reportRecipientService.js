import api from "./api";

// Report Recipient master — who each auto-mailed report (today: the daily
// window-time sheet) is sent To / Cc. Writes are ADMIN-only server-side.
export const reportRecipientService = {
  list: (reportKey, activeOnly) =>
    api.get("/report-recipients", {
      params: { ...(reportKey ? { report_key: reportKey } : {}), ...(activeOnly ? { active: 1 } : {}) },
    }),
  create: (payload) => api.post("/report-recipients", payload),
  update: (id, payload) => api.put(`/report-recipients/${id}`, payload),
};
