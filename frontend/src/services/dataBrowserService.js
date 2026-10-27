import api from "./api";
import { downloadFile } from "../utils/download.js";

// Data Browser (/api/v1/data-browser) — every table of the app's database,
// read only, administrators only; passwords and secrets come back hidden.
export const dataBrowserService = {
  // { tables: [{ name, group, about, rows, columns }], groups, total_rows }
  tables: (config) => api.get("/data-browser/tables", config),
  // { name, group, about, columns: [{ name, type, hidden }], rows, total, page, pages, page_size }
  rows: (name, params, config) => api.get(`/data-browser/tables/${encodeURIComponent(name)}`, { params, ...config }),
  exportFile: (name, params) => downloadFile(`/data-browser/tables/${encodeURIComponent(name)}/export`, `${name}.xlsx`, params),
};
