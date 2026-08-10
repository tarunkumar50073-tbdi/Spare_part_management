import api from "./api";

export const quarterlyInventoryService = {
  list: (fiscalYear, quarter, params) =>
    api.get("/quarterly-inventory", { params: { fiscal_year: fiscalYear, quarter, ...params } }),
  summary: (fiscalYear, quarter) =>
    api.get("/quarterly-inventory/summary", { params: { fiscal_year: fiscalYear, quarter } }),
  fyComparison: () => api.get("/quarterly-inventory/fy-comparison"),
  quarterComparison: (fiscalYear) =>
    api.get("/quarterly-inventory/quarter-comparison", { params: { fiscal_year: fiscalYear } }),
  fiscalYears: () => api.get("/quarterly-inventory/fiscal-years"),
  // `sheet` is only needed for a workbook holding several count sheets —
  // the server refuses to guess and returns the candidate names.
  import: (file, fiscalYear, quarter, sheet) => {
    const form = new FormData();
    form.append("file", file);
    form.append("fiscal_year", fiscalYear);
    form.append("quarter", quarter);
    if (sheet) form.append("sheet", sheet);
    return api.post("/quarterly-inventory/import", form, {
      headers: { "Content-Type": "multipart/form-data" },
    });
  },
};
