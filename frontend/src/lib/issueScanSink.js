// While a packet Issue form is open on Scan Part, a label of the SAME part
// scanned into the page's main scan box is added to that issue instead of
// opening the part again and throwing the filled form away (21 Nov 2026: "dono
// kar de"). The open form registers a sink; Scan Part offers each gun read to
// it first. Only one Issue form is open at a time.
let sink = null;

export function setIssueScanSink(fn) {
  sink = fn;
  return () => { if (sink === fn) sink = null; };
}

// true when the open Issue form took the code.
export function sendToIssue(code, scanSource) {
  return sink ? Boolean(sink(code, scanSource)) : false;
}

// Every Part No. a packet label can name: TB + YYYYMMDD + Part No. (+ "-RW" on a
// rework label; a scanner may add " SPEC" or "|..." after it). An old label ends
// in "-NN" (its label number), but a Part No. can itself end in "-25" (25 Nov
// 2026 audit), so both readings are given, the shorter first.
export function partsOfLabel(code) {
  const head = String(code || "").trim().toUpperCase().split(/[ |\\/]/)[0];
  const m = head.match(/^TB\d{8}(.+?)(?:-RW)?$/);
  if (!m) return [];
  const whole = m[1];
  const cut = whole.replace(/-\d{1,3}$/, "");
  return cut !== whole ? [cut, whole] : [whole];
}

export function partOfLabel(code) {
  return partsOfLabel(code)[0] || null;
}
