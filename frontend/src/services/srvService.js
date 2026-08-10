import api from "./api";

// Gate entry, unload, verification and SRV creation are all ERP-inbound —
// ERP calls those API routes directly, so there's no client-side wrapper
// for them here (nothing in this app's UI triggers them). Transfer to Part
// Store is no longer a manual action either — it's chained automatically
// the instant material reaches STORED (see SRVService._receive_into_store).
export const srvService = {
  list: (params) => api.get("/store/srvs", { params }),
  get: (id) => api.get(`/store/srvs/${id}`),
  // Rack Allocation — scan rack, scan part, confirm.
  putAwayPending: () => api.get("/store/put-away/pending"),
  putAwayConfirm: (id, rack_bin_id, scanned_part_code) =>
    api.post(`/store/srvs/${id}/put-away/confirm`, { rack_bin_id, scanned_part_code }),
};
