import api from "./api";
import { downloadFile } from "../utils/download.js";

// Quarterly physical inventory (/api/v1/inventory), 15 Nov 2026.
export const inventoryCountService = {
  period: () => api.get("/inventory/period"),
  sessions: (params) => api.get("/inventory/sessions", { params }),
  plan: (body) => api.post("/inventory/sessions", body),
  detail: (id, params) => api.get(`/inventory/sessions/${id}`, { params }),
  update: (id, body) => api.patch(`/inventory/sessions/${id}`, body),
  remove: (id, storeCode) => api.delete(`/inventory/sessions/${id}`, { params: { store_code: storeCode } }),
  start: (id, storeCode) => api.post(`/inventory/sessions/${id}/start`, { store_code: storeCode }),
  startExcel: (id, storeCode, file) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("store_code", storeCode);
    return api.post(`/inventory/sessions/${id}/start`, fd);
  },
  line: (id, params) => api.get(`/inventory/sessions/${id}/line`, { params }),
  count: (id, body) => api.post(`/inventory/sessions/${id}/counts`, body),
  editCount: (cid, body) => api.patch(`/inventory/counts/${cid}`, body),
  countSheet: (id, storeCode, file) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("store_code", storeCode);
    return api.post(`/inventory/sessions/${id}/count-sheet`, fd);
  },
  recount: (id, body) => api.post(`/inventory/sessions/${id}/recount`, body),
  submit: (id, body) => api.post(`/inventory/sessions/${id}/submit`, body),
  approve: (id, body) => api.post(`/inventory/sessions/${id}/approve`, body),
  reject: (id, body) => api.post(`/inventory/sessions/${id}/reject`, body),
  revise: (id, body) => api.post(`/inventory/sessions/${id}/revise`, body),
  template: (storeCode) => downloadFile("/inventory/template", "Quarterly Inventory Upload Format.xlsx", { store_code: storeCode }),
  importQuarter: (fields, file) => {
    const fd = new FormData();
    Object.entries(fields).forEach(([k, v]) => { if (v != null && v !== "") fd.append(k, v); });
    fd.append("file", file);
    return api.post("/inventory/sessions/import", fd);
  },
  quarter: (params, config) => api.get("/inventory/quarter", { params, ...config }),
  history: (storeCode) => api.get("/inventory/history", { params: { store_code: storeCode } }),
  board: (storeCode, config) => api.get("/inventory/board", { params: { store_code: storeCode }, ...config }),
  exportFile: (id, fmt, params, name) =>
    downloadFile(`/inventory/sessions/${id}/export/${fmt}`, `${name}.${fmt === "pdf" ? "pdf" : "xlsx"}`, params),
};
