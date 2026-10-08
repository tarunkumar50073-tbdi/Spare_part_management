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

// The physical face size (mm) a tag kind prints at. The lot tag has its own
// paper (default 150 x 100 mm); every other kind uses the configured label size
// (default 100 x 50 mm). The bin sheet has its own builder and size.
export function labelFaceSize(config, kind = "plain") {
  if (kind === "lot") {
    return { w: Number(config?.lot_width_mm) || 150, h: Number(config?.lot_height_mm) || 100 };
  }
  return { w: Number(config?.width_mm) || 100, h: Number(config?.height_mm) || 50 };
}

// Geometry of ONE label, in mm / pt — shared by the print document and the
// on-screen preview (which scales it to px), so what the operator previews is
// what comes out of the printer. On a landscape label (100 x 50 mm) the QR
// sits on the left at the full label height with the text beside it; on a
// square / portrait label it sits above the text. A 1D barcode needs width, so
// it always runs across the top. The Part No. is set as big as its column
// allows — a long number shrinks rather than wrapping mid-code.
//
// `kind` picks what the text column carries below the description:
//   "plain"    — the rack location only (the original label; spec 3 / 29).
//   "location" — location + Min / Max stock levels (the permanent rack tag
//                that is laminated and fixed to the bin).
//   "lot"      — the lot quantity that came in on a gate entry, plus a small
//                gate-entry / date line (the paper tag for an arrived lot).
// A tag kind shows one line more than the plain label, so its description is
// given one fewer line to keep the text inside the same label height.
export function labelLayout(config, partNo = "", kind = "plain") {
  const { w, h } = labelFaceSize(config, kind);
  const symbology = labelSymbology(config);
  const qr = symbology === "QR";
  const pad = clamp(h * 0.05, 1.5, 3);
  const side = qr && w >= h * 1.25;
  const showLocation = config?.show_location !== false;

  let codeMm = null;      // QR edge (square)
  let barMaxMm = null;    // 1D barcode max height
  // On a big landscape tag (the lot tag) a full-height QR would swallow the
  // tag, so it is capped; the small labels keep their full-height QR.
  if (qr) codeMm = side ? Math.min(h - pad * 2, kind === "lot" ? h * 0.62 : Infinity) : Math.min(w - pad * 2, h * 0.5);
  else barMaxMm = h * (showLocation ? 0.4 : 0.48);

  const textW = side ? w - codeMm - pad * 3 : w - pad * 2;
  const chars = Math.max(4, String(partNo || "").length);
  const fitPt = textW / (chars * 0.62 * PT_MM);          // bold Arial ≈ 0.62em per char
  const pnCap = side ? h * 0.4 : h * 0.24;
  const pnPt = Math.round(clamp(Math.min(fitPt, pnCap), 7, 40));
  const dsPt = Math.round(clamp(side ? h * 0.19 : h * 0.14, 6, 14));
  const locPt = Math.round(clamp(side ? h * 0.2 : h * 0.14, 6, 14));
  const capPt = Math.round(clamp(dsPt * 0.7, 5, 9));
  const mmPt = Math.round(clamp(side ? h * 0.17 : h * 0.13, 6, 13));    // Min / Max line
  const lotPt = Math.round(clamp(side ? h * 0.24 : h * 0.17, 8, 20));   // Lot Qty line
  const metaPt = capPt;                                                 // gate-entry / date line
  const descLines = kind === "plain" ? (side ? 3 : 2) : (side ? 2 : 1);
  return {
    w, h, pad, symbology, qr, side, codeMm, barMaxMm, textW,
    pnPt, dsPt, locPt, capPt, mmPt, lotPt, metaPt, descLines, showLocation, kind,
  };
}

// A stock level / quantity as printed: a thousands-grouped number, or "—" when
// it is not set.
export function labelLevel(value) {
  if (value == null || value === "") return "—";
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("en-IN") : String(value);
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

// The text column's lines below the description — what sets a "location" or
// "lot" tag apart from the plain label (see labelLayout for the kinds).
function labelExtra(L, { location, minLevel, maxLevel, lotQty, uom, gateRef, gateDate }) {
  if (L.kind === "location") {
    return `<div class="loc" style="font-size:${L.locPt}pt">Location: ${escapeHtml(location || "—")}</div>`
      + `<div class="mm" style="font-size:${L.mmPt}pt">Min: <b>${escapeHtml(labelLevel(minLevel))}</b>`
      + `<span class="mmsep">Max: <b>${escapeHtml(labelLevel(maxLevel))}</b></span></div>`;
  }
  if (L.kind === "lot") {
    const u = uom ? ` ${escapeHtml(String(uom))}` : "";
    let out = `<div class="lot" style="font-size:${L.lotPt}pt">Lot Qty: <b>${escapeHtml(labelLevel(lotQty))}${u}</b></div>`;
    const meta = [gateRef ? `Gate ${escapeHtml(String(gateRef))}` : "", gateDate ? escapeHtml(String(gateDate)) : ""]
      .filter(Boolean).join(" · ");
    if (meta) out += `<div class="meta" style="font-size:${L.metaPt}pt">${meta}</div>`;
    return out;
  }
  return L.showLocation
    ? `<div class="loc" style="font-size:${L.locPt}pt">Location: ${escapeHtml(location || "—")}</div>` : "";
}

// One label's markup: code + Part No + short description, then the kind's extra
// line(s) — location only (plain), location + Min / Max (location tag), or the
// lot quantity (lot tag).
function labelMarkup(fields, config) {
  const { barcodeValue, partNo, description, kind = "plain" } = fields;
  const L = labelLayout(config, partNo, kind);
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
        ${labelExtra(L, fields)}
      </div>
    </div>`;
}

// Many different parts' labels in ONE print job (the stock list's bulk action
// and the gate-entry lot tags): `labels` = [{ barcode_value, part_no,
// part_name, location, copies, ... }], each exactly width_mm x height_mm, one
// per page. `kind` (and any per-label `kind`) picks the tag layout; a label
// may also carry min_stock_level / max_stock_level (location tag) or lot_qty /
// uom / gate_ref / gate_date (lot tag).
export function buildLabelsHtml(labels, config, kind = "plain") {
  const body = labels.map((l) => Array.from({ length: Math.max(1, l.copies || 1) },
    () => labelMarkup({
      barcodeValue: l.barcode_value || l.part_no, partNo: l.part_no,
      description: l.part_name, location: l.location,
      minLevel: l.min_stock_level, maxLevel: l.max_stock_level,
      lotQty: l.lot_qty, uom: l.uom, gateRef: l.gate_ref, gateDate: l.gate_date,
      kind: l.kind || kind,
    }, config))
    .join("")).join("");
  return labelDocument(body, config, kind);
}

// Build a self-contained print document: `copies` labels, each exactly
// width_mm x height_mm. The default plain label shows code + Part No +
// description + location; `kind` "location" adds Min / Max and "lot" shows the
// lot quantity instead (see labelLayout).
export function buildLabelHtml({
  barcodeValue, partNo, description, location,
  minLevel, maxLevel, lotQty, uom, gateRef, gateDate, kind = "plain",
  config, copies = 1,
}) {
  const one = labelMarkup({
    barcodeValue, partNo, description, location,
    minLevel, maxLevel, lotQty, uom, gateRef, gateDate, kind,
  }, config);
  const body = Array.from({ length: Math.max(1, copies) }, () => one).join("");
  return labelDocument(body, config, kind);
}

function labelDocument(body, config, kind = "plain") {
  const { w, h } = labelFaceSize(config, kind);
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
    .mm { line-height: 1.1; margin-top: 1mm; overflow-wrap: anywhere; }
    .mm .mmsep { margin-left: 4mm; }
    .lot { font-weight: 700; line-height: 1.1; margin-top: 1.2mm; overflow-wrap: anywhere; }
    .meta { line-height: 1.1; margin-top: 0.8mm; color: #333; overflow-wrap: anywhere; }
  </style></head><body>${body}</body></html>`;
}

// ---- bin location sheet ----------------------------------------------------
//
// The permanent rack tag: ONE sheet per bin, laminated and fixed to the bin
// face (default 130 x 90 mm). A bin holds several parts at positions (1), (2),
// (3)… — the rack location carries the position, e.g. "R13-S3-B16(2)". Parts
// with the same base location share a sheet, one row each: QR (Part No) +
// description + Part No + the location + Min / Max. The rows, the QR and the
// text shrink to fit however many parts the bin holds (4, 5, 6…) without
// clipping. Unlike the stock labels this is NOT recorded as a label print — it
// is a fixture on the rack, not a label on a piece of material.

// The bin a location belongs to: the rack place without its position suffix,
// e.g. "R13-S3-B16(2)" -> "R13-S3-B16". A location with no "(n)" is its own bin.
export function binBaseLocation(location) {
  return String(location || "").trim().replace(/\s*\(\d+\)\s*$/, "").trim();
}

// The position within the bin, e.g. "R13-S3-B16(2)" -> 2 (null when none).
export function binPosition(location) {
  const m = String(location || "").match(/\((\d+)\)\s*$/);
  return m ? Number(m[1]) : null;
}

// Group parts into bins by base location, each bin's rows ordered by position
// then Part No. `parts` = [{ part_no, part_name, location, min_stock_level,
// max_stock_level }]. Returns [{ base, rows:[...] }] ordered by base; parts with
// no location fall under one "(no location)" bin.
export function groupIntoBins(parts) {
  const bins = new Map();
  (parts || []).forEach((p) => {
    const base = binBaseLocation(p.location) || "(no location)";
    if (!bins.has(base)) bins.set(base, []);
    bins.get(base).push({ ...p, position: binPosition(p.location) });
  });
  const byPos = (a, b) => {
    const pa = a.position == null ? Number.MAX_SAFE_INTEGER : a.position;
    const pb = b.position == null ? Number.MAX_SAFE_INTEGER : b.position;
    if (pa !== pb) return pa - pb;
    return String(a.part_no).localeCompare(String(b.part_no));
  };
  return Array.from(bins.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([base, rows]) => ({ base, rows: rows.sort(byPos) }));
}

// Geometry for a bin sheet with `n` rows on a face w x h mm (default 130 x 90):
// a header bar plus n equal rows. The QR, Part No and the two small lines scale
// with the row height so 4, 5 or 6+ parts all fit inside the same face.
export function binSheetLayout(config, n) {
  const w = Number(config?.bin_width_mm) || 130;
  const h = Number(config?.bin_height_mm) || 90;
  const rows = Math.max(1, n);
  const pad = 1.3;
  const headMm = clamp(h * 0.09, 5, 8);
  const rowMm = (h - headMm) / rows;
  const qrMm = clamp(rowMm - pad * 2, 7, Math.min(rowMm, w * 0.16));
  const descPt = Math.round(clamp(rowMm * 0.85, 6, 13));
  const linePt = Math.round(clamp(rowMm * 0.7, 5, 11));
  const headPt = Math.round(clamp(headMm * 1.3, 7, 12));
  const descLines = rows <= 4 ? 2 : 1;    // long names get a second line while there is room
  return { w, h, pad, headMm, rowMm, qrMm, descPt, linePt, headPt, descLines };
}

function binRowMarkup(row, L, config) {
  const desc = labelDescription(row.part_name, config);
  return `<div class="brow" style="height:${L.rowMm}mm;padding:${L.pad}mm;gap:${L.pad * 1.6}mm">
      <div class="bqr" style="width:${L.qrMm}mm;height:${L.qrMm}mm">${qrSvgString(row.part_no)}</div>
      <div class="btxt">
        <div class="bdesc" style="font-size:${L.descPt}pt;-webkit-line-clamp:${L.descLines}">${escapeHtml(desc)}</div>
        <div class="bcode" style="font-size:${L.linePt}pt">${escapeHtml(row.part_no)} &nbsp;·&nbsp; <b>${escapeHtml(String(row.location || "—"))}</b></div>
        <div class="bmm" style="font-size:${L.linePt}pt">Min Qty: <b>${escapeHtml(labelLevel(row.min_stock_level))}</b><span class="bmmsep">Max Qty: <b>${escapeHtml(labelLevel(row.max_stock_level))}</b></span></div>
      </div>
    </div>`;
}

// One print document, one page per bin (each exactly the bin-face size), for
// `bins` = [{ base, rows }] as groupIntoBins returns.
export function buildBinSheetsHtml(bins, config) {
  const w = Number(config?.bin_width_mm) || 130;
  const h = Number(config?.bin_height_mm) || 90;
  const body = (bins || []).map((bin) => {
    const L = binSheetLayout(config, bin.rows.length);
    const head = `<div class="bhead" style="height:${L.headMm}mm;font-size:${L.headPt}pt">${escapeHtml(bin.base)}</div>`;
    const rows = bin.rows.map((r) => binRowMarkup(r, L, config)).join("");
    return `<div class="bsheet">${head}${rows}</div>`;
  }).join("");
  return binSheetDocument(body, w, h);
}

function binSheetDocument(body, w, h) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${w}mm ${h}mm; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; }
    .bsheet { width: ${w}mm; height: ${h}mm; page-break-after: always; break-after: page; overflow: hidden;
      display: flex; flex-direction: column; font-family: Arial, Helvetica, sans-serif; color: #000; background: #fff;
      border: 0.4mm solid #000; }
    .bsheet:last-child { page-break-after: auto; break-after: auto; }
    .bhead { flex: none; display: flex; align-items: center; justify-content: center; background: #000; color: #fff;
      font-weight: 700; letter-spacing: 0.5px; }
    .brow { flex: none; display: flex; align-items: center; border-top: 0.3mm solid #000; overflow: hidden; }
    .brow:first-of-type { border-top: none; }
    .bqr { flex: none; }
    .bqr svg { display: block; width: 100%; height: 100%; }
    .btxt { min-width: 0; flex: 1; display: flex; flex-direction: column; justify-content: center; }
    .bdesc { font-weight: 700; line-height: 1.12; overflow: hidden; display: -webkit-box;
      -webkit-box-orient: vertical; overflow-wrap: anywhere; }
    .bcode { line-height: 1.12; margin-top: 0.4mm; overflow-wrap: anywhere; }
    .bmm { line-height: 1.12; margin-top: 0.4mm; overflow-wrap: anywhere; }
    .bmm .bmmsep { margin-left: 4mm; }
  </style></head><body>${body}</body></html>`;
}

// ---- lot tag (QC receiving form) -------------------------------------------
//
// The store's incoming-material lot tag (format TBDI/STORE/F/004), ONE per part
// per gate entry, on its own paper (default 150 x 100 mm). The title runs across
// the top on one line; below it the fields the app fills from the gate entry and
// the part — Part Name, Part No, Gate Entry No, Lot Qty, GE Date,
// Supplier/Customer, Location — sit beside the QR (which carries the
// Gate Entry No + Part No), and the format footer is at the bottom. A 1 mm
// border is inset 2 mm from the paper edge so it always prints. No blank QC /
// SRV / TIL / Shift / Lot Status / Reason fields.

// A gate date as the form prints it: an ISO "2025-07-22" becomes "22/07/2025";
// anything else is shown as given.
function lotDate(value) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(value || "");
}

function lotPair(leftLabel, leftVal, rightLabel, rightVal) {
  const cell = (lbl, val) => lbl
    ? `<div class="lt-cell"><b>${escapeHtml(lbl)} :</b> ${escapeHtml(val == null ? "" : String(val))}</div>`
    : `<div class="lt-cell"></div>`;
  return `<div class="lt-row">${cell(leftLabel, leftVal)}${cell(rightLabel, rightVal)}</div>`;
}

function lotTagMarkup(t, qrMm) {
  const uom = t.uom ? ` ${escapeHtml(String(t.uom))}` : "";
  const lotQty = t.lot_qty == null || t.lot_qty === "" ? "" : `${escapeHtml(labelLevel(t.lot_qty))}${uom}`;
  const qrPayload = [t.gate_no, t.part_no].filter(Boolean).join(" ");
  return `<div class="ltag"><div class="lt-inner">
      <div class="lt-title">TOYOTA BOSHOKU DEVICE INDIA PRIVATE LIMITED MFG</div>
      <div class="lt-body">
        <div class="lt-fields">
          <div class="lt-full"><b>Part Name :</b> ${escapeHtml(t.part_name || "")}</div>
          ${lotPair("Part No", t.part_no, "Gate Entry No", t.gate_no)}
          ${lotPair("Lot Qty", lotQty, "GE Date", lotDate(t.gate_date))}
          <div class="lt-full"><b>Supplier/Customer :</b> ${escapeHtml(t.supplier || "")}</div>
          ${lotPair("Location", t.location, "", "")}
        </div>
        <div class="lt-qr" style="width:${qrMm}mm;height:${qrMm}mm">${qrSvgString(qrPayload || t.part_no || "")}</div>
      </div>
      <div class="lt-foot">
        <span><b>Format No :</b> TBDI/STORE/F/004</span>
        <span><b>REV No :</b> 00</span>
        <span><b>REV DATE :</b> 20/05/2024</span>
      </div>
    </div></div>`;
}

// One print document, one lot-tag form per `tags` entry. Each tag =
// { part_no, part_name, lot_qty, uom, supplier, bill_no, gate_no, gate_date }.
export function buildLotTagsHtml(tags, config) {
  const { w, h } = labelFaceSize(config, "lot");
  const qrMm = clamp(h * 0.3, 24, 36);
  const body = (tags || []).map((t) => lotTagMarkup(t, qrMm)).join("");
  // Empty title so the browser's print header (when the operator leaves headers
  // / footers on) does not show the app name; the date / URL it may still add
  // are a print-dialog setting, not part of the tag.
  return `<!doctype html><html><head><meta charset="utf-8"><title></title><style>
    @page { size: ${w}mm ${h}mm; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; }
    .ltag { width: ${w}mm; height: ${h}mm; page-break-after: always; break-after: page; overflow: hidden;
      display: flex; font-family: Arial, Helvetica, sans-serif; color: #000; background: #fff; padding: 2mm; }
    .ltag:last-child { page-break-after: auto; break-after: auto; }
    .lt-inner { flex: 1; display: flex; flex-direction: column; border: 1mm solid #000; padding: 3mm 4mm; overflow: hidden; }
    .lt-title { text-align: center; font-weight: 700; font-size: 13pt; line-height: 1.2; white-space: nowrap; }
    .lt-body { flex: 1; display: flex; align-items: flex-start; gap: 5mm; padding: 2mm 0; }
    .lt-fields { flex: 1; min-width: 0; align-self: stretch; display: flex; flex-direction: column;
      justify-content: space-evenly; font-size: 13pt; line-height: 1.3; }
    .lt-full { overflow-wrap: anywhere; }
    .lt-row { display: flex; gap: 6mm; }
    .lt-cell { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .lt-qr { flex: none; border: 0.3mm solid #000; }
    .lt-qr svg { display: block; width: 100%; height: 100%; }
    .lt-foot { display: flex; justify-content: space-between; align-items: baseline; gap: 4mm;
      border-top: 0.4mm solid #000; padding-top: 2mm; font-size: 10pt; }
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
