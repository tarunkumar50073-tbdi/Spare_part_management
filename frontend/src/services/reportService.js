import api from "./api";

// The Reports page. Which reports a store has comes from the server, so the
// page never offers a report of another store's workflow.
export const reportService = {
  // [{ key, label, description, needs_dates, formats }] — the reports of that
  // store, in the order the page shows them. Each one downloads from
  // /reports/<key>/<excel|csv|pdf>.
  catalog: (storeCode, config) =>
    api.get("/reports/catalog", { ...config, params: { store_code: storeCode } }),
};
