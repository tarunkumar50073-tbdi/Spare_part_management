import api from "./api";
import { can } from "../utils/permissions.js";

// Notifications (/api/v1/spare-alerts). The alerts are worked out by the server
// from the store's own data on every call — nothing is stored or dismissed, so
// an alert clears itself once its cause is fixed.
export const spareAlertsService = {
  list: (storeCode) => api.get("/spare-alerts", { params: { store_code: storeCode } }),
};

// One cache entry shared by the top-bar bell and the Notification Center. The
// key starts with "stock" so the app's SSE stock push refreshes both at once.
export const alertsKey = (code) => ["stock", "alerts", code];

export const fetchAlerts = (code) => spareAlertsService.list(code).then((res) => res.data.data);

// The alerts model spare stock (min / max / reorder, two-stage issue). The Child
// Parts store has none of that and is switched off, so it is never asked.
export const alertsStoreFor = (code) => (code && code !== "CHILD_PART" ? code : null);

// How often the bell re-checks (the page shares the same cadence).
export const ALERTS_REFRESH_MS = 120000;

// Any store user sees the alerts, but each action opens a screen gated by a
// module right (the server names it). Offering one the user cannot open would
// only land them on "Access restricted".
export const canOpenAction = (user, action) => Boolean(action?.to) && can(user, action.module);
