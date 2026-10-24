import api from "./api";

// A section GROUP goes as `section_ids` (a comma list of ids), the same rule as
// spareStockService; empty / missing means no group filter.
const csvIds = (ids) => (ids && ids.length ? ids.join(",") : undefined);

// The management block of the Spare Parts Store in one call — action tracker,
// excess aging, monthly in vs out, scan adoption — plus the administrator's
// save of one tracker line's owner / target / remarks. `opts` is the axios
// config, so a caller that shows a failure itself can pass { silent: true }.
export const managementService = {
  get: (storeCode, sectionId, sectionIds, opts = {}) =>
    api.get("/dashboard/spare/management", { params: { store_code: storeCode, section_id: sectionId ?? undefined, section_ids: csvIds(sectionIds) }, ...opts }),
  saveTrackerItem: (storeCode, key, payload) =>
    api.put(`/dashboard/spare/action-tracker/${key}`, { store_code: storeCode, ...payload }),
  // The rows behind one Live Board figure, read by that figure's own rule:
  // kind in | out (key = "YYYY-MM"), dept (key = the consuming department),
  // scans (all | scanned | scanned_ok | typed_ok | not_found), issues (all |
  // scan | search | unrecorded), put_away (all | lot_tag — the old name for
  // "with an ERP gate entry"; no lot tags since 17 Oct 2026). data = { rows,
  // count, qty, value }.
  list: (storeCode, kind, key, sectionId, opts = {}) =>
    api.get("/dashboard/spare/management/list", { params: { store_code: storeCode, kind, key, section_id: sectionId ?? undefined }, ...opts }),
};
