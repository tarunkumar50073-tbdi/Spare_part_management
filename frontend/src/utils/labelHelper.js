// The DX label helper on this PC (tools/label-helper): prints label pictures
// straight to the label printer at their exact size - no print window, no
// header / footer, no page size set in the printer driver (5 Nov 2026). It
// listens on this PC only; when it is not running the app falls back to the
// browser's print window.
const BASE = "http://127.0.0.1:9123";
const PRINTER_KEY = "dx_label_printer";

// { printers, default } when the helper answers, else null.
export async function helperStatus() {
  try {
    const r = await fetch(`${BASE}/status`, { cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.ok ? { printers: j.printers || [], default: j.default || null } : null;
  } catch {
    return null;
  }
}

export async function helperPrint({ printer, w, h, images, title }) {
  let r;
  try {
    r = await fetch(`${BASE}/print`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ printer, w, h, images, title }),
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    throw new Error("The label helper on this PC did not answer - is its window still open?");
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || `The label helper could not print (${r.status})`);
  return j.printed;
}

// The label printer this PC uses: the one picked before, else one that looks
// like a label printer, else Windows' default.
export function pickPrinter(status) {
  const list = status?.printers || [];
  let saved = null;
  try { saved = localStorage.getItem(PRINTER_KEY); } catch { /* none */ }
  if (saved && list.includes(saved)) return saved;
  return list.find((n) => /godex|zebra|tsc|argox|honeywell|label|xprinter|citizen/i.test(n)) || status?.default || list[0] || "";
}

export function savePrinter(name) {
  try { localStorage.setItem(PRINTER_KEY, name); } catch { /* this visit only */ }
}
