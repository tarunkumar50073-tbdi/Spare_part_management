import { useEffect, useRef } from "react";

// A scanner that sends no Enter after the code (13 Nov 2026: the Honeywell
// 1950GSR wired scanner typed "TB20261113CNMM4368-01 MGPM20-150Z" and stopped,
// so Scan Part waited for an Enter that never came). "QR code to kisi bhi
// scanner se scan hona chahiye": a scanner's burst — many characters, fast and
// even — that then goes quiet is taken as ended, as if Enter had been pressed.
// Hand typing is far slower than GUN_KEY_MS a character, so it never ends
// itself. A scanner that does send Enter ends the burst at once (the timer is
// dropped), so nothing is taken twice.
export const GUN_KEY_MS = 60;      // average gap per character at most
export const GUN_MIN_CHARS = 6;    // shorter bursts are left alone
export const GUN_IDLE_MS = 300;    // quiet this long after the last character = the end
const NEW_BURST_MS = 400;          // a longer gap starts a new burst

/** Returns an onKeyDown handler to call from the field's own onKeyDown.
 *  onEnd() runs once a scanner burst ends without an Enter; it is read at
 *  that moment, so it sees the field's latest value. */
export default function useGunEnd(onEnd) {
  const times = useRef([]);
  const timer = useRef(null);
  const cb = useRef(onEnd);
  cb.current = onEnd;
  useEffect(() => () => clearTimeout(timer.current), []);

  return (e) => {
    if (e.key === "Enter" || e.key === "Tab" || e.key === "Escape") {
      clearTimeout(timer.current);
      times.current = [];
      return;
    }
    if (!e.key || e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
    const now = Date.now();
    const t = times.current;
    if (t.length && now - t[t.length - 1] > NEW_BURST_MS) t.length = 0;
    t.push(now);
    clearTimeout(timer.current);
    if (t.length >= GUN_MIN_CHARS && (t[t.length - 1] - t[0]) / (t.length - 1) < GUN_KEY_MS) {
      timer.current = setTimeout(() => {
        times.current = [];
        cb.current?.();
      }, GUN_IDLE_MS);
    }
  };
}
