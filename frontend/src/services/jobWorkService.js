import api from "./api";

// Job work returns and ERP's RGPs (/api/v1/job-work) — the store's spec of 27
// Oct 2026. The job work return itself is made on Scan Part -> Return; here the
// Pending RGP list, ERP's RGP lines (read only) and the link a store person saves.
export const jobWorkService = {
  // { rows, sync, counts }; params: store_code, state (PENDING_RGP | RGP_AVAILABLE | RGP_LINKED | SYNC_FAILED), q
  returns: (params, config) => api.get("/job-work/returns", { params, ...config }),
  // { return, suggested, found, sync }
  candidates: (returnId, q, config) => api.get(`/job-work/returns/${returnId}/candidates`, { params: { q: q || undefined }, ...config }),
  link: (returnId, rgpLineId) => api.post(`/job-work/returns/${returnId}/link`, { rgp_line_id: rgpLineId }),
  unlink: (returnId) => api.post(`/job-work/returns/${returnId}/unlink`),
  rgp: (q, config) => api.get("/job-work/rgp", { params: { q: q || undefined }, ...config }),
  sync: () => api.post("/job-work/rgp/sync"),
};
