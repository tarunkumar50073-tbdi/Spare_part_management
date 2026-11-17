import api from "./api";
import { downloadFile } from "../utils/download.js";

// Short Receiving (/api/v1/short-rejection): what suppliers sent short on the
// ERP GRN lines of a store's parts, with the days each has been pending.
// Read-only. (Rejections were shown here too until 17 Nov 2026.) Params:
// store_code, period (30d | 90d | month | last_month | this_fy | last_fy |
// custom), from / to (custom: the GRN date, YYYY-MM-DD), supplier (a code, or
// text in a code / name), part (text in the Part No / description).
export const shortRejectionService = {
  // -> { kind, label, available, summary, lines, totals, data_as_of, not_given, basis, window, filters, title }
  get: (params, config) => api.get("/short-rejection", { params, ...config }),
  // The same period and filters as ONE file — format=excel (sheets
  // "Supplier-wise" and "Lines") | pdf — saved under `filename`.
  exportFile: (params, format, filename) =>
    downloadFile("/short-rejection/export", filename, { ...params, format }),
};
