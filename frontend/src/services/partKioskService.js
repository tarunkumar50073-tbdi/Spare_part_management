import api from "./api";

// Part Search kiosk (/api/v1/part-kiosk) — read only: a part, its photo, stock,
// location and section, for the kiosk outside the spare store (25 Oct 2026).
export const partKioskService = {
  // { rows, total, page, pages, q }; params: store_code, q, page, per_page
  search: (params, config) => api.get("/part-kiosk/parts", { params, ...config }),
  // The kiosk LINK (no login, 17 Nov 2026): the same search behind its key.
  linkSearch: (key, params, config) => api.get(`/kiosk-link/${encodeURIComponent(key)}/parts`, { params, ...config }),
  linkImageUrl: (key, part, name, thumb = false, n = 0) => (name
    ? `${api.defaults.baseURL}/kiosk-link/${encodeURIComponent(key)}/image/${part.id}?v=${encodeURIComponent(name)}${n ? `&n=${n}` : ""}${thumb ? "&size=thumb" : ""}`
    : null),
  // Admin: the link's state; set {enabled} and / or {new: true}.
  getLink: () => api.get("/part-kiosk/link"),
  setLink: (body) => api.post("/part-kiosk/link", body),
};
