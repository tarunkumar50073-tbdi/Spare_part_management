// Formatting shared by the spare screens — one definition, so a figure reads
// the same on the dashboard, in a drill and in the part drawer.

export const num = (v) => (v == null ? "—" : Number(v).toLocaleString("en-IN"));

export const money = (v) =>
  v == null ? "—" : `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

// Crores and lakhs for the headline figure, the way the mock-up reads it and
// the way the plant says it out loud. A KPI tile is 211px wide at 1440 — the
// full ₹29,34,640 does not fit beside the badge, and a clipped number is worse
// than a rounded one. The exact rupee stays in the tooltip and the export.
export const compactMoney = (v) => {
  if (v == null) return "—";
  const n = Number(v);
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  if (n >= 1e3) return `₹${(n / 1e3).toFixed(1)} K`;
  return money(n);
};

// Database times reach the browser as ISO strings with NO zone
// ("2026-08-10T09:50:50.510103") but they are UTC — the backend stamps every row
// with utcnow(). The browser reads a zone-less date-time as LOCAL time, which
// showed every stamp 5½ hours early in IST. So a zone-less date-time is marked
// UTC here; date-only strings and strings already carrying "Z" / an offset are
// left alone. Do NOT use it for plant-local values (the shift-start "since",
// supplier vehicle windows) — those are local by design.
export const parseServerTime = (v) => {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v;
  const s = String(v).trim().replace(" ", "T");
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const hasTime = /T\d{2}:\d{2}/.test(s);
  const norm = s.replace(/(\.\d{3})\d+/, "$1");   // Python sends 6 fraction digits
  const d = new Date(hasTime && !zoned ? `${norm}Z` : norm);
  return Number.isNaN(d.getTime()) ? null : d;
};

// A server timestamp in the plant's clock.
export const fmtStamp = (iso) => {
  if (!iso) return "—";
  const d = parseServerTime(iso);
  if (!d) return "—";
  return d.toLocaleString("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
};

// Date-only (gate-entry date carries no time), so fmtStamp's 00:00 is dropped.
export const fmtDate = (iso) => {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  });
};

// The ledger mixes ERP gate dates (date-only) with store events (timestamped);
// show each at its own precision.
export const fmtWhen = (ts) => (!ts ? "—" : ts.length <= 10 ? fmtDate(ts) : fmtStamp(ts));

export const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
