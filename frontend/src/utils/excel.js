// Minimal, dependency-free .xlsx writer.
//
// Why not SheetJS/exceljs: this app ships to a plant-internal server with no
// route to the internet, so a runtime dependency was off the table, and the
// classic "HTML table saved as .xls" trick makes modern Excel pop a "file
// format and extension don't match" warning on every single open. This emits a
// genuine (stored, uncompressed) XLSX — a ZIP of the handful of XML parts Excel
// needs — entirely in the browser, so exported rows open straight into Excel
// with no warning and numbers arrive as real numbers, not text.

const enc = new TextEncoder();

// CRC-32 (IEEE) — every ZIP entry carries one. Table built once at module load.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// XML 1.0 forbids most control characters even when escaped, so strip them
// rather than emit a file Excel would reject; escape the five markup chars.
function xmlEscape(s) {
  return String(s)
    // eslint-disable-next-line no-control-regex -- deliberately stripping the control chars XML 1.0 forbids
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 0-based column index → spreadsheet letter (0 → A, 25 → Z, 26 → AA).
function colLetter(i) {
  let s = "";
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

function u16(n) {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
}
function u32(n) {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}
function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// A worksheet from a 2-D array: row 0 is a styled header that stays frozen and
// carries filter dropdowns; the rest is the body. Numbers become numeric cells
// (so Excel can sum/sort); anything else an inline string. Every cell carries a
// bordered style so the file opens as a proper table rather than bare values.
function sheetXml(matrix, widths) {
  const nCols = widths.length;
  const nRows = matrix.length;
  const rowsXml = matrix.map((cells, r) => {
    const s = r === 0 ? 1 : 2; // 1 = header style, 2 = body style
    let cellsXml = "";
    for (let c = 0; c < nCols; c++) {
      const val = cells[c];
      const ref = `${colLetter(c)}${r + 1}`;
      if (typeof val === "number" && Number.isFinite(val)) {
        cellsXml += `<c r="${ref}" s="${s}"><v>${val}</v></c>`;
      } else if (val == null || val === "") {
        cellsXml += `<c r="${ref}" s="${s}"/>`;
      } else {
        cellsXml += `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(val)}</t></is></c>`;
      }
    }
    return `<row r="${r + 1}">${cellsXml}</row>`;
  }).join("");
  const colsXml = nCols
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";
  // Freeze the header row so it stays visible while scrolling.
  const views = `<sheetViews><sheetView workbookViewId="0">` +
    `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
    `<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>`;
  const filter = nRows > 0 && nCols > 0
    ? `<autoFilter ref="A1:${colLetter(nCols - 1)}${nRows}"/>` : "";
  // Element order matters to Excel: sheetViews, cols, sheetData, autoFilter.
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    views + colsXml + `<sheetData>${rowsXml}</sheetData>` + filter + `</worksheet>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
  `</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
  `</Relationships>`;

// A tiny stylesheet so every export opens as a proper table: a bold white-on-navy
// header row and thin borders on every cell. The sheet references s="1" (header)
// and s="2" (body) from the cellXfs below.
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<fonts count="2">` +
    `<font><sz val="11"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>` +
  `</fonts>` +
  `<fills count="3">` +
    `<fill><patternFill patternType="none"/></fill>` +
    `<fill><patternFill patternType="gray125"/></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FF1F3A5F"/><bgColor indexed="64"/></patternFill></fill>` +
  `</fills>` +
  `<borders count="2">` +
    `<border><left/><right/><top/><bottom/><diagonal/></border>` +
    `<border><left style="thin"><color rgb="FFD4DBE6"/></left><right style="thin"><color rgb="FFD4DBE6"/></right><top style="thin"><color rgb="FFD4DBE6"/></top><bottom style="thin"><color rgb="FFD4DBE6"/></bottom><diagonal/></border>` +
  `</borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="3">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

function workbookXml(sheetName) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

// ZIP with the "store" method (no compression) — xlsx allows it, and it keeps
// us clear of needing a deflate implementation. A fixed 1980-01-01 timestamp so
// the same rows always produce byte-identical files.
function zipStore(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.bytes);
    const size = f.bytes.length;
    const local = concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0x21),
      u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0),
      nameBytes, f.bytes,
    ]);
    locals.push(local);
    central.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0x21),
      u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameBytes,
    ]));
    offset += local.length;
  }
  const centralBytes = concat(central);
  const eocd = concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralBytes.length), u32(offset), u16(0),
  ]);
  return concat([...locals, centralBytes, eocd]);
}

// Column widths (character units) sized to the longest value in each column,
// clamped so one long cell can't make a column absurdly wide.
function colWidths(matrix) {
  let nCols = 0;
  for (const row of matrix) nCols = Math.max(nCols, row.length);
  const w = new Array(nCols).fill(8);
  for (const row of matrix) {
    for (let c = 0; c < nCols; c++) {
      const v = row[c];
      if (v == null) continue;
      const len = String(v).length + 2;
      if (len > w[c]) w[c] = Math.min(50, len);
    }
  }
  return w;
}

// Build the .xlsx bytes for one sheet whose first array is the header row.
function buildXlsx(sheetName, matrix) {
  const safeName = (sheetName || "Sheet1").slice(0, 31).replace(/[\\/?*[\]:]/g, " ") || "Sheet1";
  const widths = colWidths(matrix);
  return zipStore([
    { name: "[Content_Types].xml", bytes: enc.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", bytes: enc.encode(RELS) },
    { name: "xl/workbook.xml", bytes: enc.encode(workbookXml(safeName)) },
    { name: "xl/_rels/workbook.xml.rels", bytes: enc.encode(WORKBOOK_RELS) },
    { name: "xl/styles.xml", bytes: enc.encode(STYLES_XML) },
    { name: "xl/worksheets/sheet1.xml", bytes: enc.encode(sheetXml(matrix, widths)) },
  ]);
}

/**
 * Build a single-sheet .xlsx as raw bytes — for callers that want to hand the
 * file off themselves (or a test) rather than trigger a browser download.
 * @param {string[]} headers  the header row
 * @param {Array<Array<string|number|null>>} rows  body rows (numbers stay numeric)
 * @param {string} [sheetName]  tab name (default "Sheet1")
 * @returns {Uint8Array}
 */
export function xlsxBytes(headers, rows, sheetName = "Sheet1") {
  return buildXlsx(sheetName, [headers, ...rows]);
}

/**
 * Download `rows` as a single-sheet .xlsx.
 * @param {string} filename  base or full name; ".xlsx" is appended if missing
 * @param {string[]} headers  the header row
 * @param {Array<Array<string|number|null>>} rows  body rows (numbers stay numeric)
 * @param {string} [sheetName]  tab name (default "Sheet1")
 */
export function downloadXlsx(filename, headers, rows, sheetName = "Sheet1") {
  const bytes = xlsxBytes(headers, rows, sheetName);
  const blob = new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.toLowerCase().endsWith(".xlsx") ? filename : `${filename}.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// A plain CSV alongside the .xlsx — some downstream tools (older ERP imports,
// quick diffs) want raw comma-separated text. RFC-4180 quoting, and a UTF-8 BOM
// so Excel opens it in the right encoding. `rows` cells may be strings or numbers.
export function downloadCsv(filename, headers, rows) {
  const esc = (v) => {
    let s = v == null ? "" : String(v);
    // A part name or remark starting with = + - @ would run as a formula when
    // the CSV is opened in Excel; a leading ' keeps it text (a plain number,
    // e.g. -5, stays a number). The server's exports already do this.
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(",")];
  for (const r of rows) lines.push(r.map(esc).join(","));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.toLowerCase().endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
