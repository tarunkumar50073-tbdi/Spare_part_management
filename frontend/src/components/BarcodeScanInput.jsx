import React, { useEffect, useRef, useState } from "react";
import { ScanLine, Camera, Keyboard, Play } from "lucide-react";
import { BrowserMultiFormatReader } from "@zxing/browser";

/** Compact barcode input with two ways in:
 *  • Scanner gun (USB/Bluetooth HID) — types the code into the focused field
 *    and presses Enter; hand-typed input is rejected by keystroke cadence.
 *  • Tablet camera (@zxing) — for handsets/tablets with no gun; needs a secure
 *    context (HTTPS/localhost), else the camera toggle is hidden.
 *  Both call onScan(code). */
const FAST_KEY_MS = 140; // avg inter-key gap at/above this = hand-typed (rejected)
const DUP_MS = 700;      // gun: swallow a trailing CR/LF or a quick re-read
const CAM_DUP_MS = 1500; // camera: ignore the same barcode briefly after a hit

export default function BarcodeScanInput({ onScan, placeholder = "Scan a barcode with the gun…", autoFocus = true, disabled = false }) {
  const [method, setMethod] = useState("gun"); // "gun" | "camera"
  const [value, setValue] = useState("");
  const [warn, setWarn] = useState("");
  const [camError, setCamError] = useState("");
  const [paused, setPaused] = useState(false);

  const inputRef = useRef(null);
  const keyTimesRef = useRef([]);
  const lastRef = useRef({ code: "", t: 0 });
  const videoRef = useRef(null);
  const controlsRef = useRef(null);
  const readerRef = useRef(null);
  const disabledRef = useRef(disabled);
  const startSeqRef = useRef(0);
  useEffect(() => { disabledRef.current = disabled; }, [disabled]);

  const cameraCapable =
    typeof window !== "undefined" &&
    (window.isSecureContext || window.location.hostname === "localhost") &&
    !!navigator.mediaDevices?.getUserMedia;

  useEffect(() => {
    if (method === "gun" && autoFocus && !disabled) inputRef.current?.focus();
  }, [method, autoFocus, disabled]);

  // Keep focus on the gun field when clicking non-controls (gun mode only).
  useEffect(() => {
    const onDocClick = (e) => {
      if (method !== "gun" || disabled || !autoFocus) return;
      if (e.target?.closest?.("input,textarea,select,button,a,label,[contenteditable]")) return;
      inputRef.current?.focus();
    };
    document.addEventListener("mouseup", onDocClick);
    return () => document.removeEventListener("mouseup", onDocClick);
  }, [method, autoFocus, disabled]);

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

    const now = Date.now();
    if (code === lastRef.current.code && now - lastRef.current.t < DUP_MS) return;

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

  // ---------- camera (@zxing) ----------
  const stopCamera = () => {
    startSeqRef.current++;
    try { controlsRef.current?.stop(); } catch { /* already stopped */ }
    controlsRef.current = null;
  };

  const startCamera = async () => {
    setCamError("");
    const seq = ++startSeqRef.current;
    try {
      if (!readerRef.current) readerRef.current = new BrowserMultiFormatReader();
      const controls = await readerRef.current.decodeFromConstraints(
        { video: { facingMode: { ideal: "environment" } } }, videoRef.current,
        (result) => {
          if (!result || disabledRef.current) return;
          const text = result.getText();
          const now = Date.now();
          if (text === lastRef.current.code && now - lastRef.current.t < CAM_DUP_MS) return;
          lastRef.current = { code: text, t: now };
          stopCamera();
          setPaused(true);
          onScan(text);
        });
      if (startSeqRef.current !== seq) { try { controls.stop(); } catch { /* */ } return; }
      controlsRef.current = controls;
    } catch (e) {
      const name = e?.name || "";
      const msg =
        name === "NotAllowedError" ? "Camera permission denied."
        : name === "NotFoundError" ? "No camera found."
        : name === "NotReadableError" ? "Camera is in use by another app."
        : "Camera could not start.";
      setCamError(`${msg} Use the scanner gun instead.`);
      setMethod("gun");
    }
  };

  useEffect(() => {
    if (method === "camera" && cameraCapable) { setPaused(false); startCamera(); }
    else stopCamera();
    return stopCamera;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method]);
  useEffect(() => () => stopCamera(), []);

  return (
    <div className="space-y-1.5" onClick={() => method === "gun" && !disabled && inputRef.current?.focus()}>
      {method === "gun" ? (
        <>
          <div className="relative">
            <ScanLine className="absolute left-3 top-2.5 text-slate-400" size={16} />
            <input
              ref={inputRef}
              className="input-field pl-9 pr-10 tracking-wide"
              placeholder={placeholder}
              value={value}
              disabled={disabled}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              autoComplete="off"
              inputMode="none"
            />
            {cameraCapable && (
              <button type="button" onClick={() => setMethod("camera")} disabled={disabled}
                title="Use tablet camera"
                className="absolute right-2 top-1.5 rounded p-1 text-slate-400 hover:text-toyotared hover:bg-slate-100 dark:hover:bg-navy-800">
                <Camera size={18} />
              </button>
            )}
          </div>
          {warn ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">{warn}</p>
          ) : camError ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">{camError}</p>
          ) : (
            <p className="flex items-center gap-1.5 text-xs text-slate-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" /> Ready — scan with the gun
            </p>
          )}
        </>
      ) : (
        <div>
          <div className="relative overflow-hidden rounded-lg bg-black">
            <video ref={videoRef} className="w-full" style={{ maxHeight: "40vh" }} muted playsInline />
            <div className="pointer-events-none absolute inset-4 rounded-lg border-2 border-white/70" />
            {paused && (
              <button type="button" onClick={() => { setPaused(false); startCamera(); }}
                className="absolute inset-0 flex items-center justify-center bg-black/60 text-base font-semibold text-white">
                <Play size={16} className="mr-2" aria-hidden="true" />Scan next
              </button>
            )}
          </div>
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-xs text-slate-400">Point the rear camera at the barcode.</span>
            <button type="button" onClick={() => setMethod("gun")}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-toyotared">
              <Keyboard size={14} /> Use gun
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
