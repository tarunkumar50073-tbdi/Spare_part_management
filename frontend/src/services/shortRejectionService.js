import api from "./api";
import { downloadFile } from "../utils/download.js";

// Short & Rejection (/api/v1/short-rejection): what suppliers sent short and
// what quality rejected on the ERP GRN lines of a store's parts, with the days
// each has been pending. Read-only. Params: store_code, from / to (the GRN
// date, YYYY-MM-DD; default the last 90 days), supplier (a code, or text in a
// code / name), part_id.
export const shortRejectionService = {
  // -> { summary, lines, totals, data_as_of, not_given, basis, window, filters, title }
  get: (params, config) => api.get("/short-rejection", { params, ...config }),
  // The same window and filters as ONE file — format=excel (sheets
  // "Supplier-wise" and "Lines") | pdf — saved under `filename`.
  exportFile: (params, format, filename) =>
    downloadFile("/short-rejection/export", filename, { ...params, format }),
};
