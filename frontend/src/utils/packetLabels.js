// Packet / individual-unit QR labels (the store's spec of 27 Oct 2026). The QR
// carries the packet's own code — TB + date + Part No. + label no. since 28 Oct
// 2026 (TB28102026CNTR0332-01; older ones SPK-XXXXXXXX) — then the spec and the
// location ("naye date wala and spec and location"): packet.qr from the server,
// read by the app up to the first "|". Every packet scans as itself; the label shows, as text, the Part No., description, the
// part's specification and model no. (the store, 28 Oct 2026: "qr me spec /
// model no bhi aana chahiye"), the packet quantity and the storage location —
// never a price. No quantity line on any label ("1 nos individual nhi aana
// chahiye" … "qr me qty-nos ye nhi chahiye"), and every line is bold — the
// description, spec and model like the Part No. ("code no. k saath spec/model
// bhi bold kar de" … "phir description k ko bhi bold kar de", 28 Oct 2026). The code is printed small under the QR, for reading out if the QR is
// damaged. The QR's own white border is two modules —
// the label's margin adds the rest — so a small label's QR stays big enough
// to scan.
//
// Printed on the label printer only, one label per page, in the size picked for
// the job (28 Oct 2026: "lable tag par niklenge to size chote part and bade part
// k according adjustable hona chahiye a4 paper par nhi nikalenge"). A small
// label keeps what can still be read rather than shrinking every line to dust.
//
// Few lines, so they print clearly (the store, 4 Nov 2026: "jo print hoga us
// lable ... text kam rkhten h jisse print sahi ho"): the QR with its code under
// it (the code in bold), the Part No., the description — whole, its type
// smaller when it is long — and the location, on every size. No spec / model line on the label any more; the QR itself still carries
// the spec, and a scan shows everything.
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
  FULL: { ref: [100, 50], code: 6, pn: 13, ds: 9, loc: 10 },
  MID: { ref: [75, 38], code: 5.5, pn: 11, ds: 8, loc: 8.5 },
  SMALL: { ref: [50, 25], code: 5, pn: 9, ds: 6.5, loc: 7 },
};

export function labelTier(h) {
  return h >= 42 ? "FULL" : h >= 30 ? "MID" : "SMALL";
}

// The lines a text takes at `perLine` letters a line, words kept whole where
// they fit (a word longer than a line breaks anywhere, as the label's CSS does).
function linesFor(text, perLine) {
  let lines = 1;
  let used = 0;
  for (const word of String(text || "").split(/\s+/).filter(Boolean)) {
    let n = word.length;
    if (used && used + 1 + n <= perLine) { used += 1 + n; continue; }
    if (used) { lines += 1; used = 0; }
    while (n > perLine) { lines += 1; n -= perLine; }
    used = n;
  }
  return lines;
}

// The description whole, never cut: its type shrinks until every word fits
// the room beside the QR (the store, 4 Nov 2026: "description choti kar dena
// agar lambi h to but puri honi chahiye"). A bold capital is about 0.66 em
// wide; a line is 1.15 em high.
function fitPt(text, widthMm, heightMm, maxPt, minPt = 4.5) {
  for (let size = maxPt; size > minPt; size -= 0.25) {
    const em = size * 0.3528;
    const perLine = Math.max(1, Math.floor(widthMm / (em * 0.66)));
    if (linesFor(text, perLine) * em * 1.15 <= heightMm) return size;
  }
  return minPt;
}

function face(p, dsPt) {
  const part = p.part || {};
  return `<div class="lbl">
    <div class="q">${qrSvgString(p.qr || p.code, { size: 200, quiet: 2 })}<div class="code">${esc(p.code)}</div></div>
    <div class="t">
      <div class="pn">${esc(part.part_no)}</div>
      ${part.part_name ? `<div class="ds" style="font-size:${dsPt(part.part_name).toFixed(2)}pt">${esc(part.part_name)}</div>` : ""}
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
  // The code line under the QR fits the QR's width, however long the code:
  // a monospace letter is about 0.6 em wide.
  const longest = Math.max(...packets.map((p) => String(p.code || "").length), 8);
  const codePt = Math.min(t.code * k, (qr / (longest * 0.6)) / 0.3528);
  // The room the description has: the text column's width, and its height
  // less the Part No. and the location lines.
  const gap = tier === "SMALL" ? 1.5 : 2.5;
  const colW = w - 2 * (pad + 0.5) - gap - qr;
  const mm = (v) => v * k * 0.3528;
  const colH = h - 2 * pad - mm(t.pn) * 1.05 - mm(t.loc) * 1.2 - 0.7 - 0.6;
  const dsPt = (text) => fitPt(text, colW, colH, t.ds * k);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html, body { margin: 0; padding: 0; background: #fff; }
    @page { size: ${w}mm ${h}mm; margin: 0; }
    .lbl { display: flex; align-items: center; overflow: hidden; font-family: Arial, Helvetica, sans-serif; color: #000;
           width: ${w}mm; height: ${h}mm; padding: ${pad}mm ${pad + 0.5}mm; gap: ${gap}mm;
           page-break-after: always; break-after: page; }
    .lbl:last-child { page-break-after: auto; break-after: auto; }
    .q { flex: none; width: ${qr.toFixed(1)}mm; display: flex; flex-direction: column; align-items: center; }
    .q svg { display: block; width: 100%; height: auto; }
    .code { font-family: "Courier New", monospace; font-weight: 700; color: #000; margin-top: 0.3mm;
            font-size: ${codePt.toFixed(1)}pt; white-space: nowrap; }
    .t { min-width: 0; flex: 1; display: flex; flex-direction: column; justify-content: center; }
    .pn { font-weight: 700; overflow-wrap: anywhere; line-height: 1.05; font-size: ${pt(t.pn)}pt; }
    .ds { font-weight: 700; overflow-wrap: anywhere; line-height: 1.15; margin-top: 0.7mm; }
    .loc { font-weight: 700; margin-top: 0.6mm; overflow-wrap: anywhere; font-size: ${pt(t.loc)}pt; }
    ${fit}
  </style></head><body>${packets.map((p) => face(p, dsPt)).join("")}</body></html>`;
}
