import { parseServerTime } from "./format.js";

// Small, shared rules for reading a spare's master data on the inventory
// screens. Kept here so the table, its filters and its export can't disagree.

// "R3-S1-B2 (1)" -> rack "R3", bin "S1-B2 (1)". About 700 parts carry free
// text instead ("ABS PIPE RACK", "TEMP", "R15-S12" without a bin) — those
// show whole as the rack with no bin, rather than being split wrongly.
export function splitLocation(loc) {
  const t = (loc || "").trim();
  if (!t) return { rack: null, bin: null };
  const m = t.match(/^(R\s*\d+)\s*-\s*(.+)$/i);
  return m ? { rack: m[1].replace(/\s+/g, "").toUpperCase(), bin: m[2].trim() } : { rack: t, bin: null };
}

// Master-data gaps an inventory view can be filtered to — the same five fields
// the dashboard's completeness figure is built from.
export const GAP_FILTERS = [
  { key: "", label: "Any data" },
  { key: "max", label: "No Max set", test: (r) => !(Number(r.max_stock_level) > 0) },
  { key: "min", label: "No Min set", test: (r) => !(Number(r.min_stock_level) > 0) },
  { key: "reorder", label: "No Reorder level", test: (r) => r.reorder_level == null },
  { key: "rate", label: "No Rate", test: (r) => r.unit_price == null },
  { key: "location", label: "No Location", test: (r) => !(r.location || "").trim() },
];

export const matchesGap = (row, gap) => {
  const g = GAP_FILTERS.find((f) => f.key === gap);
  return !g || !g.test || g.test(row);
};

// Worst first — the order a status column sorts in.
export const STATUS_RANK = {
  "Out of Stock": 0, "Below Minimum": 1, "Reorder": 2, "Above Maximum": 3, "Healthy": 4, "Discontinued": 5,
  "Not Counted": 6,
};

// A server timestamp's date in the plant's clock (the stamp is UTC — see
// parseServerTime), so an issue at 01:00 IST lands on its own day.
export const fmtDay = (iso) => {
  const d = parseServerTime(iso);
  return d ? d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" }) : null;
};

export const typeOf = (r) => (r.sub_category || "").trim() || "Uncategorised";
