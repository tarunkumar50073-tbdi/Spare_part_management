// Code-128 label rendering + print, kept out of components so both the on-screen
// preview and the print document build the same crisp vector barcode.
//
// The barcode encodes ONLY the value passed in (the internal Part No.) — never
// description/price/stock/location. Printing goes through a hidden iframe with an
// exact @page size so it prints at true size with no app CSS bleed (works on
// tablet Chrome/Edge and desktop). The label size is passed in from the backend
// label-config, never hardcoded here.
import JsBarcode from "jsbarcode";

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Render a Code-128 barcode as an SVG string (vector — sharp on thermal paper).
export function barcodeSvgString(value, { barWidth = 2, height = 60 } = {}) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  JsBarcode(svg, String(value), {
    format: "CODE128", displayValue: false, width: barWidth, height, margin: 0,
  });
  return new XMLSerializer().serializeToString(svg);
}

// One label's markup: barcode + Part No + short description only.
function labelMarkup({ barcodeValue, partNo, description }, config) {
  const h = Number(config?.height_mm) || 50;
  const maxChars = Number(config?.description_max_chars) || 48;
  const showPn = config?.show_part_no !== false;
  const showDs = config?.show_description !== false;
  const desc = (description || "").slice(0, maxChars);
  const svg = barcodeSvgString(barcodeValue, { barWidth: 2, height: Math.round(h * 2.4) });
  return `<div class="lbl">
      <div class="bc">${svg}</div>
      ${showPn ? `<div class="pn">${escapeHtml(partNo)}</div>` : ""}
      ${showDs ? `<div class="ds">${escapeHtml(desc)}</div>` : ""}
    </div>`;
}

// Many different parts' labels in ONE print job (the stock list's bulk
// action): `labels` = [{ barcode_value, part_no, part_name, copies }], each
// label exactly width_mm x height_mm, one per page.
export function buildLabelsHtml(labels, config) {
  const body = labels.map((l) => Array.from({ length: Math.max(1, l.copies || 1) },
    () => labelMarkup({ barcodeValue: l.barcode_value, partNo: l.part_no, description: l.part_name }, config))
    .join("")).join("");
  return labelDocument(body, config);
}

// Build a self-contained print document: `copies` labels, each exactly
// width_mm x height_mm, showing barcode + Part No + short description only.
export function buildLabelHtml({ barcodeValue, partNo, description, config, copies = 1 }) {
  const one = labelMarkup({ barcodeValue, partNo, description }, config);
  const body = Array.from({ length: Math.max(1, copies) }, () => one).join("");
  return labelDocument(body, config);
}

function labelDocument(body, config) {
  const w = Number(config?.width_mm) || 100;
  const h = Number(config?.height_mm) || 50;
  const pnPt = Math.max(9, Math.round(h * 0.16));
  const dsPt = Math.max(6, Math.round(h * 0.09));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${w}mm ${h}mm; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; }
    .lbl { width: ${w}mm; height: ${h}mm; page-break-after: always; overflow: hidden;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 2mm; font-family: Arial, Helvetica, sans-serif; color: #000; background: #fff; }
    .lbl:last-child { page-break-after: auto; }
    .bc { width: 100%; display: flex; justify-content: center; }
    .bc svg { width: ${w - 6}mm; height: auto; max-height: ${Math.round(h * 0.55)}mm; }
    .pn { font-weight: 700; font-size: ${pnPt}pt; margin-top: 1mm; letter-spacing: 0.5px; }
    .ds { font-size: ${dsPt}pt; text-align: center; line-height: 1.1; margin-top: 0.5mm; }
  </style></head><body>${body}</body></html>`;
}

// Print an HTML document via a hidden iframe, then clean up.
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
