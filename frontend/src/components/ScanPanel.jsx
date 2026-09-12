import React, { useEffect, useRef, useState } from "react";

// Gun-only scan surface — retail-POS style (like Vishal Mega Mart / Reliance
// Smart). A USB / Bluetooth HID scanner gun types the barcode into the focused
// field and presses Enter, so it registers automatically; there is no camera
// and no manual typing. A gun fires its keystrokes far faster than a human can
// type, so slow (typed-by-hand) input is rejected with a hint. Emits
// onCode(code, "USB_SCANNER") on a valid scan.
// Avg inter-key gap at/above this = hand-typed (rejected). Well above any gun —
// even guns configured with a per-character delay stay under ~100ms — and well
// below a human's cadence, so a real scan is never rejected.
const FAST_KEY_MS = 140;
const DUP_MS = 700;      // swallow a trailing CR/LF or a quick re-read, but let a deliberate rescan through

export default function ScanPanel({ onCode, busy = false, autoFocus = true, hint }) {
  const [value, setValue] = useState("");
  const [warn, setWarn] = useState("");
  const inputRef = useRef(null);
  const keyTimesRef = useRef([]);
  const lastRef = useRef({ code: "", t: 0 });

  // Keep the field ready for the gun whenever we are not mid-submit.
  const focus = () => { if (autoFocus && !busy) inputRef.current?.focus(); };
  useEffect(() => { focus(); }, [busy, autoFocus]);

  // Keep the field ready for the gun: if the operator clicks anywhere that is
  // NOT a form control (a card, a heading, empty space), pull focus back so the
  // next scan lands here. Clicking a real input/button/link leaves focus there.
  useEffect(() => {
    const onDocClick = (e) => {
      if (busy || !autoFocus) return;
      if (e.target?.closest?.("input,textarea,select,button,a,label,[contenteditable]")) return;
      inputRef.current?.focus();
    };
    document.addEventListener("mouseup", onDocClick);
    return () => document.removeEventListener("mouseup", onDocClick);
  }, [busy, autoFocus]);

  const onKeyDown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); return; }
    if (e.key.length === 1) keyTimesRef.current.push(Date.now());
  };

  const submit = () => {
    const code = value.trim();
    const times = keyTimesRef.current;
    keyTimesRef.current = [];
    setValue("");
    if (!code || busy) return;

    // ONE physical scan can arrive as the code plus a trailing CR/LF (two
    // Enters) or as a quick re-read — count the same code within the window as a
    // single scan so it never registers twice. Checked FIRST, so a trailing
    // Enter is never mistaken for a slow "manual" entry.
    const now = Date.now();
    if (code === lastRef.current.code && now - lastRef.current.t < DUP_MS) return;

    // Gun vs. hand: a scanner gun streams the whole code in a fast, even burst.
    // Only a long-enough code typed SLOWER than a gun is treated as manual; a
    // short code (< 3 keys) can't be judged by cadence, so it is accepted.
    let isGun = true;
    if (times.length >= 3) {
      const gaps = times.slice(1).map((t, i) => t - times[i]);
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      isGun = avg < FAST_KEY_MS;
    }
    if (!isGun) {
      setWarn("Please scan the barcode with the gun — manual entry is disabled.");
      setTimeout(() => setWarn(""), 2500);
      return;
    }

    lastRef.current = { code, t: now };
    setWarn("");
    onCode(code, "USB_SCANNER");
  };

  return (
    <div
      className="rounded-xl2 border border-slate-200 bg-white p-6 dark:border-navy-800 dark:bg-navy-900"
      onClick={focus}
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="text-5xl" aria-hidden="true">📠</div>
        <div className="text-lg font-semibold text-slate-800 dark:text-white">
          Scan a barcode with the gun
        </div>
        <div className="text-sm text-slate-500 dark:text-slate-400">
          Point the scanner at the part&apos;s barcode — it registers automatically.
        </div>

        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
          autoFocus={autoFocus}
          placeholder={hint || "Waiting for scan…"}
          // The field only exists to catch the gun's keystrokes; a human is
          // steered away from typing here.
          inputMode="none"
          className="input-field w-full max-w-md text-center text-lg tracking-[0.2em]"
          style={{ minHeight: "3.2rem" }}
        />

        {busy ? (
          <div className="text-sm text-slate-400">Processing…</div>
        ) : (
          <div className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" /> Ready — waiting for the gun
          </div>
        )}

        {warn && (
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            {warn}
          </div>
        )}
      </div>
    </div>
  );
}
