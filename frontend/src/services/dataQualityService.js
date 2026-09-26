import api from "./api";

// Data Quality (/api/v1/data-quality) — how complete the part master is.
export const dataQualityService = {
  // { parts, completeness_pct, fields[], checks[], uom_variants[], gate_window }
  summary: (params) => api.get("/data-quality", { params }),
  // One check's parts: { check, parts, rows[] }; 400 on an unknown check.
  parts: (params) => api.get("/data-quality/parts", { params }),
};
