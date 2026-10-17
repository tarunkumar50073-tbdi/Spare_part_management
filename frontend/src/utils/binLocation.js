// Rack locations and the bin-scan check, kept free of the label / QR libraries
// so a light screen (the kiosk) can use them without loading barcodeRender.

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

// Right / Wrong for a scanned bin QR against a part's bins (partBins). The bin
// label packs "part_no location" into ONE QR, so the LOCATION token is pulled
// out (the rack-looking one, preferring a slot "(n)"); a plain location QR works
// too. A slot "(n)" is matched to that EXACT partition, a bare bin QR at bin
// level; case- and space-insensitive. Returns { ok, scanned, bin } — `scanned`
// is the bin actually scanned, `bin` the partBins entry it matched (or null).
export function matchBinScan(code, bins) {
  const looksLoc = (t) => /[-/]/.test(t) && /\d/.test(t);   // R6-S6-B36(1), R6/S6/B36…
  const tokens = String(code || "").split(/\s+/).filter(Boolean);
  const locTok = (tokens.find((t) => /\(\d+\)\s*$/.test(t) && looksLoc(t))
    || tokens.find(looksLoc) || String(code || "")).trim();
  const hasSlot = /\(\d+\)\s*$/.test(locTok);
  const scanned = hasSlot ? locTok : (binBaseLocation(locTok) || locTok);
  const key = (s) => normLoc(hasSlot ? s : binBaseLocation(s));
  const bin = (key(scanned) && (bins || []).find((b) => key(b.location) === key(scanned))) || null;
  return { ok: Boolean(bin), scanned, bin };
}
