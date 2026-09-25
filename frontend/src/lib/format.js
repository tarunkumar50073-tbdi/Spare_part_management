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

// Times come off the ISO string as stored rather than through the browser's
// timezone — the same reason the vehicle in/out times are read literally.
export const fmtStamp = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
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
