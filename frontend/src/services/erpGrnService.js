import api from "./api";
import { fmtDate, fmtStamp, parseServerTime } from "../lib/format.js";

// Spare receiving read from ERP (/api/v1/erp-grn). Receiving, the GRN and the
// Maintenance / Tool Room quality clearance are done in ERP; the app reads the
// ERP GRN register and adds each GRN's accepted qty to store stock once. ERP is
// never written.
export const erpGrnService = {
  // { settings: {enabled, from_date}, erp: {synced_at, newest_grn_date},
  //   counts: {STATE: n}, rows: [ERP GRN line per (part, GRN no.)] }
  // `config` passes axios options through — { silent: true } where the screen
  // shows its own error state.
  preview: (storeCode, config = {}) =>
    api.get("/erp-grn/preview", { params: { store_code: storeCode }, ...config }),
  // Adds every accepted, not-yet-added line now -> { posted: [{part_id, part_no,
  // grn_no, qty}], skipped_off }. The ERP sync does the same after every run.
  post: (storeCode) => api.post("/erp-grn/post", null, { params: { store_code: storeCode } }),
  settings: () => api.get("/erp-grn/settings"),
  // Admin only. from_date is "YYYY-MM-DD".
  saveSettings: ({ enabled, from_date }) => api.put("/erp-grn/settings", { enabled, from_date }),
};

const DAY_MS = 86_400_000;

// How fresh the ERP GRN mirror is ({synced_at, newest_grn_date} as every
// ERP-derived payload carries it), worded once so every screen says it the
// same way. synced_at is when the mirror last took rows from ERP (a naive UTC
// stamp); a day or more old means ERP work done since then is not here yet.
export function erpFreshness(erp, now = Date.now()) {
  const synced = parseServerTime(erp?.synced_at);
  const newest = erp?.newest_grn_date || null;
  if (!synced) {
    return {
      empty: true, stale: true, ageDays: null,
      text: "ERP GRN data not loaded yet — no ERP sync has filled the GRN mirror",
    };
  }
  const ageDays = Math.max(0, Math.floor((now - synced.getTime()) / DAY_MS));
  return {
    empty: false,
    stale: ageDays >= 1,
    ageDays,
    text: `ERP data as of ${fmtStamp(erp.synced_at)}${newest ? ` · newest GRN ${fmtDate(newest)}` : " · no GRN in the mirror"}`,
    staleText: ageDays >= 1
      ? `${ageDays} day${ageDays === 1 ? "" : "s"} old — GRNs and quality clearances done in ERP after `
        + `${fmtStamp(erp.synced_at)} are not shown here, and not added to stock, until the ERP sync runs again.`
      : null,
  };
}
