// Packet / individual-unit QR labels (the store's spec of 27 Oct 2026). The QR
// carries the packet's own code — TB + date + Part No. + label no. since 28 Oct
// 2026 (TB20261110CNTR3953-01, date YYYYMMDD since 10 Nov 2026; older ones
// TB28102026CNTR0332-01 or SPK-XXXXXXXX) — then the spec and the
// location ("naye date wala and spec and location"). Since 13 Nov 2026 every size
// carries the tiny label's QR — code + model no. — "bade & chote lable par same
// chape" (tinyQr); packet.qr from the server is no longer printed,
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


// A tiny label for a cylinder or a thin part (the store, 4 Nov 2026: "mere paas
// aise cylender bhi h jisme 15*20 k qr lagenge"), upright or lying ("dono
// chahiye"): only the QR and the TB code under it. Its QR carries the code and
// the spec ("chote me qr k ander spec or hona chahiye") but not the location,
// to keep its dots as big as can be at 12-14 mm; every bigger label's QR keeps
// code | spec | location.
export const TINY = { pad: 0.6, maxCodePt: 5 };
// Every size prints the tiny label's layout - the QR and the code under it - since
// 13 Nov 2026 ("bade & chote lable par same chape" ... "bilkul chhote jaisa");
// a bigger label only gets a bigger QR and code.
export const codePtMax = (tier) => (tier === "TINY" ? TINY.maxCodePt : 10);

// The sizes offered on the print dialog, smallest first (mm).
export const LABEL_SIZES = [
  { key: "T1", label: "Tiny (upright)", w: 15, h: 20 },
  { key: "T2", label: "Tiny (lying)", w: 20, h: 15 },
  // The store's GoDEX G530 roll, 25 mm across x 15 mm a label (5 Nov 2026,
  // test print scanned): the tiny layout, QR (code + spec) and the TB code.
  { key: "T3", label: "Tiny roll", w: 25, h: 15 },
  { key: "S", label: "Small part", w: 50, h: 25 },
  { key: "M", label: "Medium", w: 75, h: 50 },
  { key: "L", label: "Large part", w: 100, h: 50 },
];
export const LABEL_LIMITS = { minW: 15, maxW: 150, minH: 15, maxH: 100 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Type sizes (pt) of each tier at its reference size, grown or shrunk a little
// with the label actually picked.
// The description a size smaller than before (4 Nov 2026: "description ka font
// size kam kar sakte ho"); a long one still shrinks further to stay whole.
export const TIERS = {
  FULL: { ref: [100, 50], code: 6, pn: 13, ds: 7.5, loc: 10 },
  MID: { ref: [75, 38], code: 5.5, pn: 11, ds: 6.5, loc: 8.5 },
  SMALL: { ref: [50, 25], code: 5, pn: 9, ds: 5.5, loc: 7 },
};

// TINY: narrower than 30 mm or lower than 20 mm — room for the QR alone.
export function labelTier(h, w = 100) {
  if (w < 30 || h < 20) return "TINY";
  return h >= 42 ? "FULL" : h >= 30 ? "MID" : "SMALL";
}

// What a tiny label's QR carries: the code, a space, then the spec (up to 68
// letters, as the server's own payload cuts it: "68 kar de", 10 Nov 2026) — the app
// reads the code up to the first space. Since 10 Nov 2026 ("bhai chote qr me
// bhi bda matter padh sakte h but isme kyun nhi pad paa rha" … "code+detail hi
// chahiye") the spec is written in the QR's own letters: capitals, digits,
// space and $ % * + - . / : — any other letter ( ) , # " … becomes a space and
// & a +. A QR of only those letters packs 11 bits per two letters instead of 8
// per letter: up to 89 of them fit a 33 x 33 QR (level M, as the encoder
// counts), whose squares can be 4 printer dots on the 15 mm roll; one letter
// more and it is 37 x 37 at 3 dots. So a tiny label's spec stops where the
// whole QR reaches 89 letters — 67 after a 21-letter code (bigger labels keep
// 68). The old "CODE | spec" labels still scan (the code ends at the "|").
export const QR_SPEC_MAX = 68;
const TINY_QR_MAX = 89;
const QR_LETTERS = /[^0-9A-Z $%*+\-./:]/g;
export const qrDetail = (s, max = QR_SPEC_MAX) => String(s || "").toUpperCase()
  .replace(/&/g, "+").replace(QR_LETTERS, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
export const tinyQr = (p) => {
  const code = String(p.code || "");
  const spec = qrDetail(p.part?.specification, Math.min(QR_SPEC_MAX, TINY_QR_MAX - code.length - 1));
  return [code, spec].filter(Boolean).join(" ");
};

// Squares on printer dots (the GoDEX G530 is 300 dpi). A square of 3 dots or
// a mix of 3 and 4 smudges on the thermal roll — the heat spreads the black
// into the white — and the scanner gun gives up; 4 dots and up reads.
export const PRINTER_DPI = 300;
export const DOTS_PER_MM = PRINTER_DPI / 25.4;
export const MIN_QR_DOTS = 3;
// The most whole dots a square can take for n squares to fit in maxMm (never
// under 3).
export function qrDots(n, maxMm) {
  return Math.max(MIN_QR_DOTS, Math.floor((maxMm * DOTS_PER_MM) / n));
}

// The tiny label: the QR (code and spec) and the code under it, the QR's
// squares as many whole printer dots as the label allows.
function tinyHtml(packets, w, h, zoom, maxPt = TINY.maxCodePt) {
  const pad = TINY.pad;
  const longest = Math.max(...packets.map((p) => String(p.code || "").length), 8);
  const codePt = Math.min(maxPt, ((w - 2 * pad) / (longest * 0.6)) / 0.3528);
  const codeMm = codePt * 0.3528 * 1.1;
  const room = Math.max(8, Math.min(w - 2 * pad, h - 2 * pad - codeMm - 0.3));
  const qrOf = (p) => {
    const svg = qrSvgString(tinyQr(p), { size: 200, quiet: 0 });
    const n = Number(svg.match(/viewBox="0 0 (\d+)/)[1]);
    return { svg, mm: (n * qrDots(n, (room * n) / (n + 1))) / DOTS_PER_MM };
  };
  const fit = zoom ? `body { zoom: ${zoom}; }` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html, body { margin: 0; padding: 0; background: #fff; }
    @page { size: ${w}mm ${h}mm; margin: 0; }
    .lbl { display: flex; flex-direction: column; align-items: center; justify-content: center; overflow: hidden;
           width: ${w}mm; height: ${h}mm; padding: ${pad}mm; gap: 0.3mm; color: #000;
           page-break-after: always; break-after: page; }
    .lbl:last-child { page-break-after: auto; break-after: auto; }
    .q svg { display: block; width: 100%; height: auto; }
    .code { font-family: "Courier New", monospace; font-weight: 700; white-space: nowrap; line-height: 1.1;
            font-size: ${codePt.toFixed(2)}pt; }
    ${fit}
  </style></head><body>${packets.map((p) => {
    const q = qrOf(p);
    return `<div class="lbl">
    <div class="q" style="width: ${q.mm.toFixed(2)}mm">${q.svg}</div>
    <div class="code">${esc(p.code)}</div>
  </div>`;
  }).join("")}</body></html>`;
}

// The lines a text takes at `perLine` letters a line, words kept whole where
// they fit (a word longer than a line breaks anywhere, as the label's CSS does).
export function linesFor(text, perLine) {
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
export function fitPt(text, widthMm, heightMm, maxPt, minPt = 4.5) {
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
    <div class="q">${qrSvgString(tinyQr(p), { size: 200, quiet: 2 })}<div class="code">${esc(p.code)}</div></div>
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
  const tier = labelTier(h, w);
  return tinyHtml(packets, w, h, zoom, codePtMax(tier));
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
