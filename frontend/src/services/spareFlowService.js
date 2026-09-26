import api from "./api";

// QR traceability flow for the Spare Parts Store (/api/v1/spare-flow + the
// issue / installation / return endpoints that already live on /spare-stock).
// Every write returns the document it changed; screens refetch the scan result
// through the shared ["stock", ...] query keys (the SSE "stock" event does the
// same for other terminals).
export const spareFlowService = {
  // ---- scan result / history / queues ----
  scanResult: (partId) => api.get(`/spare-flow/parts/${partId}/scan-result`),
  timeline: (partId, limit = 200) =>
    api.get(`/spare-flow/parts/${partId}/timeline`, { params: { limit } }),
  // `config` passes axios options through — e.g. { silent: true } where the
  // screen shows its own error state instead of the interceptor's toast.
  queues: (storeCode, config = {}) =>
    api.get("/spare-flow/queues", { params: { store_code: storeCode }, ...config }),
  // ERP vendors seen for this part (gate entries / GRNs) + the supplier master.
  supplierOptions: (partId) => api.get(`/spare-flow/parts/${partId}/supplier-options`),

  // ---- receiving (spec 1 / 9) ----
  // payload: { part_id, qty, supplier_id?, ven_cd?, ven_name?, supplier_source?,
  //            invoice_no?, invoice_date?, check_result?, remarks?, scanned_code?, scan_source? }
  receive: (payload) => api.post("/spare-flow/receipts", payload),
  // { grn_no, grn_date?, quality_by, remarks? }
  recordGrn: (receiptId, payload) => api.post(`/spare-flow/receipts/${receiptId}/grn`, payload),
  // { accepted_qty, rejected_qty, remarks? }
  qualityClear: (receiptId, payload) => api.post(`/spare-flow/receipts/${receiptId}/quality`, payload),
  cancelReceipt: (receiptId, reason) =>
    api.post(`/spare-flow/receipts/${receiptId}/cancel`, { reason }),

  // ---- issue / installation / return (spec 11-13; on /spare-stock) ----
  // { qty, department, issued_to?, reference?, remarks?, scanned_code?, scan_source? }
  issue: (partId, payload) => api.post(`/spare-stock/parts/${partId}/issue`, payload),
  // { line_name?, line_no?, machine?, die_no?, actual_qty?, remarks? } — repeatable.
  updateInstallation: (issueId, payload) => api.post(`/spare-stock/issues/${issueId}/confirm`, payload),
  // { qty, reason, note?, returned_by? } -> a return held for inspection.
  returnToStore: (issueId, payload) => api.post(`/spare-stock/issues/${issueId}/return`, payload),

  // ---- return inspection (spec 14) ----
  // { result: GOOD|INSPECTION_REQUIRED|DAMAGED|SCRAP, qty, from_bucket?, remarks? }
  inspect: (returnId, payload) => api.post(`/spare-flow/returns/${returnId}/inspect`, payload),

  // ---- RGP (spec 15-19) ----
  // { qty, from_bucket?, supplier_id?, ven_cd?, ven_name, supplier_source, rework_reason,
  //   remarks?, rgp_date?, expected_return_date?, erp_challan_no? }
  rgpOut: (returnId, payload) => api.post(`/spare-flow/returns/${returnId}/rgp-out`, payload),
  // { qty, remarks? }
  rgpSupplierReturn: (rgpId, payload) => api.post(`/spare-flow/rgps/${rgpId}/supplier-return`, payload),
  // { qty, grn_no, grn_date?, remarks? }
  rgpGrn: (rgpId, payload) => api.post(`/spare-flow/rgps/${rgpId}/grn`, payload),
  cancelRgp: (rgpId, reason) => api.post(`/spare-flow/rgps/${rgpId}/cancel`, { reason }),
  rgps: (storeCode, status) => api.get("/spare-flow/rgps", { params: { store_code: storeCode, status } }),
};
