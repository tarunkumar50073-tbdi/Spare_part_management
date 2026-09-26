import api from "./api";

// Consumption Analytics (/api/v1/consumption-analytics) — read-only and
// store-scoped. `get` takes store_code plus the optional window and filters:
// from, to (YYYY-MM-DD), granularity (day|week|month), section_id, department,
// type (part sub-category) and part_id.
export const consumptionAnalyticsService = {
  get: (params) => api.get("/consumption-analytics", { params }),
  // The filter bar's choices: sections, part types, departments.
  options: (storeCode) => api.get("/consumption-analytics/options", { params: { store_code: storeCode } }),
};
