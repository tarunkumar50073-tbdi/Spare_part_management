// Packet / individual-unit QR labels (the store's spec of 27 Oct 2026). The QR
// carries the packet's own code (SPK-XXXXXXXX), so every packet of the same part
// scans as itself; the label shows, as text, the Part No., description, the
// packet quantity and the storage location — never a price. The code is
// printed small under the QR, for reading out if the QR is damaged.
//
// Two layouts, both through printLabels (barcodeRender.js):
//   "A4"    — a sheet of 24 (3 x 8, 70 x 37 mm each) for an office printer;
//   "LABEL" — one label per page at the label printer's size (label-config,
//             100 x 50 mm by default), as the part labels print.
import { labelFaceSize, qrSvgString } from "./barcodeRender.js";

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const qtyText = (p) => {
  const q = Number(p.qty);
  const n = Number.isInteger(q) ? q : q.toFixed(2);
  return p.kind === "UNIT" ? `1 ${p.uom || "NOS"} · Individual` : `Qty ${n} ${p.uom || ""}`.trim();
};

function face(p, cls) {
  const part = p.part || {};
  return `<div class="lbl ${cls}">
    <div class="q">${qrSvgString(p.code, { size: 200 })}<div class="code">${esc(p.code)}</div></div>
    <div class="t">
      <div class="pn">${esc(part.part_no)}</div>
      <div class="ds">${esc(part.part_name)}</div>
      <div class="qty">${esc(qtyText(p))}</div>
      ${p.location ? `<div class="loc">${esc(p.location)}</div>` : ""}
    </div>
  </div>`;
}

const BASE = `
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .lbl { display: flex; align-items: center; overflow: hidden; font-family: Arial, Helvetica, sans-serif; color: #000; }
  .q { flex: none; display: flex; flex-direction: column; align-items: center; }
  .q svg { display: block; width: 100%; height: auto; }
  .code { font-family: "Courier New", monospace; letter-spacing: 0.2px; color: #333; margin-top: 0.3mm; }
  .t { min-width: 0; display: flex; flex-direction: column; justify-content: center; }
  .pn { font-weight: 700; overflow-wrap: anywhere; line-height: 1.05; }
  .ds { overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
        line-height: 1.15; margin-top: 0.8mm; overflow-wrap: anywhere; }
  .qty { font-weight: 700; margin-top: 1mm; }
  .loc { font-weight: 700; margin-top: 0.8mm; overflow-wrap: anywhere; }
`;

// `zoom` shrinks the page for an on-screen preview only (an A4 sheet is wider
// than the dialog); the print itself is always at true size.
export function packetLabelsHtml(packets, { layout = "A4", config, zoom } = {}) {
  const fit = zoom ? `body { zoom: ${zoom}; }` : "";
  if (layout === "LABEL") {
    const { w, h } = labelFaceSize(config);
    const qr = Math.max(14, Math.min(h - 8, w * 0.42));
    const scale = h / 50;
    return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE}
      @page { size: ${w}mm ${h}mm; margin: 0; }
      .one { width: ${w}mm; height: ${h}mm; padding: 2mm 2.5mm; gap: 2.5mm; page-break-after: always; break-after: page; }
      .one:last-child { page-break-after: auto; break-after: auto; }
      .one .q { width: ${qr}mm; }
      .one .code { font-size: ${(6 * scale).toFixed(1)}pt; }
      .one .pn { font-size: ${(13 * scale).toFixed(1)}pt; }
      .one .ds { font-size: ${(8.5 * scale).toFixed(1)}pt; }
      .one .qty { font-size: ${(11 * scale).toFixed(1)}pt; }
      .one .loc { font-size: ${(10 * scale).toFixed(1)}pt; }
      ${fit}
    </style></head><body>${packets.map((p) => face(p, "one")).join("")}</body></html>`;
  }
  // A4: 24 a sheet, 3 across and 8 down, each 70 x 37.1 mm.
  const per = 24;
  const sheets = [];
  for (let i = 0; i < packets.length; i += per) sheets.push(packets.slice(i, i + per));
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE}
    @page { size: A4; margin: 0; }
    .sheet { width: 210mm; height: 297mm; display: grid; grid-template-columns: repeat(3, 70mm);
             grid-template-rows: repeat(8, 37.1mm); page-break-after: always; break-after: page; }
    .sheet:last-child { page-break-after: auto; break-after: auto; }
    .cell { width: 70mm; height: 37.1mm; padding: 2mm 2.5mm; gap: 2mm; border: 0.2mm dashed #bbb; }
    .cell .q { width: 26mm; }
    .cell .code { font-size: 5.5pt; }
    .cell .pn { font-size: 10.5pt; }
    .cell .ds { font-size: 7pt; }
    .cell .qty { font-size: 9pt; }
    .cell .loc { font-size: 8pt; }
    ${fit}
  </style></head><body>${sheets.map((s) => `<div class="sheet">${s.map((p) => face(p, "cell")).join("")}</div>`).join("")}</body></html>`;
}
