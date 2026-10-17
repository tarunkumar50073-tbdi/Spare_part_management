import api from "./api";

// Kiosk part-requests + supervisor issuance. storeCode scopes every call.
export const partRequestService = {
  // Kiosk: submit a request. payload: { part_id, requested_qty, employee_id?,
  // requester_mobile?, requester_name?, department, remarks? }. Returns the
  // saved request incl. reference_no + available_qty.
  create: (storeCode, payload) =>
    api.post("/part-requests", { ...payload, store_code: storeCode }),
  // Supervisor queue (status omitted/"open" = live queue) or history ("all",
  // or a comma list like "ISSUED,PARTIALLY_ISSUED").
  list: (storeCode, status) =>
    api.get("/part-requests", { params: { store_code: storeCode, status } }),
  get: (id) => api.get(`/part-requests/${id}`),
  // Confirm issue. payload: { scanned_location, issued_qty, token?, remarks? }.
  issue: (id, payload) => api.post(`/part-requests/${id}/issue`, payload),
  cancel: (id) => api.post(`/part-requests/${id}/cancel`, {}),
};

// A one-shot idempotency token so a double "Confirm Issue" click cannot issue
// twice (the backend treats a repeat of the same token as a no-op).
export const newIssueToken = () => {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* fall through */ }
  return `t-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};
