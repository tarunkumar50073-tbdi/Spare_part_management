import React, { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";

// One shared scan surface for the Spare store: tablet camera (@zxing, rear,
// Code-128), USB/Bluetooth HID gun (keyboard-wedge into a focused field), and
// manual entry — all emit onCode(code, source). The camera stops on success,
// on method change, and on unmount; the same barcode is ignored for 1.5s; and
// requests are suppressed while the parent is busy. Camera needs a secure
// context (HTTPS/localhost) — otherwise gun + manual still work.
const DUP_MS = 1500;
const FAST_KEY_MS = 35; // avg gap below this = a scanner gun, not a human

export default function ScanPanel({ onCode, busy = false, autoFocus = true, hint }) {
  const [method, setMethod] = useState("input"); // "input" | "camera"
  const [manual, setManual] = useState("");
  const [camError, setCamError] = useState("");
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [multiCam, setMultiCam] = useState(false);
  const [paused, setPaused] = useState(false);   // camera stops after a hit; tap to scan next

  const videoRef = useRef(null);
  const controlsRef = useRef(null);
  const readerRef = useRef(null);
  const inputRef = useRef(null);
  const lastRef = useRef({ code: "", t: 0 });
  const keyTimesRef = useRef([]);
  const busyRef = useRef(busy);
  const deviceIdRef = useRef(undefined);
  const startSeqRef = useRef(0);   // invalidates an in-flight async camera start
  useEffect(() => { busyRef.current = busy; }, [busy]);

  const cameraCapable =
    typeof window !== "undefined" &&
    (window.isSecureContext || window.location.hostname === "localhost") &&
    !!navigator.mediaDevices?.getUserMedia;

  const stopCamera = () => {
    startSeqRef.current++;   // any in-flight start() sees a stale seq and self-stops
    try { controlsRef.current?.stop(); } catch { /* already stopped */ }
    controlsRef.current = null;
    setTorchOn(false);
  };

  const emit = (text, source) => {
    const now = Date.now();
    if (text === lastRef.current.code && now - lastRef.current.t < DUP_MS) return false;
    lastRef.current = { code: text, t: now };
    onCode(text, source);
    return true;
  };

  const startCamera = async (deviceId) => {
    setCamError("");
    const seq = ++startSeqRef.current;
    try {
      if (!readerRef.current) readerRef.current = new BrowserMultiFormatReader();
      const reader = readerRef.current;
      const cb = (result) => {
        if (!result || busyRef.current) return;
        // Stop decoding after a successful read so the same in-frame barcode
        // cannot re-fire every 1.5s and wipe the operator's in-progress form.
        if (emit(result.getText(), "TABLET_CAMERA")) { stopCamera(); setPaused(true); }
      };
      const controls = deviceId
        ? await reader.decodeFromVideoDevice(deviceId, videoRef.current, cb)
        : await reader.decodeFromConstraints(
            { video: { facingMode: { ideal: "environment" } } }, videoRef.current, cb);
      // The user switched mode / unmounted while getUserMedia was resolving —
      // don't keep this now-orphaned stream alive.
      if (startSeqRef.current !== seq) { try { controls.stop(); } catch { /* */ } return; }
      controlsRef.current = controls;
      deviceIdRef.current = deviceId;
      const track = videoRef.current?.srcObject?.getVideoTracks?.()[0];
      setTorchSupported(!!track?.getCapabilities?.().torch);
      try {
        const cams = (await navigator.mediaDevices.enumerateDevices())
          .filter((d) => d.kind === "videoinput");
        setMultiCam(cams.length > 1);
      } catch { /* ignore */ }
    } catch (e) {
      const name = e?.name || "";
      const msg =
        name === "NotAllowedError" ? "Camera permission denied."
        : name === "NotFoundError" ? "No camera found."
        : name === "NotReadableError" ? "Camera is in use by another app."
        : "Camera could not start.";
      setCamError(`${msg} Use the scanner gun or manual entry.`);
      setMethod("input");
    }
  };

  useEffect(() => {
    if (method === "camera" && cameraCapable) { setPaused(false); startCamera(deviceIdRef.current); }
    else stopCamera();
    return stopCamera;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method]);

  useEffect(() => () => stopCamera(), []);

  useEffect(() => {
    if (method === "input" && autoFocus && !busy) inputRef.current?.focus();
  }, [method, busy, autoFocus]);

  const toggleTorch = async () => {
    const track = videoRef.current?.srcObject?.getVideoTracks?.()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn }] });
      setTorchOn((v) => !v);
    } catch { /* torch unsupported */ }
  };

  const switchCamera = async () => {
    try {
      const cams = (await navigator.mediaDevices.enumerateDevices())
        .filter((d) => d.kind === "videoinput");
      if (cams.length < 2) return;
      const track = videoRef.current?.srcObject?.getVideoTracks?.()[0];
      const curId = track?.getSettings?.().deviceId;
      const idx = Math.max(0, cams.findIndex((d) => d.deviceId === curId));
      stopCamera();
      startCamera(cams[(idx + 1) % cams.length].deviceId);
    } catch { /* ignore */ }
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitInput();
      return;
    }
    if (e.key.length === 1) keyTimesRef.current.push(Date.now());
  };

  const submitInput = () => {
    const code = manual.trim();
    if (!code || busy) return;
    const times = keyTimesRef.current;
    let source = "MANUAL_ENTRY";
    if (times.length >= 3) {
      const gaps = times.slice(1).map((t, i) => t - times[i]);
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      if (avg < FAST_KEY_MS) source = "USB_SCANNER";
    }
    keyTimesRef.current = [];
    setManual("");
    emit(code, source);
  };

  return (
    <div className="rounded-xl2 border border-slate-200 bg-white p-4 dark:border-navy-800 dark:bg-navy-900">
      <div className="mb-3 flex gap-2">
        <button
          type="button" onClick={() => setMethod("input")}
          className={`flex-1 rounded-lg py-3 text-base font-semibold ${
            method === "input" ? "bg-toyotared text-white" : "bg-slate-100 text-slate-700 dark:bg-navy-800 dark:text-slate-200"}`}
        >⌨️ Gun / Manual</button>
        <button
          type="button" onClick={() => setMethod("camera")}
          className={`flex-1 rounded-lg py-3 text-base font-semibold ${
            method === "camera" ? "bg-toyotared text-white" : "bg-slate-100 text-slate-700 dark:bg-navy-800 dark:text-slate-200"}`}
        >📷 Camera</button>
      </div>

      {method === "input" ? (
        <div className="flex gap-2">
          <input
            ref={inputRef} value={manual} onChange={(e) => setManual(e.target.value)}
            onKeyDown={onKeyDown} disabled={busy} autoFocus={autoFocus}
            placeholder={hint || "Scan or enter Part No., then Enter"}
            className="input-field flex-1 text-lg" style={{ minHeight: "3rem" }}
          />
          <button type="button" onClick={submitInput} disabled={busy}
            className="btn-primary px-6 text-lg">Go</button>
        </div>
      ) : cameraCapable ? (
        <div>
          <div className="relative mx-auto max-w-md overflow-hidden rounded-lg bg-black">
            <video ref={videoRef} className="w-full" style={{ maxHeight: "50vh" }} muted playsInline />
            <div className="pointer-events-none absolute inset-6 rounded-lg border-2 border-white/70" />
            {paused && (
              <button type="button" onClick={() => { setPaused(false); startCamera(deviceIdRef.current); }}
                className="absolute inset-0 flex items-center justify-center bg-black/60 text-lg font-semibold text-white">
                ▶ Scan next part
              </button>
            )}
          </div>
          <div className="mt-3 flex justify-center gap-2">
            {torchSupported && (
              <button type="button" onClick={toggleTorch} className="btn-secondary">
                {torchOn ? "🔦 Torch off" : "🔦 Torch on"}
              </button>
            )}
            {multiCam && (
              <button type="button" onClick={switchCamera} className="btn-secondary">🔄 Switch camera</button>
            )}
          </div>
          <p className="mt-2 text-center text-xs text-slate-500 dark:text-slate-400">
            Point the rear camera at the barcode.
          </p>
        </div>
      ) : (
        <div className="rounded-lg bg-amber-50 p-4 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          Camera scanning requires HTTPS. You can continue using the barcode scanner gun or manual Part No. entry.
        </div>
      )}

      {camError && (
        <p className="mt-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{camError}</p>
      )}
    </div>
  );
}
