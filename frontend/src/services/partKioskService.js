import api from "./api";

// Part Search kiosk (/api/v1/part-kiosk) — read only: a part, its photo, stock,
// location and section, for the kiosk outside the spare store (25 Oct 2026).
export const partKioskService = {
  // { rows, total, page, pages, q }; params: store_code, q, page, per_page
  search: (params, config) => api.get("/part-kiosk/parts", { params, ...config }),
};
