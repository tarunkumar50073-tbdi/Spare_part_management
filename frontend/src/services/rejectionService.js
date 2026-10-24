import api from "./api";
import { downloadFile } from "../utils/download.js";

// Rejection Mail (/api/v1/rejection-requests) — the one mail the store sends RQC
// to punch an SRV / line rejection in ERP: a draft .eml Outlook opens ready to
// send (the app sends nothing itself). Spare Parts Store only for now; nothing
// is followed after the mail ("rejection request only 1 mail k liye h baaki kuch
// nhi" — 22 Oct 2026).
export const rejectionService = {
  // The mails made, newest first — { rows, total, page, pages, page_size }; params: store_code, page, page_size, q
  list: (params, config) => api.get("/rejection-requests", { params, ...config }),
  grnLines: (storeCode, q, config) => api.get("/rejection-requests/grn-lines", { params: { store_code: storeCode, q }, ...config }),
  parts: (storeCode, q, config) => api.get("/rejection-requests/parts", { params: { store_code: storeCode, q }, ...config }),
  settings: (config) => api.get("/rejection-requests/settings", config),
  saveSettings: (payload) => api.put("/rejection-requests/settings", payload),
  create: (payload) => api.post("/rejection-requests", payload),
  // The mail to RQC as an unsent .eml — Outlook opens it as a new message.
  downloadMail: (id, filename) => downloadFile(`/rejection-requests/${id}/mail`, filename),
};
