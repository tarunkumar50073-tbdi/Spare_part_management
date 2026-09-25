import { useQuery } from "@tanstack/react-query";
import { spareStockService } from "../services/spareStockService.js";

// One client cache for everything a stock screen shows. Every key starts with
// "stock", so ONE invalidation — after a local write, or when the server pushes
// a "stock" event over SSE (issue, receive, return, count, location, import,
// part-master edit) — refreshes every open screen at once. The ~4,800-row store
// list lives under a single key, fetched once and shared by the dashboard,
// Store Stock, Part Ledger and the Ctrl+K palette instead of once per screen.
export const stockKeys = {
  all: ["stock"],
  list: (code, sectionId) => ["stock", "list", code, sectionId ?? null],
  summary: (code, sectionId) => ["stock", "summary", code, sectionId ?? null],
  belowMin: (code, sectionId) => ["stock", "below-min", code, sectionId ?? null],
  ops: (code) => ["stock", "ops", code],
  overview: (code, sectionId) => ["stock", "overview", code, sectionId ?? null],
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

export const fetchStockList = (code, sectionId) =>
  spareStockService.list({ store_code: code, section_id: sectionId ?? undefined })
    .then((r) => r.data.data || []);

/** The store's (or one section's) full stock list — the shared, cached copy. */
export function useStockList(code, sectionId = null, { enabled = true } = {}) {
  return useQuery({
    queryKey: stockKeys.list(code, sectionId),
    queryFn: () => fetchStockList(code, sectionId),
    enabled: enabled && Boolean(code),
  });
}

/** Refresh every stock screen — call after a write this browser made. */
export const invalidateStock = (qc) => qc.invalidateQueries({ queryKey: stockKeys.all });

/** The dashboard's one-call overview (kpis, health, attention, value, ERP, data
 *  quality) — under "stock", so a stock push refreshes it with everything else. */
export function useStockOverview(code, sectionId = null, { enabled = true } = {}) {
  return useQuery({
    queryKey: stockKeys.overview(code, sectionId),
    queryFn: () => spareStockService.overview(code, sectionId ?? undefined).then((r) => r.data.data),
    enabled: enabled && Boolean(code),
  });
}
