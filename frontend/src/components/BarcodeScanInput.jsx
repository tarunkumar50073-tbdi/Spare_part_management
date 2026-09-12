import React, { useEffect, useRef, useState } from "react";
import { ScanLine } from "lucide-react";

/** Gun-only barcode input — retail-POS style (like Vishal Mega Mart / Reliance
 * Smart). A USB / Bluetooth HID scanner gun types the code into the focused
 * field and presses Enter, so it registers automatically. No camera and no
 * manual typing: a gun fires its keystrokes far faster than a human can type,
 * so slow (hand-typed) input is rejected. Calls onScan(code). */
// Avg inter-key gap at/above this = hand-typed (rejected). Well above any gun
// (even a delay-configured one) and well below a human's cadence, so a real scan
// is never rejected.
const FAST_KEY_MS = 140;
const DUP_MS = 700;    // swallow a trailing CR/LF or a quick re-read, but let a deliberate rescan through

export default function BarcodeScanInput({ onScan, placeholder = "Scan a barcode with the gun…", autoFocus = true, disabled = false }) {
  const [value, setValue] = useState("");
  const [warn, setWarn] = useState("");
  const inputRef = useRef(null);
  const keyTimesRef = useRef([]);
  const lastRef = useRef({ code: "", t: 0 });

  useEffect(() => {
    if (autoFocus && !disabled) inputRef.current?.focus();
  }, [autoFocus, disabled]);

  // If the operator clicks anywhere that is NOT a form control, pull focus back
  // so the next gun scan lands here (clicking a real input/button keeps focus).
  useEffect(() => {
    const onDocClick = (e) => {
      if (disabled || !autoFocus) return;
      if (e.target?.closest?.("input,textarea,select,button,a,label,[contenteditable]")) return;
      inputRef.current?.focus();
    };
    document.addEventListener("mouseup", onDocClick);
    return () => document.removeEventListener("mouseup", onDocClick);
  }, [autoFocus, disabled]);

  const onKeyDown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); return; }
    if (e.key.length === 1) keyTimesRef.current.push(Date.now());
  };

  const submit = () => {
    const code = value.trim();
    const times = keyTimesRef.current;
    keyTimesRef.current = [];
    setValue("");
    if (!code || disabled) return;

    // The gun can send a trailing CR/LF (two Enters) or re-read the same code —
    // count the same code within the window as ONE scan so it never fires twice.
    // Checked FIRST, so a trailing Enter is never mistaken for a manual entry.
    const now = Date.now();
    if (code === lastRef.current.code && now - lastRef.current.t < DUP_MS) return;

    // A scanner gun streams the whole code in a fast, even burst; a human can't.
    // A short code (< 3 keys) can't be judged by cadence, so it is accepted.
    let isGun = true;
    if (times.length >= 3) {
      const gaps = times.slice(1).map((t, i) => t - times[i]);
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      isGun = avg < FAST_KEY_MS;
    }
    if (!isGun) {
      setWarn("Please scan with the barcode gun — manual entry is disabled.");
      setTimeout(() => setWarn(""), 2500);
      return;
    }
    lastRef.current = { code, t: now };
    setWarn("");
    onScan(code);
  };

  return (
    <div className="space-y-1.5" onClick={() => !disabled && inputRef.current?.focus()}>
      <div className="relative">
        <ScanLine className="absolute left-3 top-2.5 text-slate-400" size={16} />
        <input
          ref={inputRef}
          className="input-field pl-9 tracking-wide"
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          inputMode="none"
        />
      </div>
      {warn ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">{warn}</p>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-slate-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" /> Ready — scan with the gun
        </p>
      )}
    </div>
  );
}
