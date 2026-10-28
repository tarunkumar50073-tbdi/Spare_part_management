// Packet / individual-unit QR labels (the store's spec of 27 Oct 2026). The QR
// carries the packet's own code (SPK-XXXXXXXX), so every packet of the same part
// scans as itself; the label shows, as text, the Part No., description, the
// part's specification and model no. (the store, 28 Oct 2026: "qr me spec /
// model no bhi aana chahiye"), the packet quantity and the storage location —
// never a price. No quantity line on any label ("1 nos individual nhi aana
// chahiye" … "qr me qty-nos ye nhi chahiye"), and the spec / model are bold
// like the Part No. ("code no. k saath spec/model bhi bold kar de", 28 Oct
// 2026). The code is printed small under the QR, for reading out if the QR is
// damaged. The QR's own white border is two modules —
// the label's margin adds the rest — so a small label's QR stays big enough
// to scan.
//
// Printed on the label printer only, one label per page, in the size picked for
// the job (28 Oct 2026: "lable tag par niklenge to size chote part and bade part
// k according adjustable hona chahiye a4 paper par nhi nikalenge"). A small
// label keeps what can still be read — the Part No., spec / model and location
// — rather than shrinking every line to dust:
//   FULL   (height 42 mm and up) every line, the description over two lines
//   MID    (30 to 42 mm)          description on one line, spec and model on one
//   SMALL  (under 30 mm)          Part No., spec / model, location
import { qrSvgString } from "./barcodeRender.js";

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");


// The sizes offered on the print dialog, smallest first (mm).
export const LABEL_SIZES = [
  { key: "S", label: "Small part", w: 50, h: 25 },
  { key: "M", label: "Medium", w: 75, h: 50 },
  { key: "L", label: "Large part", w: 100, h: 50 },
];
export const LABEL_LIMITS = { minW: 30, maxW: 150, minH: 15, maxH: 100 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Type sizes (pt) of each tier at its reference size, grown or shrunk a little
// with the label actually picked.
const TIERS = {
  FULL: { ref: [100, 50], code: 6, pn: 13, ds: 8.5, sp: 8.5, loc: 10, dsLines: 2 },
  MID: { ref: [75, 38], code: 5.5, pn: 11, ds: 7.5, sp: 7.5, loc: 8.5, dsLines: 1 },
  SMALL: { ref: [50, 25], code: 5, pn: 9, ds: 0, sp: 6.5, loc: 7, dsLines: 0 },
};

export function labelTier(h) {
  return h >= 42 ? "FULL" : h >= 30 ? "MID" : "SMALL";
}

function face(p, tier) {
  const part = p.part || {};
  const t = TIERS[tier];
  const spec = part.specification ? `Spec: ${part.specification}` : "";
  const model = part.model_no ? `Model: ${part.model_no}` : "";
  const specLines = tier === "FULL"
    ? [spec, model].filter(Boolean)
    : [[part.specification, part.model_no].filter(Boolean).join(" · ")].filter(Boolean);
  return `<div class="lbl">
    <div class="q">${qrSvgString(p.code, { size: 200, quiet: 2 })}<div class="code">${esc(p.code)}</div></div>
    <div class="t">
      <div class="pn">${esc(part.part_no)}</div>
      ${t.dsLines ? `<div class="ds">${esc(part.part_name)}</div>` : ""}
      ${specLines.map((s) => `<div class="sp">${esc(s)}</div>`).join("")}
      ${p.location ? `<div class="loc">${esc(p.location)}</div>` : ""}
    </div>
  </div>`;
}

// One label per page at `size` ({ w, h } in mm). `zoom` scales the page for an
// on-screen preview only; the print itself is always at true size.
export function packetLabelsHtml(packets, { size, zoom } = {}) {
  const w = clamp(Number(size?.w) || 100, LABEL_LIMITS.minW, LABEL_LIMITS.maxW);
  const h = clamp(Number(size?.h) || 50, LABEL_LIMITS.minH, LABEL_LIMITS.maxH);
  const tier = labelTier(h);
  const t = TIERS[tier];
  const k = clamp(Math.min(w / t.ref[0], h / t.ref[1]), 0.85, 1.5);
  const pt = (v) => (v * k).toFixed(1);
  const pad = tier === "SMALL" ? 1.2 : 2;
  const codeMm = t.code * k * 0.42;                        // the code line's height under the QR
  const qr = Math.max(10, Math.min(h - 2 * pad - codeMm - 0.5, w * 0.42));
  const fit = zoom ? `body { zoom: ${zoom}; }` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html, body { margin: 0; padding: 0; background: #fff; }
    @page { size: ${w}mm ${h}mm; margin: 0; }
    .lbl { display: flex; align-items: center; overflow: hidden; font-family: Arial, Helvetica, sans-serif; color: #000;
           width: ${w}mm; height: ${h}mm; padding: ${pad}mm ${pad + 0.5}mm; gap: ${tier === "SMALL" ? 1.5 : 2.5}mm;
           page-break-after: always; break-after: page; }
    .lbl:last-child { page-break-after: auto; break-after: auto; }
    .q { flex: none; width: ${qr.toFixed(1)}mm; display: flex; flex-direction: column; align-items: center; }
    .q svg { display: block; width: 100%; height: auto; }
    .code { font-family: "Courier New", monospace; letter-spacing: 0.2px; color: #333; margin-top: 0.3mm;
            font-size: ${pt(t.code)}pt; white-space: nowrap; }
    .t { min-width: 0; flex: 1; display: flex; flex-direction: column; justify-content: center; }
    .pn { font-weight: 700; overflow-wrap: anywhere; line-height: 1.05; font-size: ${pt(t.pn)}pt; }
    .ds { overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: ${t.dsLines || 1};
          line-height: 1.15; margin-top: 0.7mm; overflow-wrap: anywhere; font-size: ${pt(t.ds || 7)}pt; }
    .sp { font-weight: 700; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; margin-top: 0.5mm; line-height: 1.1;
          font-size: ${pt(t.sp)}pt; }
    .loc { font-weight: 700; margin-top: 0.6mm; overflow-wrap: anywhere; font-size: ${pt(t.loc)}pt; }
    ${fit}
  </style></head><body>${packets.map((p) => face(p, tier)).join("")}</body></html>`;
}
