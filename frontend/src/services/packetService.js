import api from "./api";

// Packets & QR Labels (/api/v1/spare-packets) — receipt batches, physical
// verification, packets / individual units with their own QR codes, FIFO and
// the whole-packet issue (the store's spec of 27 Oct 2026). Making packets and
// printing labels never change stock; issuing a packet deducts its whole qty.
export const packetService = {
  // { rows, total, page, pages, page_size }; params: store_code, status (PENDING | TO_PACK | PACKED), q, page
  receipts: (params, config) => api.get("/spare-packets/receipts", { params, ...config }),
  verify: (id, payload) => api.post(`/spare-packets/receipts/${id}/verify`, payload),
  plan: (id, payload, config) => api.post(`/spare-packets/receipts/${id}/plan`, payload, config),
  // payload.supplier_codes: one code per box when the boxes carry the supplier's own label.
  pack: (id, payload) => api.post(`/spare-packets/receipts/${id}/pack`, payload),
  reopen: (id) => api.post(`/spare-packets/receipts/${id}/reopen`),
  // Old stock on the shelf, rack by rack: { rows, total, page, pages, summary, racks, sections };
  // params: store_code, section_id, rack, q, show (todo | done | all), page
  oldStock: (params, config) => api.get("/spare-packets/old-stock", { params, ...config }),
  oldStockPlan: (partId, payload, config) => api.post(`/spare-packets/old-stock/${partId}/plan`, payload, config),
  oldStockPack: (partId, payload) => api.post(`/spare-packets/old-stock/${partId}/pack`, payload),
  // Can this supplier code be its box's own? { ok, message, same, fields } — nothing written.
  boxCode: (partId, code, config) => api.post(`/spare-packets/parts/${partId}/box-code`, { code }, config),
  // The supplier's code is the same on every box: map it to the part; the stock stays loose.
  keepLoose: (partId, payload) => api.post(`/spare-packets/parts/${partId}/keep-loose`, payload),
  parts: (storeCode, q, config) => api.get("/spare-packets/parts", { params: { store_code: storeCode, q }, ...config }),
  fifo: (partId, config) => api.get(`/spare-packets/parts/${partId}/fifo`, config),
  packets: (params, config) => api.get("/spare-packets/packets", { params, ...config }),
  issued: (params, config) => api.get("/spare-packets/issued", { params, ...config }),
  get: (code, config) => api.get(`/spare-packets/packets/${encodeURIComponent(code)}`, config),
  // After the labels came out of the printer (the browser can't know).
  recordPrint: (codes, { reprint = false, reason } = {}) => api.post("/spare-packets/print", { codes, reprint, reason }),
  cancel: (code, reason) => api.post(`/spare-packets/packets/${encodeURIComponent(code)}/cancel`, { reason }),
  issue: (code, payload) => api.post(`/spare-packets/packets/${encodeURIComponent(code)}/issue`, payload),
};
