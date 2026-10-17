import api from "./api";

// A section GROUP (e.g. Tool Room = Press Tool Room + General Tool Room) is sent
// as `section_ids` — a comma list of ids; empty / missing means no group filter.
const csvIds = (ids) => (ids && ids.length ? ids.join(",") : undefined);

// On-hand stock for the Spare Parts Store. Every call carries store_code —
// this is one store's stock, and the API refuses to answer without it.
export const spareStockService = {
  list: (params) => api.get("/spare-stock", { params }),
  // sectionId is optional — omitted for the whole store, passed by the section
  // screen so it never quotes the store's figures as its own. sectionIds (an
  // array) scopes to a section group and takes precedence over sectionId.
  // The dashboard in one call (see backend SpareDashboardService).
  overview: (storeCode, sectionId, sectionIds) =>
    api.get("/dashboard/spare/overview",
      { params: { store_code: storeCode, section_id: sectionId, section_ids: csvIds(sectionIds) } }),
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
  // Everything about one part in one call — the part drawer.
  partOverview: (partId) => api.get(`/spare-stock/parts/${partId}/overview`),
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
  // Issues confirmed at least once (not cancelled), newest confirmation first —
  // the Installed list, updated without a scan. `q` matches part / person /
  // mobile / department / line / machine; `config` passes axios options
  // (e.g. { silent: true } where the screen shows the error itself).
  installations: (storeCode, q, limit, config = {}) =>
    api.get("/spare-stock/installations",
      { params: { store_code: storeCode, q: q || undefined, limit }, ...config }),
  updateLocation: (partId, payload) => api.post(`/spare-stock/parts/${partId}/update-location`, payload),
  locationHistory: (partId) => api.get(`/spare-stock/parts/${partId}/location-history`),
  // `days` scopes to a rolling window (last N days) for the Day/Week/Month/Year
  // presets; `from`/`to` (ISO dates) scope to a calendar range and win over
  // `days`; omit all three for the all-time default.
  consumption: (storeCode, groupBy = "department", sectionId, days, from, to) =>
    api.get("/spare-stock/consumption",
      { params: { store_code: storeCode, group_by: groupBy, section_id: sectionId, days, from, to } }),
  consumptionByPeriod: (storeCode, period = "month", sectionId) =>
    api.get("/spare-stock/consumption/report",
      { params: { store_code: storeCode, period, section_id: sectionId } }),
  machines: (storeCode) => api.get("/spare-stock/machines", { params: { store_code: storeCode } }),
  consumptionTrend: (storeCode, days = 7, sectionId, from, to) =>
    api.get("/spare-stock/consumption-trend",
      { params: { store_code: storeCode, days, section_id: sectionId, from, to } }),
  // Received (RECEIPT) vs issued (ISSUE) quantity per day — the material-flow
  // trend, one point per day: { d, in, out }. Same window rules as the trend.
  movementTrend: (storeCode, days = 30, sectionId, from, to) =>
    api.get("/spare-stock/movement-trend",
      { params: { store_code: storeCode, days, section_id: sectionId, from, to } }),
  consumptionComparison: (storeCode, sectionId) =>
    api.get("/spare-stock/consumption-comparison",
      { params: { store_code: storeCode, section_id: sectionId } }),
  // Per-part facts for the inventory table: last issue, 90-day issued qty,
  // last gate-entry supplier. Keyed by part_id; absent = nothing recorded.
  partFacts: (storeCode) => api.get("/spare-stock/part-facts", { params: { store_code: storeCode } }),
  // On-hand value grouped by each part's LAST gate-entry supplier (approximation).
  valueBySupplier: (storeCode, sectionId, top = 10, sectionIds) =>
    api.get("/spare-stock/value-by-supplier",
      { params: { store_code: storeCode, section_id: sectionId, top, section_ids: csvIds(sectionIds) } }),
  topConsumed: (storeCode, limit = 5, days = 30, from, to) =>
    api.get("/spare-stock/top-consumed", { params: { store_code: storeCode, limit, days, from, to } }),
  // `silent: true` suppresses the global error toast on a 404 — for probe scans
  // (e.g. put-away tries several tokens of a lot-tag QR before one resolves).
  scan: (storeCode, code, { silent = false } = {}) =>
    api.get("/spare-stock/scan", { params: { store_code: storeCode, code }, silent }),
  // Lot qty for a scanned lot tag (gate entry no + part no) — Put-away Check.
  // silent: not every scan is a lot tag, so a miss must not toast.
  lotQty: (storeCode, gateEntryNo, partNo) =>
    api.get("/spare-stock/lot-qty",
      { params: { store_code: storeCode, gate_entry_no: gateEntryNo, part_no: partNo }, silent: true }),
  // Record a confirmed put-away (Confirm Put Away). payload: { part_id,
  // scanned_location, gate_entry_no? }. Returns the saved record (location, qty,
  // put_by, confirmed_at) for the "Put Away Successful" screen.
  putAwayRecord: (payload) => api.post("/spare-stock/put-away/record", payload),
  returnables: (storeCode) => api.get("/spare-stock/returnables", { params: { store_code: storeCode } }),
  reorder: (storeCode) => api.get("/spare-stock/reorder", { params: { store_code: storeCode } }),
  erpPending: (storeCode) => api.get("/spare-stock/erp-sync/pending", { params: { store_code: storeCode } }),
  // The actual movements behind the Pending-ERP count (drill list): data = { pending, rows, ...write status }.
  erpPendingList: (storeCode, limit) =>
    api.get("/spare-stock/erp-sync/pending/list", { params: { store_code: storeCode, limit } }),
  erpSync: (storeCode) => api.post("/spare-stock/erp-sync", null, { params: { store_code: storeCode } }),
  // The ISSUE rows since shift start — the drill behind Today's Issue.
  todayIssues: (storeCode, sectionId, sectionIds) =>
    api.get("/spare-stock/today/issues",
      { params: { store_code: storeCode, section_id: sectionId, section_ids: csvIds(sectionIds) } }),
  // The RECEIPT rows since shift start — the drill behind Today Added to Stock
  // (each with its source: ERP GRN / RGP GRN, and the supplier when known).
  todayReceipts: (storeCode, sectionId, sectionIds) =>
    api.get("/spare-stock/today/receipts",
      { params: { store_code: storeCode, section_id: sectionId, section_ids: csvIds(sectionIds) } }),
  // Store return slip — take an issued part back. payload: { qty?, reason, note?,
  // returned_by? }. Omitting the body returns the whole outstanding quantity.
  returnItem: (ledgerId, payload) => api.post(`/spare-stock/issues/${ledgerId}/return`, payload || {}),
  // Issues of a part still out on the floor — the pick-list for a return.
  returnableIssues: (partId) => api.get(`/spare-stock/parts/${partId}/returnable-issues`),
  import: (file, storeCode) => {
    const formData = new FormData();
    formData.append("file", file);
    if (storeCode) formData.append("store_code", storeCode);
    return api.post("/spare-stock/import", formData, {
      headers: { "Content-Type": "multipart/form-data" },
    });
  },
  // Load the ERP side of ERP-vs-Physical from an Excel (Part No + ERP Qty) — a
  // stand-in until the ERP API is connected. Writes the ERP stock cache.
  erpStockImport: (file, storeCode) => {
    const formData = new FormData();
    formData.append("file", file);
    if (storeCode) formData.append("store_code", storeCode);
    return api.post("/spare-stock/erp-stock/import", formData, {
      headers: { "Content-Type": "multipart/form-data" },
    });
  },
};
