// A second sideways scrollbar ABOVE every wide table (21 Nov 2026: "ye slide
// karne k liye uper bhi hona chahiye scan audit me mujhe niche jana pad rha h
// baaki app me bhi dekh lena"). A table wider than its box scrolls sideways
// with the bar at the box's bottom, which on a long list is far down the
// page. This adds a thin bar right above the box, kept in step with it both
// ways, for every table in the app - no page has to opt in.
//
// How: every <table>'s nearest scrolling box (overflow-x auto / scroll) gets a
// bar inserted just before it. The bar shows only while the table is wider
// than its box. New tables (route changes, dialogs, refreshed lists) are
// picked up by a MutationObserver; a bar whose box is gone is removed.

const BAR_ATTR = "data-top-scroll-bar";
const BOX_ATTR = "data-top-scroll-box";
const links = new Map();            // box -> { bar, inner, ro }

function scrollBoxOf(table) {
  let el = table.parentElement;
  for (let i = 0; el && i < 5; i += 1, el = el.parentElement) {
    const ox = getComputedStyle(el).overflowX;
    if (ox === "auto" || ox === "scroll") return el;
  }
  return null;
}

// The box's own bottom scrollbar is on screen: the top one is not needed
// (21 Nov 2026: "1 scrren me aa gya to 2 patti ki jarurat nhi h") - a list
// that fits the screen (its own max-height, like Scan Audit), or one whose
// bottom edge is in view right now.
function bottomInView(box) {
  if (getComputedStyle(box).maxHeight !== "none") return true;
  const r = box.getBoundingClientRect();
  return r.bottom <= window.innerHeight;
}

function update(box) {
  const link = links.get(box);
  if (!link) return;
  const wide = box.scrollWidth > box.clientWidth + 1;
  const show = wide && !bottomInView(box);
  // The hidden attribute, not only display:none: Tailwind's space-y / divide-y
  // skip [hidden] elements, so a hidden bar changes no spacing (25 Nov 2026).
  link.bar.hidden = !show;
  link.bar.style.display = show ? "block" : "none";
  link.bar.style.width = `${box.clientWidth}px`;
  link.inner.style.width = `${box.scrollWidth}px`;
  if (show && Math.abs(link.bar.scrollLeft - box.scrollLeft) > 1) link.bar.scrollLeft = box.scrollLeft;
}

function attach(box) {
  if (links.has(box) || !box.parentElement) return;
  const bar = document.createElement("div");
  bar.setAttribute(BAR_ATTR, "");
  bar.setAttribute("aria-hidden", "true");
  bar.className = "dx-top-scroll";
  const inner = document.createElement("div");
  inner.style.height = "1px";
  bar.appendChild(inner);
  box.parentElement.insertBefore(bar, box);
  box.setAttribute(BOX_ATTR, "");
  // Each follows the other; equal positions stop the echo.
  bar.addEventListener("scroll", () => {
    if (Math.abs(box.scrollLeft - bar.scrollLeft) > 1) box.scrollLeft = bar.scrollLeft;
  }, { passive: true });
  box.addEventListener("scroll", () => {
    if (Math.abs(bar.scrollLeft - box.scrollLeft) > 1) bar.scrollLeft = box.scrollLeft;
  }, { passive: true });
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => update(box)) : null;
  if (ro) {
    ro.observe(box);
    if (box.firstElementChild) ro.observe(box.firstElementChild);
  }
  links.set(box, { bar, inner, ro });
  update(box);
}

function sweep() {
  // Bars whose box left the page (or moved away from it) go too.
  for (const [box, link] of links) {
    if (!box.isConnected || link.bar.nextElementSibling !== box) {
      link.ro?.disconnect();
      link.bar.remove();
      links.delete(box);
    }
  }
  document.querySelectorAll("table").forEach((t) => {
    const box = scrollBoxOf(t);
    if (box) attach(box);
  });
  links.forEach((_, box) => update(box));
}

let timer = null;
const later = () => {
  if (timer) return;
  timer = setTimeout(() => { timer = null; sweep(); }, 200);
};

export function installTopScrollbars() {
  if (typeof window === "undefined" || window.__dxTopScroll) return;
  window.__dxTopScroll = true;
  const style = document.createElement("style");
  style.textContent = `.dx-top-scroll{overflow-x:auto;overflow-y:hidden;height:14px;max-width:100%;margin-bottom:2px}`
    + `.dx-top-scroll>div{pointer-events:none}`
    + `@media print{.dx-top-scroll{display:none!important}}`;
  document.head.appendChild(style);
  new MutationObserver((records) => {
    // Our own bars are not a reason to look again.
    if (records.every((r) => [...r.addedNodes, ...r.removedNodes].every((n) => n.nodeType === 1 && n.hasAttribute?.(BAR_ATTR)))) return;
    later();
  }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", later);
  // Page scrolled: the bottom bar may have come into view, or gone out of it.
  let frame = 0;
  document.addEventListener("scroll", () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; links.forEach((_, box) => update(box)); });
  }, { passive: true, capture: true });
  later();
}
