// Label rendering + print, kept out of components so both the on-screen
// preview and the print document build the same crisp vector code.
//
// The code (QR, or a 1D Code-128 / Code-39 when the admin picks one) encodes
// ONLY the value passed in (the internal Part No.). The label shows, as text,
// the Part No., a short description and the rack location (spec 3 / 29) —
// never price, rate, supplier, min / max / reorder or ERP quantities. Line /
// machine / issue / rework status are read from the database on scan, never
// printed. Printing goes through a hidden iframe with an exact @page size so it
// prints at true size with no app CSS bleed (works on tablet Chrome/Edge and
// desktop). The label size comes from the backend label-config, never
// hardcoded here.
import JsBarcode from "jsbarcode";
import { QRCodeDecoderErrorCorrectionLevel, QRCodeEncoder } from "@zxing/library";

// Render a QR code as an SVG string. The payload is the Part No only (the QR is
// the part's permanent identity; everything dynamic is read from the database
// when it is scanned). Error correction M; 4-module quiet zone; vector, so it
// stays sharp on thermal paper. `size` is only the default display size — the
// label CSS scales it.
export function qrSvgString(value, { size = 160, quiet = 4 } = {}) {
  const matrix = QRCodeEncoder.encode(String(value), QRCodeDecoderErrorCorrectionLevel.M).getMatrix();
  const n = matrix.getWidth();
  let d = "";
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (matrix.get(x, y) === 1) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }
  const dim = n + quiet * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${size}" height="${size}" `
    + `shape-rendering="crispEdges" role="img" aria-label="QR ${escapeHtml(value)}">`
    + `<rect width="${dim}" height="${dim}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Render a 1D barcode as an SVG string (vector — sharp on thermal paper).
// Code-39 cannot carry every character a Part No. may hold (lower case, "/"
// in some positions…); such a value falls back to Code-128 rather than
// printing a blank label.
export function barcodeSvgString(value, { barWidth = 2, height = 60, format = "CODE128" } = {}) {
  const render = (fmt) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    JsBarcode(svg, String(value), {
      format: fmt, displayValue: false, width: barWidth, height, margin: 0,
    });
    return new XMLSerializer().serializeToString(svg);
  };
  if (format === "CODE39") {
    try {
      return render("CODE39");
    } catch {
      /* not Code-39 encodable — Code-128 carries any printable value */
    }
  }
  return render("CODE128");
}

// ---- label geometry --------------------------------------------------------

const PT_MM = 25.4 / 72;            // 1 typographic point in millimetres
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// The code the label carries. QR is the default (contract: the QR is the
// part's permanent identity); CODE128 / CODE39 stay selectable in Settings.
export function labelSymbology(config) {
  const s = String(config?.symbology || "QR").toUpperCase();
  return s === "CODE39" ? "CODE39" : s === "QR" ? "QR" : "CODE128";
}

// Geometry of ONE label, in mm / pt — shared by the print document and the
// on-screen preview (which scales it to px), so what the operator previews is
// what comes out of the printer. On a landscape label (100 x 50 mm) the QR
// sits on the left at the full label height with the text beside it; on a
// square / portrait label it sits above the text. A 1D barcode needs width, so
// it always runs across the top. The Part No. is set as big as its column
// allows — a long number shrinks rather than wrapping mid-code.
export function labelLayout(config, partNo = "") {
  const w = Number(config?.width_mm) || 100;
  const h = Number(config?.height_mm) || 50;
  const symbology = labelSymbology(config);
  const qr = symbology === "QR";
  const pad = clamp(h * 0.05, 1.5, 3);
  const side = qr && w >= h * 1.25;
  const showLocation = config?.show_location !== false;

  let codeMm = null;      // QR edge (square)
  let barMaxMm = null;    // 1D barcode max height
  if (qr) codeMm = side ? h - pad * 2 : Math.min(w - pad * 2, h * 0.5);
  else barMaxMm = h * (showLocation ? 0.4 : 0.48);

  const textW = side ? w - codeMm - pad * 3 : w - pad * 2;
  const chars = Math.max(4, String(partNo || "").length);
  const fitPt = textW / (chars * 0.62 * PT_MM);          // bold Arial ≈ 0.62em per char
  const pnCap = side ? h * 0.4 : h * 0.24;
  const pnPt = Math.round(clamp(Math.min(fitPt, pnCap), 7, 40));
  const dsPt = Math.round(clamp(side ? h * 0.19 : h * 0.14, 6, 14));
  const locPt = Math.round(clamp(side ? h * 0.2 : h * 0.14, 6, 14));
  const capPt = Math.round(clamp(dsPt * 0.7, 5, 9));
  return {
    w, h, pad, symbology, qr, side, codeMm, barMaxMm, textW,
    pnPt, dsPt, locPt, capPt, descLines: side ? 3 : 2, showLocation,
  };
}

// Millimetres a point size takes — the preview converts both to px.
export const ptToMm = (pt) => pt * PT_MM;

// The description as printed: at most description_max_chars, and a cut one
// ends in "…" so a reader can tell it was shortened.
export function labelDescription(description, config) {
  const max = Number(config?.description_max_chars) || 48;
  const d = String(description || "").trim();
  return d.length > max ? `${d.slice(0, Math.max(1, max - 1)).trimEnd()}…` : d;
}

// ---- print document --------------------------------------------------------

// One label's markup: code + Part No + short description + location only.
function labelMarkup({ barcodeValue, partNo, description, location }, config) {
  const L = labelLayout(config, partNo);
  const showPn = config?.show_part_no !== false;
  const showDs = config?.show_description !== false;
  const desc = labelDescription(description, config);
  const value = barcodeValue || partNo;
  const code = L.qr
    ? `<div class="qr" style="width:${L.codeMm}mm;height:${L.codeMm}mm">${qrSvgString(value)}</div>`
    : `<div class="bar" style="max-height:${L.barMaxMm}mm">${barcodeSvgString(value, {
      barWidth: 2, height: Math.round(L.h * 2.4), format: L.symbology,
    })}</div>`;
  return `<div class="lbl ${L.side ? "side" : "stack"}" style="padding:${L.pad}mm;gap:${L.pad}mm">
      ${code}
      <div class="txt"${L.side ? ` style="width:${L.textW}mm"` : ""}>
        ${showPn ? `<div class="cap" style="font-size:${L.capPt}pt">Part No.:</div>
        <div class="pn" style="font-size:${L.pnPt}pt">${escapeHtml(partNo)}</div>` : ""}
        ${showDs && desc ? `<div class="ds" style="font-size:${L.dsPt}pt;-webkit-line-clamp:${L.descLines}">${escapeHtml(desc)}</div>` : ""}
        ${L.showLocation ? `<div class="loc" style="font-size:${L.locPt}pt">Location: ${escapeHtml(location || "—")}</div>` : ""}
      </div>
    </div>`;
}

// Many different parts' labels in ONE print job (the stock list's bulk
// action): `labels` = [{ barcode_value, part_no, part_name, location, copies }],
// each label exactly width_mm x height_mm, one per page.
export function buildLabelsHtml(labels, config) {
  const body = labels.map((l) => Array.from({ length: Math.max(1, l.copies || 1) },
    () => labelMarkup({
      barcodeValue: l.barcode_value || l.part_no, partNo: l.part_no,
      description: l.part_name, location: l.location,
    }, config))
    .join("")).join("");
  return labelDocument(body, config);
}

// Build a self-contained print document: `copies` labels, each exactly
// width_mm x height_mm, showing code + Part No + description + location only.
export function buildLabelHtml({ barcodeValue, partNo, description, location, config, copies = 1 }) {
  const one = labelMarkup({ barcodeValue, partNo, description, location }, config);
  const body = Array.from({ length: Math.max(1, copies) }, () => one).join("");
  return labelDocument(body, config);
}

function labelDocument(body, config) {
  const w = Number(config?.width_mm) || 100;
  const h = Number(config?.height_mm) || 50;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${w}mm ${h}mm; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; }
    .lbl { width: ${w}mm; height: ${h}mm; page-break-after: always; break-after: page; overflow: hidden;
      display: flex; font-family: Arial, Helvetica, sans-serif; color: #000; background: #fff; }
    .lbl:last-child { page-break-after: auto; break-after: auto; }
    .lbl.side { flex-direction: row; align-items: center; }
    .lbl.stack { flex-direction: column; align-items: center; justify-content: center; }
    .qr { flex: none; }
    .qr svg { display: block; width: 100%; height: 100%; }
    .bar { width: 100%; display: flex; justify-content: center; flex: none; }
    .bar svg { width: 100%; height: auto; max-height: inherit; }
    .txt { min-width: 0; display: flex; flex-direction: column; justify-content: center; }
    .lbl.stack .txt { width: 100%; align-items: center; text-align: center; }
    .cap { line-height: 1; color: #000; }
    .pn { font-weight: 700; line-height: 1.05; letter-spacing: 0.3px; overflow-wrap: anywhere; margin-top: 0.4mm; }
    .ds { line-height: 1.15; margin-top: 1.2mm; overflow: hidden; display: -webkit-box;
      -webkit-box-orient: vertical; overflow-wrap: anywhere; }
    .loc { font-weight: 700; line-height: 1.1; margin-top: 1.2mm; overflow-wrap: anywhere; }
  </style></head><body>${body}</body></html>`;
}

// Print an HTML document via a hidden iframe, then clean up. The browser can
// not tell the page whether the label actually came out, so callers ask the
// operator afterwards and only then record the print.
export function printLabels(html) {
  const iframe = document.createElement("iframe");
  Object.assign(iframe.style, {
    position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0",
  });
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();
  // Give the browser a tick to lay out the SVG before printing.
  setTimeout(() => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } finally {
      setTimeout(() => iframe.remove(), 1500);
    }
  }, 300);
}
