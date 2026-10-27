import api from "./api";
import { downloadFile } from "../utils/download.js";

// Consumption Analytics (/api/v1/consumption-analytics) — read-only and
// store-scoped. `get` takes store_code plus the optional window and filters:
// from, to (YYYY-MM-DD), granularity (day|week|month), section_id, department
// (the CONSUMING one — the department owning the part's section, never the one
// typed on the issue), type (part sub-category) and part_id.
// Each read takes an optional request config: the report screens pass
// { silent: true } because every card shows its own error and Retry — without
// it one failed request would also toast once per card (api.js).
export const consumptionAnalyticsService = {
  get: (params, config) => api.get("/consumption-analytics", { params, ...config }),
  // The filter bar's choices: sections, part types, the consuming departments
  // (`departments` — never the store, which only hands parts out) and the
  // presets' ranges cut on the plant clock (yesterday, last_month, this_fy,
  // last_fy).
  options: (storeCode, config) =>
    api.get("/consumption-analytics/options", { params: { store_code: storeCode }, ...config }),
  // The report's table, one view at a time: report=consumption (an old
  // report=issuance link gets the same one), the window and filters, and a
  // view (REPORT below). The Issue list is subtotalled by the server from the
  // range's length.
  table: (params, config) => api.get("/consumption-analytics/table", { params, ...config }),
  // The same view as a file, format=excel|pdf, saved under `filename`.
  exportTable: (params, format, filename) =>
    downloadFile("/consumption-analytics/table/export", filename, { ...params, format }),
  // The report's Full pack: one workbook of the window and filters. Downloads
  // only — the store asked for no mail (17 Oct 2026).
  exportPack: (params, filename) => downloadFile("/consumption-analytics/table/pack", filename, params),
};

// The one Issuance & Consumption Report. Two reports for a day (17 Oct 2026,
// "issuance and consumption ki report alag alag chahiye"), one again on 18 Oct
// 2026 when the store saw them side by side ("issuance and consumption report
// same dikh rhi h dono me differance nhi to ye kaam merge me bhi ho sakta h"):
// every view carries the issued, returned and net figures, and the Department
// is the one consuming the part — the issue's own department named the store
// ("issuance me store dikha rha h jabki store to issue karta h"). The View
// dropdown is in the server's order (ConsumptionTableService), named "-wise" as
// the store says them ("dropdown me date wise, month wise, year wise etc.");
// `option` is the longer text the dropdown shows where the name alone does not
// say what the view holds.
export const REPORT = {
  key: "consumption",
  title: "Issuance & Consumption Report",
  path: "/consumption",
  subtitle: "Every issue from the store, what came back and what each department really used. "
    + "Pick a period and a view; download as Excel or PDF.",
  departmentHint: "The department that owns the part's section (who consumed it) — never the store, which only hands parts out",
  pack: "Summary, Issue list, Date-wise, Month-wise, Year-wise, Part-wise, Department-wise, Issued to Dept-wise, "
    + "Issued to Dept & Part-wise, Person-wise, "
    + "Line & Machine-wise and Category-wise",
  views: [
    { key: "list", label: "Issue list", option: "Issue list (every issue)" },
    { key: "day", label: "Date-wise" },
    { key: "week", label: "Week-wise" },
    { key: "month", label: "Month-wise" },
    { key: "year", label: "Year-wise" },
    { key: "fy", label: "Financial year-wise" },
    { key: "part", label: "Part-wise" },
    { key: "department", label: "Department-wise", option: "Department-wise (consuming)" },
    // Who the part was handed to — the department written on the issue (the
    // store, 27 Oct 2026: "kis kis depart ko issue kiya", "part k according bhi").
    { key: "issued_to", label: "Issued to Dept-wise", option: "Issued to department" },
    { key: "dept_part", label: "Issued to Dept & Part-wise", option: "Issued to department + part" },
    { key: "person", label: "Person-wise", option: "Person-wise (issued to)" },
    { key: "machine", label: "Line / Machine-wise" },
    { key: "category", label: "Category-wise" },
  ],
};

// How the server subtotals the Issue list (the range's length picks it: a day
// each up to 62 days, a month each up to two years, a year each past that; a
// link from before 17 Oct 2026 may still name one). `noun` is how the table
// card names the groups.
export const LIST_GROUPS = [
  { key: "day", noun: "day" },
  { key: "month", noun: "month" },
  { key: "year", noun: "year" },
  { key: "fy", noun: "financial year" },
];
