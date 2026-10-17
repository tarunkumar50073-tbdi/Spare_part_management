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
import { TB_LOGO } from "./tbLogo.js";
import { binBaseLocation } from "./binLocation.js";

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

// For a BIN SHEET the description is NEVER pre-truncated — it wraps across the
// row's lines (the layout paginates so there is always room), so the full part
// name prints. Only trimmed. (The one-line `labelDescription` cap above is for
// the small single-line label, not for bin sheets.)
export function binDescription(partName) {
  return String(partName || "").trim();
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
    /* Force backgrounds / colours (e.g. a logo, a solid name bar) to PRINT even
       when the browser's "Background graphics" option is off — otherwise they
       vanish on the printout and in print preview. */
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
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

// The bin a location belongs to ("R13-S3-B16(2)" -> "R13-S3-B16") lives in
// binLocation.js with the bin-scan check; re-exported here for the label code.
export { binBaseLocation };

// The position within the bin, e.g. "R13-S3-B16(2)" -> 2 (null when none).
export function binPosition(location) {
  const m = String(location || "").match(/\((\d+)\)\s*$/);
  return m ? Number(m[1]) : null;
}

// Group parts into bins by (SECTION + base location). The SAME location string
// (e.g. "R3-S2-B11") is a DIFFERENT physical bin in more than one section — the
// store reuses rack numbers across Press / Maintenance / Tool Room — so a bin
// tag is keyed on section AND base, NEVER merged across sections (otherwise one
// tag lists parts from two racks). `parts` = [{ part_no, part_name, location,
// section_id, section_name, min_stock_level, max_stock_level }]. Returns
// [{ section_id, section_name, base, rows:[...] }] ordered by section then base;
// each bin's rows by position then Part No. No-location parts fall under a
// "(no location)" bin per section.
export function groupIntoBins(parts) {
  const bins = new Map();
  // Place one part-entry into the bin of `loc`. `kind` is "fresh" / "rework" /
  // null (single-location part, no badge); `other` is the part's OTHER location
  // so the row can show both. The entry's own `location` is `loc`, so its QR and
  // code line carry THIS bin's location.
  const add = (p, loc, kind, other) => {
    const base = binBaseLocation(loc) || "(no location)";
    const key = `${p.section_id ?? ""}||${base}`;
    if (!bins.has(key)) {
      bins.set(key, { section_id: p.section_id ?? null, section_name: p.section_name || "", base, rows: [] });
    }
    bins.get(key).rows.push({ ...p, location: loc, kind, other_location: other || null, position: binPosition(loc) });
  };
  (parts || []).forEach((p) => {
    const fresh = String(p.location || "").trim();
    const rework = String(p.rework_location || "").trim();
    const dual = Boolean(rework && rework !== fresh);   // a distinct rework location
    // Fresh entry — kept even with no fresh location (falls into "(no location)"),
    // but skipped for a rework-only part so it doesn't land in "(no location)".
    if (fresh || !dual) add(p, p.location, dual ? "fresh" : null, dual ? rework : null);
    // Rework entry — the same part, in its rework bin, marked REWORK.
    if (dual) add(p, rework, "rework", fresh || null);
  });
  const byPos = (a, b) => {
    const pa = a.position == null ? Number.MAX_SAFE_INTEGER : a.position;
    const pb = b.position == null ? Number.MAX_SAFE_INTEGER : b.position;
    if (pa !== pb) return pa - pb;
    return String(a.part_no).localeCompare(String(b.part_no));
  };
  return Array.from(bins.values())
    .sort((a, b) => (a.section_name || "").localeCompare(b.section_name || "") || a.base.localeCompare(b.base))
    .map((bin) => ({ ...bin, rows: bin.rows.sort(byPos) }));
}

// mm a single line of text takes per point of font size (Arial, line-height 1.12),
// and the gap between stacked fields.
const LINE_MM_PER_PT = 0.3951;
const FIELD_GAP_MM = 0.4;
const BIN_DESC_MIN_PT = 5;      // smallest description font we will shrink to
const BIN_DESC_MAX_PT = 12;     // largest, so tags stay consistent

// How many lines a string wraps to in a column `perLine` characters wide, the
// way a browser wraps: whole words stay together, and a word longer than the
// line breaks across lines (overflow-wrap: anywhere). This lets us size the font
// so the WHOLE description fits on its lines — it is never cut.
function wrapLineCount(text, perLine) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  let lines = 1, cur = 0;
  for (const word of words) {
    const len = word.length;
    if (cur === 0) cur = len;
    else if (cur + 1 + len <= perLine) cur += 1 + len;
    else { lines += 1; cur = len; }
    while (cur > perLine) { lines += 1; cur -= perLine; }     // a word wider than one line
  }
  return lines;
}

// Characters that fit on one line of `textW` mm at `pt`. Deliberately assumes a
// WIDE average glyph (bold is wider) and shaves the width a little, so it
// UNDER-counts: better to predict one line too many (smaller font) than one too
// few (a cut word). Bold is used for the description.
function charsPerLine(textW, pt, bold) {
  const em = bold ? 0.68 : 0.60;
  return Math.max(3, Math.floor((textW * 0.97) / (pt * em * 0.3528)));
}

// Layout for ONE column of `rows` at width `colW`, `k` rows tall. The DESCRIPTION
// is sized to its FULL text: the LARGEST font (down to a floor) at which every
// row's whole description fits on its wrapped lines. Min/Max is added next while
// there is room, then the Spec — but the Spec shows only if it ALSO fits whole
// (otherwise it is dropped, never cut). Returns null if even the floor font
// can't fit the description + part-no line, so the caller uses fewer rows/page.
function binColLayout(config, rows, colW, k) {
  const w = Number(config?.bin_width_mm) || 130;
  const h = Number(config?.bin_height_mm) || 90;
  const pad = 1.3;
  // Taller header + inset logo so the company mark never touches the sheet edge.
  const headMm = clamp(h * 0.14, 12, 14);
  const headPt = Math.round(clamp(headMm * 1.15, 7, 12));
  const logoMm = clamp(headMm * 1.5, 13, 17);
  const rowMm = (h - headMm) / Math.max(1, k);
  const avail = Math.max(2, rowMm - pad * 2);
  const qrMm = Math.max(5, Math.min(rowMm - pad * 2, colW * 0.17));
  const textW = Math.max(6, colW - pad * 2 - qrMm - pad * 1.6);
  const H = LINE_MM_PER_PT, GAP = FIELD_GAP_MM;
  for (let descPt = BIN_DESC_MAX_PT; descPt >= BIN_DESC_MIN_PT; descPt--) {
    const linePt = Math.max(5, descPt - 1);
    const dPerLine = charsPerLine(textW, descPt, true);
    const sPerLine = charsPerLine(textW, linePt, false);
    let maxDesc = 1, maxSpec = 0, anySpec = false;
    for (const r of rows) {
      maxDesc = Math.max(maxDesc, wrapLineCount(binDescription(r.part_name), dPerLine));
      if (r.specification) { anySpec = true; maxSpec = Math.max(maxSpec, wrapLineCount("Spec: " + r.specification, sPerLine)); }
    }
    let used = maxDesc * descPt * H + GAP + linePt * H;        // full description + part-no/location
    if (used > avail) continue;                                // too tall at this font — shrink
    let showMinMax = false, specLines = 0;
    if (used + GAP + linePt * H <= avail) { showMinMax = true; used += GAP + linePt * H; }
    if (anySpec && used + GAP + maxSpec * linePt * H <= avail) { specLines = maxSpec; used += GAP + maxSpec * linePt * H; }
    return { w, h, pad, headMm, headPt, logoMm, rowMm, qrMm, descPt, linePt,
             descLines: maxDesc, specLines, showSpec: specLines > 0, showMinMax };
  }
  return null;
}

function binRowMarkup(row, L, config) {
  const desc = binDescription(row.part_name);
  const loc = String(row.location || "");
  const spec = String(row.specification || "").trim();
  // ONE QR per row carrying BOTH the part no and its exact partition location,
  // space-separated (e.g. "CNTR2238 R6-S6-B36(1)"): the part resolves from the
  // part-no token, the location from the slot token — one scan has it all.
  const payload = [row.part_no, loc].filter(Boolean).join(" ");
  const specLine = (spec && L.showSpec)
    ? `<div class="bspec" style="font-size:${L.linePt}pt">Spec: ${escapeHtml(spec)}</div>` : "";
  // For a part that has both a fresh and a rework location, mark which one THIS
  // row is (NEW / REWORK — the store says "new", not "fresh") and show the other
  // location too, so both are visible.
  const kindTag = row.kind === "rework" ? `<span class="bkind brework">REWORK</span>`
    : row.kind === "fresh" ? `<span class="bkind bfresh">NEW</span>` : "";
  const otherTag = row.other_location
    ? ` <span class="bother">(${row.kind === "rework" ? "new" : "rework"}: ${escapeHtml(row.other_location)})</span>` : "";
  const mmLine = L.showMinMax === false ? ""
    : `<div class="bmm" style="font-size:${L.linePt}pt">Min Qty: <b>${escapeHtml(labelLevel(row.min_stock_level))}</b><span class="bmmsep">Max Qty: <b>${escapeHtml(labelLevel(row.max_stock_level))}</b></span></div>`;
  return `<div class="brow" style="height:${L.rowMm}mm;padding:${L.pad}mm;gap:${L.pad * 1.6}mm">
      <div class="bqr" style="width:${L.qrMm}mm;height:${L.qrMm}mm">${qrSvgString(payload)}</div>
      <div class="btxt">
        <div class="bdesc" style="font-size:${L.descPt}pt">${escapeHtml(desc)}</div>
        ${specLine}
        <div class="bcode" style="font-size:${L.linePt}pt">${kindTag}${escapeHtml(row.part_no)} &nbsp;·&nbsp; <b>${escapeHtml(loc || "—")}</b>${otherTag}</div>
        ${mmLine}
      </div>
    </div>`;
}

// Pick HOW to split a bin so the FULL text of every part fits with nothing cut:
// for 1 and (past a few parts) 2 columns, find the MOST rows per column whose
// full descriptions still fit — shrinking the font as needed (binColLayout).
// Then choose whichever needs FEWER pages; on a tie prefer the BIGGER font (two
// columns win only when the narrower column actually reads larger — that puts
// many short-description parts side by side, while long descriptions stay in one
// full-width column), and failing that a single column. Returns { cols, perPage, k }.
const BIN_MAX_PER_COL = 8;
const BIN_READABLE_PT = 7;      // aim for at least this font before saving a page
function layoutPlan(bin, config, w) {
  const rows = bin.rows || [];
  const n = rows.length;
  // Every split that fits the FULL text: for 1 and (past a few parts) 2 columns,
  // each rows-per-column from many (dense, small) to few (roomy, big font).
  const options = [];
  const addCol = (cols) => {
    const colW = w / cols;
    const maxK = Math.min(BIN_MAX_PER_COL, Math.ceil(n / cols));
    for (let k = maxK; k >= 1; k--) {
      const L = binColLayout(config, rows, colW, k);
      if (L) options.push({ cols, k, perPage: k * cols, pages: Math.ceil(n / (k * cols)), descPt: L.descPt });
    }
  };
  addCol(1);
  if (n > 4) addCol(2);
  if (!options.length) return { cols: 1, perPage: Math.max(1, n), k: Math.max(1, n) };
  // Prefer a readable font (>= BIN_READABLE_PT); among those the fewest pages,
  // then the biggest font, then fewer columns. Only if nothing reaches a
  // readable size do we fall back to the biggest font we can get.
  const readable = options.filter((o) => o.descPt >= BIN_READABLE_PT);
  const pool = readable.length ? readable : options;
  pool.sort((a, b) => (readable.length ? (a.pages - b.pages || b.descPt - a.descPt)
    : (b.descPt - a.descPt || a.pages - b.pages)) || a.cols - b.cols);
  const pick = pool[0];
  return { cols: pick.cols, perPage: pick.perPage, k: pick.k };
}

// One print document. Each bin prints on its own 130×90 face; a bin with more
// parts than fit at a readable size splits across pages — "(1/2)", "(2/2)".
// `bins` = [{ base, section_name, rows }] as groupIntoBins returns.
export function buildBinSheetsHtml(bins, config) {
  const w = Number(config?.bin_width_mm) || 130;
  const h = Number(config?.bin_height_mm) || 90;
  const renderPage = (bin, rows, cols, L, pi, nPages) => {
    const rowsPerCol = Math.ceil(rows.length / cols);
    const sec = String(bin.section_name || "").trim();
    const secPt = Math.max(6, Math.round(L.headPt * 0.6));
    const name = bin.base + (nPages > 1 ? ` (${pi + 1}/${nPages})` : "");
    // Header = logo + bin name (+ page) + section. The scannable location QR is
    // PER ROW (each partition's exact location); section is shown because the
    // SAME location string exists in more than one section.
    const head = `<div class="bhead" style="height:${L.headMm}mm">`
      + `<div class="blogo" style="width:${L.logoMm}mm"><img class="blogoimg" src="${TB_LOGO}" alt="" /></div>`
      + `<div class="bloc">`
      +   `<div class="blocname" style="font-size:${L.headPt}pt">${escapeHtml(name)}</div>`
      +   (sec ? `<div class="blocsec" style="font-size:${secPt}pt">${escapeHtml(sec)}</div>` : "")
      + `</div>`
      + `</div>`;
    const colsHtml = [];
    for (let c = 0; c < cols; c++) {
      colsHtml.push(`<div class="bcol">${rows.slice(c * rowsPerCol, (c + 1) * rowsPerCol)
        .map((r) => binRowMarkup(r, L, config)).join("")}</div>`);
    }
    return `<div class="bsheet">${head}<div class="bbody">${colsHtml.join("")}</div></div>`;
  };
  const body = (bins || []).flatMap((bin) => {
    const { cols, perPage, k } = layoutPlan(bin, config, w);
    // One layout for the whole bin (same fonts on every page), sized to the k
    // rows per column the plan chose.
    const L = binColLayout(config, bin.rows, w / cols, k) || binColLayout(config, bin.rows, w / cols, 1);
    const nPages = Math.max(1, Math.ceil(bin.rows.length / perPage));
    const pages = [];
    for (let i = 0; i < bin.rows.length; i += perPage) pages.push(bin.rows.slice(i, i + perPage));
    return pages.map((rows, pi) => renderPage(bin, rows, cols, L, pi, nPages));
  }).join("");
  return binSheetDocument(body, w, h);
}

function binSheetDocument(body, w, h) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${w}mm ${h}mm; margin: 0; }
    /* Force backgrounds / colours (e.g. a logo, a solid name bar) to PRINT even
       when the browser's "Background graphics" option is off — otherwise they
       vanish on the printout and in print preview. */
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html, body { margin: 0; padding: 0; background: #fff; }
    .bsheet { width: ${w}mm; height: ${h}mm; page-break-after: always; break-after: page; overflow: hidden;
      display: flex; flex-direction: column; font-family: Arial, Helvetica, sans-serif; color: #000; background: #fff;
      border: 0.4mm solid #000; }
    .bsheet:last-child { page-break-after: auto; break-after: auto; }
    .bhead { flex: none; display: flex; align-items: stretch; border-bottom: 0.4mm solid #000; }
    /* Body = one or two columns side by side; many parts split across both so
       each row keeps a readable height. A thin rule divides the two columns. */
    .bbody { flex: 1; min-height: 0; display: flex; }
    .bcol { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .bcol + .bcol { border-left: 0.3mm solid #000; }
    /* Logo as an <img> (not a CSS background), so it prints regardless of the
       browser's background-graphics setting. */
    .blogo { flex: none; display: flex; align-items: center; justify-content: center; background: #fff;
      padding: 1mm 0.8mm; border-right: 0.3mm solid #000; }
    .blogoimg { max-width: 100%; max-height: 90%; object-fit: contain; display: block; }
    .bloc { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
      background: #000; color: #fff; font-weight: 700; letter-spacing: 0.5px; line-height: 1.05; text-align: center;
      padding: 0 1mm; overflow: hidden; }
    .blocname { max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .blocsec { max-width: 100%; font-weight: 600; letter-spacing: 0.3px; opacity: 0.88; margin-top: 0.2mm;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .brow { flex: none; display: flex; align-items: stretch; border-top: 0.3mm solid #000; overflow: hidden; }
    .brow:first-of-type { border-top: none; }
    .bqr { flex: none; align-self: center; }
    .bqr svg { display: block; width: 100%; height: 100%; }
    /* The text column is bounded by the row height and hides any overflow; the
       font is sized so the FULL description fits, and the auto-fit script shrinks
       it a touch more if a glyph ran wider than estimated — so text never cuts. */
    .btxt { min-width: 0; flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column;
      justify-content: center; }
    /* Description and Spec WRAP freely across lines — no truncation. */
    .bdesc { font-weight: 700; line-height: 1.12; overflow-wrap: anywhere; }
    .bspec { line-height: 1.12; margin-top: 0.4mm; overflow-wrap: anywhere; }
    .bcode { line-height: 1.12; margin-top: 0.4mm; overflow-wrap: anywhere; }
    /* NEW / REWORK chip on a part that has two locations (black = rework). */
    .bkind { display: inline-block; font-weight: 700; font-size: 0.82em; line-height: 1; padding: 0.2mm 0.6mm;
      border: 0.18mm solid #000; border-radius: 0.5mm; margin-right: 0.8mm; }
    .brework { background: #000; color: #fff; }
    .bfresh { background: #fff; color: #000; }
    .bother { font-weight: 400; color: #333; }
    .bmm { line-height: 1.12; margin-top: 0.4mm; overflow-wrap: anywhere; }
    .bmm .bmmsep { margin-left: 4mm; }
  </style></head><body>${body}
  <script>
  /* Exact guarantee: after layout, if any row's text is still a hair taller than
     its box (a glyph ran wider than the estimate), shrink just that row's fonts
     until the whole text fits. Never enlarges, never cuts. Runs in the print
     iframe and the on-screen preview. */
  (function () {
    function fit(t) {
      if (t.scrollHeight <= t.clientHeight + 0.3) return;
      var kids = t.querySelectorAll('.bdesc,.bspec,.bcode,.bmm'), i;
      for (i = 0; i < kids.length; i++) kids[i].setAttribute('data-b', parseFloat(kids[i].style.fontSize) || 10);
      var s = 1, g = 0;
      while (t.scrollHeight > t.clientHeight + 0.3 && s > 0.45 && g < 40) {
        s -= 0.05; g += 1;
        for (i = 0; i < kids.length; i++) kids[i].style.fontSize = (parseFloat(kids[i].getAttribute('data-b')) * s).toFixed(2) + 'pt';
      }
    }
    var rows = document.querySelectorAll('.btxt'), i;
    for (i = 0; i < rows.length; i++) fit(rows[i]);
  })();
  </script></body></html>`;
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
  const spec = String(t.specification || "").trim();
  const specLine = spec
    ? `<div class="lt-full"><b>Specification :</b> ${escapeHtml(spec)}</div>` : "";
  return `<div class="ltag"><div class="lt-inner">
      <div class="lt-title">TOYOTA BOSHOKU DEVICE INDIA PRIVATE LIMITED MFG</div>
      <div class="lt-body">
        <div class="lt-top">
          <div class="lt-fields">
            <div class="lt-full"><b>Part Name :</b> ${escapeHtml(t.part_name || "")}</div>
            ${lotPair("Part No", t.part_no, "Gate Entry No", t.gate_no)}
            ${lotPair("Lot Qty", lotQty, "GE Date", lotDate(t.gate_date))}
          </div>
          <div class="lt-qr" style="width:${qrMm}mm;height:${qrMm}mm">${qrSvgString(qrPayload || t.part_no || "")}</div>
        </div>
        <!-- Specification, Supplier + Location get their OWN full-width lines
             below the QR (the tag has the room), so a long value uses the whole
             line instead of wrapping early in the narrow column beside the QR. -->
        ${specLine}
        <div class="lt-full"><b>Supplier/Customer :</b> ${escapeHtml(t.supplier || "")}</div>
        ${lotPair("Location", t.location, "", "")}
      </div>
    </div></div>`;
}

// One print document, one lot-tag form per `tags` entry. Each tag =
// { part_no, part_name, lot_qty, uom, supplier, bill_no, gate_no, gate_date }.
export function buildLotTagsHtml(tags, config) {
  const { w, h } = labelFaceSize(config, "lot");
  const qrMm = clamp(h * 0.3, 24, 36);
  // The physical sheet holds THREE 150x100 tags stacked (the paper is folded
  // into three equal bands), so group three tags onto ONE page: one print =
  // one sheet = three tags, each landing in its own band. A last page with 1-2
  // tags just leaves the remaining band(s) blank.
  const PER_SHEET = 3;
  const sheetH = h * PER_SHEET;
  const all = tags || [];
  const sheets = [];
  for (let i = 0; i < all.length; i += PER_SHEET) sheets.push(all.slice(i, i + PER_SHEET));
  const body = sheets.map((group) =>
    `<div class="lsheet">${group.map((t) => lotTagMarkup(t, qrMm)).join("")}</div>`).join("");
  // Empty title so the browser's print header (when the operator leaves headers
  // / footers on) does not show the app name; the date / URL it may still add
  // are a print-dialog setting, not part of the tag.
  return `<!doctype html><html><head><meta charset="utf-8"><title></title><style>
    @page { size: ${w}mm ${sheetH}mm; margin: 0; }
    /* Force backgrounds / colours (e.g. a logo, a solid name bar) to PRINT even
       when the browser's "Background graphics" option is off — otherwise they
       vanish on the printout and in print preview. */
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html, body { margin: 0; padding: 0; background: #fff; }
    /* One sheet = three stacked tags; the page break is per SHEET, not per tag. */
    .lsheet { width: ${w}mm; height: ${sheetH}mm; page-break-after: always; break-after: page;
      display: flex; flex-direction: column; background: #fff; }
    .lsheet:last-child { page-break-after: auto; break-after: auto; }
    /* padding = the clear margin on all four sides between the band edge and the
       tag's border, so nothing sits on a cut / fold line. */
    .ltag { width: ${w}mm; height: ${h}mm; overflow: hidden;
      display: flex; font-family: Arial, Helvetica, sans-serif; color: #000; background: #fff; padding: 4mm; }
    .lt-inner { flex: 1; display: flex; flex-direction: column; border: 1mm solid #000; padding: 3mm 4mm; overflow: hidden; }
    .lt-title { text-align: center; font-weight: 700; font-size: 13pt; line-height: 1.2; white-space: nowrap; }
    .lt-body { flex: 1; display: flex; flex-direction: column; justify-content: space-evenly;
      padding: 2mm 0; font-size: 13pt; line-height: 1.3; }
    /* Top block: the first three field rows beside the QR. Supplier + Location
       live below this, full width, so they never wrap in the QR's narrow column. */
    .lt-top { display: flex; align-items: flex-start; gap: 5mm; }
    .lt-fields { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2mm; }
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
