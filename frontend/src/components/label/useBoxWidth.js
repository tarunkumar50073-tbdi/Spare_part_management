import { useEffect, useState } from "react";

// Content width of a box, kept current as it resizes — so a label preview can
// scale down to fit a phone-width dialog instead of being squashed (or
// overflowing) at its desktop size. Returns [ref callback, width | null].
// A callback ref, because the measured box may mount after the component does
// (e.g. only on the first step of a dialog).
export function useBoxWidth() {
  const [el, setEl] = useState(null);
  const [width, setWidth] = useState(null);
  useEffect(() => {
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width];
}
