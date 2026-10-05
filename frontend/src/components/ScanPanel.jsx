import React, { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { Camera, Flashlight, Play, ScanLine, SwitchCamera } from "lucide-react";

// One scan surface for the Spare store, two ways in:
//  • Scanner gun (USB/Bluetooth HID) — types the barcode into a focused field
//    and presses Enter, so it registers automatically. Keystroke cadence tells
//    a gun's fast burst from hand typing, and slow (hand-typed) input is
//    rejected HERE — typing a code by hand is a separate, deliberate step (the
//    Scan Part "Manual Entry" tab), so a half-typed code can never be taken for
//    a scan. Emits onCode(code, "USB_SCANNER").
//  • Tablet camera (@zxing, rear camera, Code-128 / QR et al.) — for handsets
//    and tablets with no gun. Stops after a hit ("Scan next" to resume). Needs a
//    secure context (HTTPS or localhost); where it isn't available the toggle is
//    hidden and the gun is the only method. Emits onCode(code, "TABLET_CAMERA").
//
// variant "card" draws its own card; "bare" sits inside a card that already has
// one (the Scan Part input bar). `compact` drops the big icon and the how-to
// text — the workstation shrinks the box once a part is on screen, so the part
// and its actions fit above the fold while the gun stays ready.
const FAST_KEY_MS = 140; // avg inter-key gap at/above this = hand-typed (rejected)
const DUP_MS = 700;      // gun: swallow a trailing CR/LF or a quick re-read
const CAM_DUP_MS = 1500; // camera: ignore the same barcode briefly after a hit
const SLOW_TYPING_HINT = "That was typed by hand — this box takes the scanner gun only. Use Manual Entry to type a code.";

// Where a click must NOT pull focus back into the gun field: inside an open
// dialog (its focus trap owns the keyboard), or inside an action form marked
// data-scan-nofocus (clicking a choice card there must not steal the caret).
const KEEP_FOCUS = "[role='dialog'],[data-scan-nofocus]";

export default function ScanPanel({
  onCode, busy = false, autoFocus = true, hint, variant = "card", slowTypingHint = SLOW_TYPING_HINT,
  compact = false,
  focusSignal, // changes when the caller wants the gun field focused again (a form / dialog closed)
}) {
  const [method, setMethod] = useState("gun"); // "gun" | "camera"
  const [value, setValue] = useState("");
  const [warn, setWarn] = useState("");
  const [camError, setCamError] = useState("");
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [multiCam, setMultiCam] = useState(false);
  const [paused, setPaused] = useState(false); // camera stops after a hit; tap to scan next

  const inputRef = useRef(null);
  const keyTimesRef = useRef([]);
  const lastRef = useRef({ code: "", t: 0 });
  const videoRef = useRef(null);
  const controlsRef = useRef(null);
  const readerRef = useRef(null);
  const busyRef = useRef(busy);
  const deviceIdRef = useRef(undefined);
  const startSeqRef = useRef(0); // invalidates an in-flight async camera start
  useEffect(() => { busyRef.current = busy; }, [busy]);

  // Scan is GUN-ONLY by policy (user decision 2026-10-05): the camera method is
  // disabled so the toggle never shows and the gun is the only way in. The camera
  // code below is kept (unreachable) so it can be re-enabled if tablet scanning is
  // ever wanted — flip this back to the secure-context check.
  const cameraCapable = false;

  // ---------- gun: keep the field ready for the next scan ----------
  const focus = () => {
    if (method !== "gun" || !autoFocus || busy) return;
    if (document.querySelector("[aria-modal='true']")) return; // a dialog owns the keyboard
    inputRef.current?.focus();
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { focus(); }, [method, busy, autoFocus, focusSignal]);

  // If the operator clicks anywhere that is NOT a form control (a card, empty
  // space), pull focus back so the next gun scan still lands here. Only in gun
  // mode — in camera mode the video/controls own the clicks.
  useEffect(() => {
    const onDocClick = (e) => {
      if (method !== "gun" || busy || !autoFocus) return;
      if (e.target?.closest?.("input,textarea,select,button,a,label,[contenteditable]")) return;
      if (e.target?.closest?.(KEEP_FOCUS) || document.querySelector("[aria-modal='true']")) return;
      inputRef.current?.focus();
    };
    document.addEventListener("mouseup", onDocClick);
    return () => document.removeEventListener("mouseup", onDocClick);
  }, [method, busy, autoFocus]);

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
    // single scan so it never registers twice.
    const now = Date.now();
    if (code === lastRef.current.code && now - lastRef.current.t < DUP_MS) return;

    // Gun vs. hand: a scanner gun streams the whole code in a fast, even burst.
    // Only a long-enough code typed SLOWER than a gun is treated as manual.
    let isGun = true;
    if (times.length >= 3) {
      const gaps = times.slice(1).map((t, i) => t - times[i]);
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      isGun = avg < FAST_KEY_MS;
    }
    if (!isGun) {
      setWarn(slowTypingHint);
      setTimeout(() => setWarn(""), 3500);
      return;
    }

    lastRef.current = { code, t: now };
    setWarn("");
    onCode(code, "USB_SCANNER");
  };

  // ---------- camera (@zxing) ----------
  const stopCamera = () => {
    startSeqRef.current++; // any in-flight start() sees a stale seq and self-stops
    try { controlsRef.current?.stop(); } catch { /* already stopped */ }
    controlsRef.current = null;
    setTorchOn(false);
  };

  const startCamera = async (deviceId) => {
    setCamError("");
    const seq = ++startSeqRef.current;
    try {
      if (!readerRef.current) readerRef.current = new BrowserMultiFormatReader();
      const reader = readerRef.current;
      const cb = (result) => {
        if (!result || busyRef.current) return;
        const text = result.getText();
        const now = Date.now();
        // Stop after a successful read so the same in-frame barcode cannot
        // re-fire and wipe the operator's in-progress form.
        if (text === lastRef.current.code && now - lastRef.current.t < CAM_DUP_MS) return;
        lastRef.current = { code: text, t: now };
        stopCamera();
        setPaused(true);
        onCode(text, "TABLET_CAMERA");
      };
      const controls = deviceId
        ? await reader.decodeFromVideoDevice(deviceId, videoRef.current, cb)
        : await reader.decodeFromConstraints(
            { video: { facingMode: { ideal: "environment" } } }, videoRef.current, cb);
      // Switched mode / unmounted while getUserMedia was resolving — don't keep
      // this now-orphaned stream alive.
      if (startSeqRef.current !== seq) { try { controls.stop(); } catch { /* */ } return; }
      controlsRef.current = controls;
      deviceIdRef.current = deviceId;
      const track = videoRef.current?.srcObject?.getVideoTracks?.()[0];
      setTorchSupported(!!track?.getCapabilities?.().torch);
      try {
        const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
        setMultiCam(cams.length > 1);
      } catch { /* ignore */ }
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
    if (method === "camera" && cameraCapable) { setPaused(false); startCamera(deviceIdRef.current); }
    else stopCamera();
    return stopCamera;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method]);
  useEffect(() => () => stopCamera(), []);

  const toggleTorch = async () => {
    const track = videoRef.current?.srcObject?.getVideoTracks?.()[0];
    if (!track) return;
    try { await track.applyConstraints({ advanced: [{ torch: !torchOn }] }); setTorchOn((v) => !v); }
    catch { /* torch unsupported */ }
  };

  const switchCamera = async () => {
    try {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      if (cams.length < 2) return;
      const track = videoRef.current?.srcObject?.getVideoTracks?.()[0];
      const curId = track?.getSettings?.().deviceId;
      const idx = Math.max(0, cams.findIndex((d) => d.deviceId === curId));
      stopCamera();
      startCamera(cams[(idx + 1) % cams.length].deviceId);
    } catch { /* ignore */ }
  };

  const bare = variant === "bare";
  return (
    <div
      className={bare ? "" : "rounded-xl2 border border-slate-200 bg-white p-6 dark:border-navy-800 dark:bg-navy-900"}
      onClick={focus}
    >
      {/* Both methods offered — the camera tab only appears where the browser
          can actually open a camera (secure context); otherwise, gun only. */}
      {cameraCapable && (
        <div className={`mx-auto flex max-w-md gap-2 ${compact ? "mb-2" : bare ? "mb-3" : "mb-4"}`}>
          <button type="button" onClick={() => setMethod("gun")} disabled={busy}
            className={`flex-1 rounded-lg py-2.5 text-sm font-semibold ${
              method === "gun" ? "bg-toyotared text-white" : "bg-slate-100 text-slate-700 dark:bg-navy-800 dark:text-slate-200"}`}>
            <ScanLine size={16} className="inline-block align-[-3px] mr-1.5" aria-hidden="true" />Scanner gun
          </button>
          <button type="button" onClick={() => setMethod("camera")} disabled={busy}
            className={`flex-1 rounded-lg py-2.5 text-sm font-semibold ${
              method === "camera" ? "bg-toyotared text-white" : "bg-slate-100 text-slate-700 dark:bg-navy-800 dark:text-slate-200"}`}>
            <Camera size={16} className="inline-block align-[-3px] mr-1.5" aria-hidden="true" />Tablet camera
          </button>
        </div>
      )}

      {method === "gun" ? (
        <div className={`flex flex-col items-center text-center ${bare ? "gap-2" : "gap-3"}`}>
          {!compact && (
            <>
              <ScanLine size={bare ? 36 : 48} strokeWidth={1.5} className="text-slate-400 dark:text-slate-500" aria-hidden="true" />
              <div className={`${bare ? "text-base" : "text-lg"} font-semibold text-slate-800 dark:text-white`}>
                Scan a barcode or QR with the gun
              </div>
              <div className="text-sm text-slate-500 dark:text-slate-400">
                Point the scanner at the part&apos;s QR label or the supplier&apos;s barcode — it registers automatically.
              </div>
            </>
          )}

          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={busy}
            autoFocus={autoFocus}
            placeholder={hint || "Waiting for scan…"}
            inputMode="none"
            aria-label="Scanner gun input"
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
            <div role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              {warn}
            </div>
          )}
          {camError && (
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              {camError}
            </div>
          )}
        </div>
      ) : (
        <div>
          <div className="relative mx-auto max-w-md overflow-hidden rounded-lg bg-black">
            <video ref={videoRef} className="w-full" style={{ maxHeight: compact ? "28vh" : "50vh" }} muted playsInline />
            <div className="pointer-events-none absolute inset-6 rounded-lg border-2 border-white/70" />
            {paused && (
              <button type="button" onClick={() => { setPaused(false); startCamera(deviceIdRef.current); }}
                className="absolute inset-0 flex items-center justify-center bg-black/60 text-lg font-semibold text-white">
                <Play size={18} className="mr-2" aria-hidden="true" />Scan next part
              </button>
            )}
          </div>
          <div className="mt-3 flex justify-center gap-2">
            {torchSupported && (
              <button type="button" onClick={toggleTorch} className="btn-secondary">
                <Flashlight size={15} aria-hidden="true" />{torchOn ? "Torch off" : "Torch on"}
              </button>
            )}
            {multiCam && (
              <button type="button" onClick={switchCamera} className="btn-secondary"><SwitchCamera size={15} aria-hidden="true" />Switch camera</button>
            )}
          </div>
          <p className="mt-2 text-center text-xs text-slate-500 dark:text-slate-400">
            {hint || "Point the rear camera at the part’s QR label or barcode."}
          </p>
        </div>
      )}
    </div>
  );
}
