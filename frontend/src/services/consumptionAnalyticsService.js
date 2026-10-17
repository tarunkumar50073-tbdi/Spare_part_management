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
  // The filter bar's choices: sections, part types, consuming departments
  // (`departments`, the Consumption Report's), the departments written on
  // issues (`issue_departments`, the Issuance Report's), and the presets'
  // ranges cut on the plant clock (yesterday, last_month, this_fy, last_fy).
  options: (storeCode, config) =>
    api.get("/consumption-analytics/options", { params: { store_code: storeCode }, ...config }),
  // One report's table, one view at a time: report=issuance|consumption, the
  // same window and filters, and a view of that report (REPORTS below). The
  // Issue list is subtotalled by the server from the range's length.
  table: (params, config) => api.get("/consumption-analytics/table", { params, ...config }),
  // The same view as a file, format=excel|pdf, saved under `filename`.
  exportTable: (params, format, filename) =>
    downloadFile("/consumption-analytics/table/export", filename, { ...params, format }),
  // A report's Full pack: one workbook of the window and filters. Downloads
  // only — the store asked for no mail (17 Oct 2026).
  exportPack: (params, filename) => downloadFile("/consumption-analytics/table/pack", filename, params),
};

// The two reports the one Issuance & Consumption screen became ("issuance and
// consumption ki report alag alag chahiye" — the store, 17 Oct 2026), each
// with its View dropdown in the server's order (ConsumptionTableService.REPORTS),
// named "-wise" as the store says them ("dropdown me date wise, month wise,
// year wise etc."); `option` is the longer text the dropdown shows where the
// name alone does not say what the view holds. `departments` is the filter
// list's field in the options answer: who took it out, or who consumed it.
export const REPORTS = {
  issuance: {
    key: "issuance",
    title: "Issuance Report",
    path: "/issuance",
    subtitle: "What left the store, when and to whom — counted as issued. Pick a period and a view; download as Excel or PDF.",
    departments: "issue_departments",
    departmentHint: "The department written on the issue (who took it out)",
    pack: "Summary, Date-wise, Month-wise, Year-wise, Part-wise, Department-wise, Person-wise and the Issue list",
    views: [
      { key: "list", label: "Issue list", option: "Issue list (every issue)" },
      { key: "day", label: "Date-wise" },
      { key: "week", label: "Week-wise" },
      { key: "month", label: "Month-wise" },
      { key: "year", label: "Year-wise" },
      { key: "fy", label: "Financial year-wise" },
      { key: "part", label: "Part-wise" },
      { key: "department", label: "Department-wise", option: "Department-wise (taken by)" },
      { key: "person", label: "Person-wise", option: "Person-wise (issued to)" },
    ],
  },
  consumption: {
    key: "consumption",
    title: "Consumption Report",
    path: "/consumption",
    subtitle: "What each department really used — returns netted against their issue. Pick a period and a view; download as Excel or PDF.",
    departments: "departments",
    departmentHint: "The department that owns the part's section (who consumed it)",
    pack: "Summary, Date-wise, Month-wise, Year-wise, Part-wise, Department-wise, Line / Machine-wise and Category-wise",
    views: [
      { key: "day", label: "Date-wise" },
      { key: "week", label: "Week-wise" },
      { key: "month", label: "Month-wise" },
      { key: "year", label: "Year-wise" },
      { key: "fy", label: "Financial year-wise" },
      { key: "part", label: "Part-wise" },
      { key: "department", label: "Department-wise" },
      { key: "machine", label: "Line / Machine-wise" },
      { key: "category", label: "Category-wise" },
    ],
  },
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
