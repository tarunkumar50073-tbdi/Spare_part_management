import { useQuery } from "@tanstack/react-query";
import { spareStockService } from "../services/spareStockService.js";
import { managementService } from "../services/managementService.js";

// One client cache for everything a stock screen shows. Every key starts with
// "stock", so ONE invalidation — after a local write, or when the server pushes
// a "stock" event over SSE (issue, receive, return, count, location, import,
// part-master edit) — refreshes every open screen at once. The ~4,800-row store
// list lives under a single key, fetched once and shared by the dashboard,
// Store Stock, Part Ledger and the Ctrl+K palette instead of once per screen.
// A section GROUP (e.g. Tool Room = several sections) is keyed by its ids joined
// with a comma, so the group's cache is kept apart from any single section's.
const groupKey = (sectionIds) => (sectionIds && sectionIds.length ? sectionIds.join(",") : null);

export const stockKeys = {
  all: ["stock"],
  list: (code, sectionId, sectionIds) => ["stock", "list", code, sectionId ?? null, groupKey(sectionIds)],
  summary: (code, sectionId) => ["stock", "summary", code, sectionId ?? null],
  belowMin: (code, sectionId) => ["stock", "below-min", code, sectionId ?? null],
  ops: (code) => ["stock", "ops", code],
  overview: (code, sectionId, sectionIds) => ["stock", "overview", code, sectionId ?? null, groupKey(sectionIds)],
  management: (code, sectionId, sectionIds) => ["stock", "management", code, sectionId ?? null, groupKey(sectionIds)],
  valueBySupplier: (code, sectionId) => ["stock", "value-by-supplier", code, sectionId ?? null],
  returnables: (code) => ["stock", "returnables", code],
  reorder: (code) => ["stock", "reorder", code],
  erpPending: (code) => ["stock", "erp-pending", code],
  history: (partId) => ["stock", "history", partId],
  locations: (partId) => ["stock", "locations", partId],
  facts: (code) => ["stock", "facts", code],
};

// A shared empty list, so "no data yet" is the same array every render and
// memos keyed on it don't recompute for nothing.
export const NO_ROWS = Object.freeze([]);

export const fetchStockList = (code, sectionId, sectionIds) =>
  spareStockService.list({
    store_code: code,
    section_id: sectionId ?? undefined,
    section_ids: sectionIds && sectionIds.length ? sectionIds.join(",") : undefined,
  }).then((r) => r.data.data || []);

/** The store's full stock list, or one section's, or a section GROUP's
 *  (sectionIds) — the shared, cached copy. */
export function useStockList(code, sectionId = null, { enabled = true, sectionIds = null } = {}) {
  return useQuery({
    queryKey: stockKeys.list(code, sectionId, sectionIds),
    queryFn: () => fetchStockList(code, sectionId, sectionIds),
    enabled: enabled && Boolean(code),
    // The big (~4,800-row) list — keep it fresh for the whole work session so
    // moving between sections / screens re-uses the cache instead of refetching.
    // A real change still refreshes it at once: an app write invalidates it, and
    // the SSE "stock" push (useRealtime) invalidates across tabs.
    staleTime: 5 * 60_000,
    // Keep the cached list in memory well past the stale window, so leaving for
    // the Live Dashboard (or another store) and coming back is instant instead
    // of refetching 2 MB — the default 5-min GC dropped it after a short detour.
    gcTime: 30 * 60_000,
  });
}

/** Refresh every stock screen — call after a write this browser made. */
export const invalidateStock = (qc) => qc.invalidateQueries({ queryKey: stockKeys.all });

/** The dashboard's one-call overview (kpis, health, attention, value, ERP, data
 *  quality) — under "stock", so a stock push refreshes it with everything else. */
export function useStockOverview(code, sectionId = null, { enabled = true, sectionIds = null } = {}) {
  return useQuery({
    queryKey: stockKeys.overview(code, sectionId, sectionIds),
    queryFn: () => spareStockService.overview(code, sectionId ?? undefined, sectionIds).then((r) => r.data.data),
    enabled: enabled && Boolean(code),
    // Same as the list: cached for the session; writes / the SSE push refresh it.
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  });
}

/** The management block in one call (action tracker, excess aging, monthly in
 *  vs out, scan adoption) — under "stock", so a stock push, or an owner / target
 *  an administrator just saved, refreshes it on every open screen. */
export function useSpareManagement(code, sectionId = null, { enabled = true, sectionIds = null } = {}) {
  return useQuery({
    queryKey: stockKeys.management(code, sectionId, sectionIds),
    // Silent: each screen shows a failure itself (the Action Tracker's error
    // panel, "—" owners on the dashboard board). A toast as well would fire
    // once per retry, and again on every stock push that refetches this.
    queryFn: () => managementService.get(code, sectionId, sectionIds, { silent: true }).then((r) => r.data.data),
    enabled: enabled && Boolean(code),
    // Overdue flags and day counts are worked out against today's plant date,
    // so this is held for a minute, not for the session like the overview.
    staleTime: 60_000,
  });
}
