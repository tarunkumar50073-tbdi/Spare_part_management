import api from "./api";
import { downloadFile } from "../utils/download.js";

// Urgent Challan Register (/api/v1/challans) — urgent material that came in on
// a supplier's delivery challan before its PO was approved or its original
// invoice arrived (the store's spec, 21 Oct 2026). A register only: saving a
// challan or linking an invoice never changes stock — stock comes only from the
// ERP GRN after quality. Every write carries a request_id made once per form
// opening, so a double click or a retry never makes a second record.
export const challanService = {
  // { rows, total, page, pages, page_size } — params: store_code, page, page_size,
  // from, to (receipt date), supplier, part, po_status, invoice_status, status, quality_status, q
  list: (params, config) => api.get("/challans", { params, ...config }),
  // { tiles, ageing, oldest_open, as_of } over store_code, from, to, supplier, part, q
  dashboard: (params, config) => api.get("/challans/dashboard", { params, ...config }),
  exportExcel: (params, filename) => downloadFile("/challans/export", filename, params),
  options: (config) => api.get("/challans/options", config),
  parts: (storeCode, q, config) => api.get("/challans/parts", { params: { store_code: storeCode, q }, ...config }),
  supplierOptions: (partId) => api.get(`/challans/parts/${partId}/supplier-options`),
  create: (payload) => api.post("/challans", payload),
  get: (id, config) => api.get(`/challans/${id}`, config),
  update: (id, payload) => api.patch(`/challans/${id}`, payload),
  cancel: (id, reason) => api.post(`/challans/${id}/cancel`, { reason }),
  linkInvoice: (id, payload) => api.post(`/challans/${id}/invoices`, payload),
  grnCandidates: (id, config) => api.get(`/challans/${id}/grn-candidates`, config),
  linkGrn: (id, linkId, payload) => api.post(`/challans/${id}/invoices/${linkId}/grn`, payload),
  refreshGrn: (storeCode) => api.post("/challans/refresh-grn", { store_code: storeCode }),
};

/** A fresh id for one opening of a form: a repeat of the same submit finds the first record. */
export const newRequestId = () => {
  try {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  } catch {
    // fall through
  }
  return `rq-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
};
