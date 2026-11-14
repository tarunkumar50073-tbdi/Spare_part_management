// A packet QR label read into a search box (13 Nov 2026: scanned into Old stock's
// search, "TB20261113CNMM4368-01 MGPM20-150Z" found nothing). A label's QR is
// its packet code with the spec after it ("CODE SPEC", or "CODE | spec |
// location" on the bigger labels; a scanner may turn the bar into \ or / and
// type it in small letters). The code is TB + YYYYMMDD + Part No. — no label
// number since 14 Nov 2026; an old label's "-NN" is dropped — the same shape
// the server's TB_CODE reads (spare_packet_service).
const TB_CODE = /(TB\d{8})([A-Z0-9]+)(?:-\d{2,3})?/i;

/** The packet code inside a scanned text, upper case, without any old "-NN" — or null. */
export function packetCodeIn(text) {
  const m = TB_CODE.exec(String(text || ""));
  return m ? `${m[1]}${m[2]}`.toUpperCase() : null;
}

/** What a search box should look for: for a scanned packet label, its part
 *  no. (want "part") or its packet code (want "code"); any other text as it is. */
export function scanSearch(text, want = "part") {
  const m = TB_CODE.exec(String(text || ""));
  if (!m) return text;
  return want === "code" ? `${m[1]}${m[2]}`.toUpperCase() : m[2].toUpperCase();
}
