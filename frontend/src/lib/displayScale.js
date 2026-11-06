// Fit the app to whatever screen it is opened on (6 Nov 2026: "laptop, tab,
// desktop etc. screen se badi dikhti h . aisi setting kar kisi par bhi khule
// uske hisaab se fit ho"). The screens were laid out on a wide desktop; on a
// 1366-wide laptop, a Windows display at 125-150 % or a tablet they looked
// zoomed in. So the signed-in app (MainLayout - never the TV Live Board or the
// kiosk, which size themselves) is zoomed to the screen's width: full size from
// 1600 CSS px up, smaller below, never under 70 %. Phones keep their own
// layout. Each PC can pick its own size instead (the top bar's screen-size
// button), remembered on that PC.
const KEY = "dx_display_scale";
export const SCALE_EVENT = "dx-scale";

export const SCALE_OPTIONS = [
  ["auto", "Auto — fit this screen"],
  ["0.75", "75 %"],
  ["0.8", "80 %"],
  ["0.9", "90 %"],
  ["1", "100 %"],
  ["1.1", "110 %"],
];

export function autoScale(width = typeof window === "undefined" ? 1600 : window.innerWidth) {
  if (width < 768) return 1;                      // a phone: its own layout
  const design = width >= 1024 ? 1600 : 1200;     // desktop / laptop, else a tablet
  return Math.round(Math.max(0.7, Math.min(1, width / design)) * 100) / 100;
}

export function scalePref() {
  try { return localStorage.getItem(KEY) || "auto"; } catch { return "auto"; }
}

export function setScalePref(value) {
  try { localStorage.setItem(KEY, value); } catch { /* this visit only */ }
  window.dispatchEvent(new Event(SCALE_EVENT));
}

export function currentScale() {
  const pref = scalePref();
  const n = Number(pref);
  return pref === "auto" || !n ? autoScale() : Math.max(0.5, Math.min(1.5, n));
}

// The zoom now on the page (1 when none): what turns a pointer or a
// getBoundingClientRect() reading (screen pixels) into the page's own pixels.
export function pageZoom() {
  if (typeof document === "undefined") return 1;
  return Number(document.documentElement.style.zoom) || 1;
}

export function applyScale() {
  const el = document.documentElement;
  const z = currentScale();
  if (z === 1) {
    clearScale();
  } else {
    el.style.zoom = String(z);
    el.style.setProperty("--dx-zoom", String(z));
    el.classList.add("dx-zoomed");
  }
  return z;
}

export function clearScale() {
  const el = document.documentElement;
  el.style.zoom = "";
  el.style.removeProperty("--dx-zoom");
  el.classList.remove("dx-zoomed");
}
