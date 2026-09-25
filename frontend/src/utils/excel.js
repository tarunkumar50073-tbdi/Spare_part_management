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

// A worksheet from a 2-D array. A number becomes a numeric cell (so Excel can
// sum/sort it); anything else an inline string. Empty cells are simply omitted,
// which is valid and keeps the file small.
function sheetXml(matrix) {
  const rowsXml = matrix.map((cells, r) => {
    const cellsXml = cells.map((val, c) => {
      if (val == null || val === "") return "";
      const ref = `${colLetter(c)}${r + 1}`;
      if (typeof val === "number" && Number.isFinite(val)) {
        return `<c r="${ref}"><v>${val}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(val)}</t></is></c>`;
    }).join("");
    return `<row r="${r + 1}">${cellsXml}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${rowsXml}</sheetData></worksheet>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
  `</Relationships>`;

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

// Build the .xlsx bytes for one sheet whose first array is the header row.
function buildXlsx(sheetName, matrix) {
  const safeName = (sheetName || "Sheet1").slice(0, 31).replace(/[\\/?*[\]:]/g, " ") || "Sheet1";
  return zipStore([
    { name: "[Content_Types].xml", bytes: enc.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", bytes: enc.encode(RELS) },
    { name: "xl/workbook.xml", bytes: enc.encode(workbookXml(safeName)) },
    { name: "xl/_rels/workbook.xml.rels", bytes: enc.encode(WORKBOOK_RELS) },
    { name: "xl/worksheets/sheet1.xml", bytes: enc.encode(sheetXml(matrix)) },
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
    const s = v == null ? "" : String(v);
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
