import { useEffect, useRef, useState } from "react";

// Counts a KPI up to its value on change — ~600ms, eased out, so it reads as
// the number settling rather than an animation being played at you.
//
// The animation is strictly an enhancement: the correct value is guaranteed
// whether or not a single frame ever renders. requestAnimationFrame does not
// fire in a background tab, and this dashboard is meant to sit open on a wall
// monitor for weeks — a KPI frozen at 0 because its animation never ticked
// would be far worse than no animation at all. So a timer backstop lands the
// real value regardless, and prefers-reduced-motion skips straight to it.
export function useCountUp(target, { duration = 600 } = {}) {
  const numeric = typeof target === "number" && Number.isFinite(target) ? target : null;
  const [display, setDisplay] = useState(numeric ?? 0);
  const fromRef = useRef(numeric ?? 0);

  useEffect(() => {
    if (numeric === null) return undefined;

    const settle = () => {
      fromRef.current = numeric;
      setDisplay(numeric);
    };

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const from = fromRef.current;
    if (reduced || from === numeric) {
      settle();
      return undefined;
    }

    let frame;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (numeric - from) * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
      else settle();
    };
    frame = requestAnimationFrame(tick);

    // Fires only if the frames never arrived; harmless otherwise, since it
    // sets the value the animation was heading to anyway.
    const backstop = setTimeout(settle, duration + 150);

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(backstop);
    };
  }, [numeric, duration]);

  // Non-numeric values — an em dash, a formatted currency string — pass
  // through untouched. Only a real number can be counted to.
  if (numeric === null) return target;
  return Math.round(display);
}
