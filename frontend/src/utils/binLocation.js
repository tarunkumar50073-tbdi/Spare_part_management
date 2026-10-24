// Rack locations, the bin-scan check and the bin sheet QR's text, kept free of
// the label / QR libraries so a light screen (Put-away Check) can use them
// without loading barcodeRender.

// The bin a location belongs to: the rack place without its position suffix,
// e.g. "R13-S3-B16(2)" -> "R13-S3-B16". A location with no "(n)" is its own bin.
export function binBaseLocation(location) {
  return String(location || "").trim().replace(/\s*\(\d+\)\s*$/, "").trim();
}

const normLoc = (s) => String(s || "").trim().toUpperCase().replace(/\s+/g, "");

// A part's bins for the scan checks: its FRESH location (new material) and,
// when a different one is set, its REWORK location (material back from rework)
// — the same rule the bin sheets (groupIntoBins) print a part in two bins by.
// Stock stays one number; this only says where the material may sit. Returns
// [{ kind: "fresh" | "rework", location, label }] — `label` ("New" / "Rework",
// the store's words) only on a two-bin part, so a single-location part reads
// exactly as before.
export function partBins(location, reworkLocation) {
  const fresh = String(location || "").trim();
  const rework = String(reworkLocation || "").trim();
  const two = Boolean(binBaseLocation(rework)) && normLoc(rework) !== normLoc(fresh);
  return [
    ...(binBaseLocation(fresh) ? [{ kind: "fresh", location: fresh, label: two ? "New" : null }] : []),
    ...(two ? [{ kind: "rework", location: rework, label: "Rework" }] : []),
  ];
}

// ---- the bin sheet QR's text ----------------------------------------------------
// Each bin-sheet row's QR reads "PART_NO LOCATION | DESCRIPTION", e.g.
// "CNTR2238 R6-S6-B36(1) | BENDING INSERT". The store asked (17 Oct 2026) for the
// description in the QR too, so a scan also says WHAT the part is. It goes at
// the END, after " | ", so the part no. and the location are read exactly as
// before, and a sheet already on the racks ("CNTR2238 R6-S6-B36(1)", no " | ")
// keeps scanning. Only the text BEFORE the separator is ever matched
// (stripScanDescription); the description is never used to find anything.

// ~40 characters, so the QR stays scannable on the 130×90 sheet (a longer text
// means a denser QR in the same box; barcodeRender cuts it shorter still on a
// crowded sheet).
export const BIN_QR_DESC_MAX = 40;

// The description as it goes into the QR: plain printable ASCII — a scanner gun
// types the QR as keystrokes, and "Ø", "°" or a curly quote may come out as
// nothing or as junk (accents are dropped, the letter kept: "é" -> "e"); control
// characters gone; "|" taken out, since it is the separator; whitespace
// collapsed; cut to `max` characters at a word boundary where one is near (a
// single long word is cut hard). "" when nothing is left.
export function binQrDescription(text, max = BIN_QR_DESC_MAX) {
  const d = String(text ?? "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (max <= 0) return "";
  if (d.length <= max) return d;
  const head = d.slice(0, max + 1);               // a space right after the cut is a clean break too
  const space = head.lastIndexOf(" ");
  return (space >= max / 2 ? head.slice(0, space) : d.slice(0, max)).replace(/[\s,;:/-]+$/, "");
}

// The bin sheet QR payload for one row: "PART_NO LOCATION" exactly as before, plus
// " | DESCRIPTION" when the part has one. `max` lets a crowded sheet carry a
// shorter description (0 = none).
export function binQrPayload(partNo, location, description, max = BIN_QR_DESC_MAX) {
  const head = [partNo, location].filter(Boolean).join(" ");
  const desc = binQrDescription(description, max);
  return desc ? `${head} | ${desc}` : head;
}

// What a scan is matched on: the text before the description — up to the first
// "|" that has a space before it (the sheet prints " | "). A "|" with NO space
// before it is not the separator: supplier QRs pack their fields as
// "PART|LOT=…|QTY=…" and must reach the resolver whole, as they always have. A
// read without a separator (an older sheet, an old lot tag, a typed part no.) comes
// back as it is, trimmed. The backend does the same (utils/bin_location.py
// strip_scan_description) — change both together.
export function stripScanDescription(code) {
  const s = String(code ?? "").trim();
  const at = s.search(/\s\|/);
  return at < 0 ? s : s.slice(0, at).trim();
}

// Right / Wrong for a scanned bin QR against a part's bins (partBins). The bin
// label packs "part_no location" into ONE QR (plus " | description" since 17 Oct
// 2026, dropped first — stripScanDescription), so the LOCATION token is pulled
// out (the rack-looking one, preferring a slot "(n)"); a plain location QR works
// too. A slot "(n)" is matched to that EXACT partition, a bare bin QR at bin
// level; case- and space-insensitive. Returns { ok, scanned, bin } — `scanned`
// is the bin actually scanned, `bin` the partBins entry it matched (or null).
export function matchBinScan(code, bins) {
  const text = stripScanDescription(code);
  const looksLoc = (t) => /[-/]/.test(t) && /\d/.test(t);   // R6-S6-B36(1), R6/S6/B36…
  const tokens = text.split(/\s+/).filter(Boolean);
  const locTok = (tokens.find((t) => /\(\d+\)\s*$/.test(t) && looksLoc(t))
    || tokens.find(looksLoc) || text).trim();
  const hasSlot = /\(\d+\)\s*$/.test(locTok);
  const scanned = hasSlot ? locTok : (binBaseLocation(locTok) || locTok);
  const key = (s) => normLoc(hasSlot ? s : binBaseLocation(s));
  const bin = (key(scanned) && (bins || []).find((b) => key(b.location) === key(scanned))) || null;
  return { ok: Boolean(bin), scanned, bin };
}
