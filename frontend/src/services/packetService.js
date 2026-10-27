import api from "./api";

// Packets & QR Labels (/api/v1/spare-packets) — receipt batches, physical
// verification, packets / individual units with their own QR codes, FIFO and
// the whole-packet issue (the store's spec of 27 Oct 2026). Making packets and
// printing labels never change stock; issuing a packet deducts its whole qty.
export const packetService = {
  // { rows, total, page, pages, page_size }; params: store_code, status (PENDING | TO_PACK | PACKED), q, page
  receipts: (params, config) => api.get("/spare-packets/receipts", { params, ...config }),
  opening: (payload) => api.post("/spare-packets/receipts/opening", payload),
  verify: (id, payload) => api.post(`/spare-packets/receipts/${id}/verify`, payload),
  plan: (id, payload, config) => api.post(`/spare-packets/receipts/${id}/plan`, payload, config),
  pack: (id, payload) => api.post(`/spare-packets/receipts/${id}/pack`, payload),
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
