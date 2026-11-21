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

// The Part No. a packet label names: TB + YYYYMMDD + Part No. (+ "-RW" on a
// rework label; a scanner may add " SPEC" or "|..." after it).
export function partOfLabel(code) {
  const head = String(code || "").trim().toUpperCase().split(/[ |\\/]/)[0];
  const m = head.match(/^TB\d{8}(.+?)(?:-RW)?(?:-\d{1,3})?$/);
  return m ? m[1] : null;
}
