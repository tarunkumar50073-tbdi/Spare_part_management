import api from "./api";

// On-hand stock for the Spare Parts Store. Every call carries store_code —
// this is one store's stock, and the API refuses to answer without it.
export const spareStockService = {
  list: (params) => api.get("/spare-stock", { params }),
  // sectionId is optional — omitted for the whole store, passed by the section
  // screen so it never quotes the store's figures as its own.
  summary: (storeCode, sectionId) =>
    api.get("/spare-stock/summary", { params: { store_code: storeCode, section_id: sectionId } }),
  belowMinimum: (storeCode, limit, sectionId) =>
    api.get("/spare-stock/below-minimum",
      { params: { store_code: storeCode, limit, section_id: sectionId } }),
  byStatus: (storeCode, status, limit) =>
    api.get("/spare-stock/by-status", { params: { store_code: storeCode, status, limit } }),
  excess: (storeCode, limit) =>
    api.get("/spare-stock/excess", { params: { store_code: storeCode, limit } }),
  // Since the shift started (08:30), not since midnight — the plant's day runs
  // past midnight, so a calendar cut would split one night shift in two.
  today: (storeCode, sectionId) =>
    api.get("/spare-stock/today", { params: { store_code: storeCode, section_id: sectionId } }),
  activity: (storeCode, limit) =>
    api.get("/spare-stock/activity", { params: { store_code: storeCode, limit } }),
  analytics: (storeCode, sectionId) =>
    api.get("/spare-stock/analytics", { params: { store_code: storeCode, section_id: sectionId } }),
  flow: (storeCode) => api.get("/spare-stock/flow", { params: { store_code: storeCode } }),
  pending: (storeCode) => api.get("/spare-stock/pending", { params: { store_code: storeCode } }),
  pendingList: (storeCode, kind, limit) =>
    api.get("/spare-stock/pending/list", { params: { store_code: storeCode, kind, limit } }),
  traceability: (partId) => api.get(`/spare-stock/traceability/${partId}`),
  forPart: (partId) => api.get(`/spare-stock/parts/${partId}`),
  setQuantity: (partId, payload) => api.put(`/spare-stock/parts/${partId}`, payload),
  history: (partId, limit, filters = {}) =>
    api.get(`/spare-stock/parts/${partId}/history`, { params: { limit, ...filters } }),
  // ERP-vs-Physical gap: ERP from the feed, physical from this store's own count.
  erpGap: (storeCode, params = {}) =>
    api.get("/spare-stock/erp-gap", { params: { store_code: storeCode, ...params } }),
  erpGapSummary: (storeCode) =>
    api.get("/spare-stock/erp-gap/summary", { params: { store_code: storeCode } }),
  issue: (partId, payload) => api.post(`/spare-stock/parts/${partId}/issue`, payload),
  receive: (partId, payload) => api.post(`/spare-stock/parts/${partId}/receive`, payload),
  // Two-stage issue: Stage 2 confirmation + the pending-confirmation queue.
  confirm: (ledgerId, payload) => api.post(`/spare-stock/issues/${ledgerId}/confirm`, payload),
  pendingConfirmations: (storeCode, limit) =>
    api.get("/spare-stock/pending-confirmations", { params: { store_code: storeCode, limit } }),
  partPendingConfirmations: (partId) =>
    api.get(`/spare-stock/parts/${partId}/pending-confirmations`),
  updateLocation: (partId, payload) => api.post(`/spare-stock/parts/${partId}/update-location`, payload),
  locationHistory: (partId) => api.get(`/spare-stock/parts/${partId}/location-history`),
  consumption: (storeCode, groupBy = "department", sectionId) =>
    api.get("/spare-stock/consumption",
      { params: { store_code: storeCode, group_by: groupBy, section_id: sectionId } }),
  consumptionByPeriod: (storeCode, period = "month", sectionId) =>
    api.get("/spare-stock/consumption/report",
      { params: { store_code: storeCode, period, section_id: sectionId } }),
  machines: (storeCode) => api.get("/spare-stock/machines", { params: { store_code: storeCode } }),
  consumptionTrend: (storeCode, days = 7, sectionId) =>
    api.get("/spare-stock/consumption-trend",
      { params: { store_code: storeCode, days, section_id: sectionId } }),
  topConsumed: (storeCode, limit = 5, days = 30) =>
    api.get("/spare-stock/top-consumed", { params: { store_code: storeCode, limit, days } }),
  scan: (storeCode, code) => api.get("/spare-stock/scan", { params: { store_code: storeCode, code } }),
  returnables: (storeCode) => api.get("/spare-stock/returnables", { params: { store_code: storeCode } }),
  reorder: (storeCode) => api.get("/spare-stock/reorder", { params: { store_code: storeCode } }),
  erpPending: (storeCode) => api.get("/spare-stock/erp-sync/pending", { params: { store_code: storeCode } }),
  erpSync: (storeCode) => api.post("/spare-stock/erp-sync", null, { params: { store_code: storeCode } }),
  returnItem: (ledgerId) => api.post(`/spare-stock/issues/${ledgerId}/return`),
  import: (file, storeCode) => {
    const formData = new FormData();
    formData.append("file", file);
    if (storeCode) formData.append("store_code", storeCode);
    return api.post("/spare-stock/import", formData, {
      headers: { "Content-Type": "multipart/form-data" },
    });
  },
};
