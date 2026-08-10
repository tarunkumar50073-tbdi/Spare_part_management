import React, { useEffect, useRef, useState } from "react";
import { ScanLine, Camera, Keyboard } from "lucide-react";

let scannerIdSeq = 0;

/** Barcode/QR input with two interchangeable modes — keyboard-wedge (USB/BT
 * scanner typing into a focused input, Enter submits) and camera (QR read
 * via device camera through html5-qrcode). Both call the same onScan(code)
 * callback, so every page using this component doesn't care which mode is
 * active. Plant floor can drop whichever mode they don't need later. */
export default function BarcodeScanInput({ onScan, placeholder = "Scan or type a barcode, then Enter", autoFocus = true, disabled = false }) {
  const [mode, setMode] = useState("keyboard");
  const [value, setValue] = useState("");
  const inputRef = useRef(null);
  const elementIdRef = useRef(`barcode-camera-${++scannerIdSeq}`);
  const scannerRef = useRef(null);

  useEffect(() => {
    if (mode === "keyboard" && autoFocus && !disabled) {
      inputRef.current?.focus();
    }
  }, [mode, autoFocus, disabled]);

  useEffect(() => {
    if (mode !== "camera" || disabled) return;
    let cancelled = false;

    import("html5-qrcode").then(({ Html5Qrcode }) => {
      if (cancelled) return;
      const scanner = new Html5Qrcode(elementIdRef.current);
      scannerRef.current = scanner;
      scanner
        .start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 220, height: 220 } },
          (decodedText) => onScan(decodedText)
        )
        .catch(() => {
          /* camera unavailable/denied — user can switch back to keyboard mode */
        });
    });

    return () => {
      cancelled = true;
      const scanner = scannerRef.current;
      if (scanner) {
        scanner.stop().then(() => scanner.clear()).catch(() => {});
        scannerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, disabled]);

  const submitKeyboard = (e) => {
    e.preventDefault();
    const code = value.trim();
    if (!code) return;
    onScan(code);
    setValue("");
  };

  // Handle Enter directly rather than relying only on native form-submit-on-
  // Enter — some scanner drivers/automation dispatch key events that don't
  // trigger the browser's implicit form submission.
  const handleKeyDown = (e) => {
    if (e.key === "Enter") submitKeyboard(e);
  };

  return (
    <div className="space-y-2">
      <div className="inline-flex rounded-lg border border-slate-200 dark:border-navy-800 p-0.5 bg-slate-50 dark:bg-navy-950">
        <button
          type="button"
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            mode === "keyboard" ? "bg-white dark:bg-navy-800 text-toyotared shadow-sm" : "text-slate-500"
          }`}
          onClick={() => setMode("keyboard")}
        >
          <Keyboard size={14} /> Scanner
        </button>
        <button
          type="button"
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            mode === "camera" ? "bg-white dark:bg-navy-800 text-toyotared shadow-sm" : "text-slate-500"
          }`}
          onClick={() => setMode("camera")}
        >
          <Camera size={14} /> Camera
        </button>
      </div>

      {mode === "keyboard" ? (
        <form onSubmit={submitKeyboard} className="relative">
          <ScanLine className="absolute left-3 top-2.5 text-slate-400" size={16} />
          <input
            ref={inputRef}
            className="input-field pl-9"
            placeholder={placeholder}
            value={value}
            disabled={disabled}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            autoComplete="off"
          />
        </form>
      ) : (
        <div id={elementIdRef.current} className="rounded-lg overflow-hidden border border-slate-200 dark:border-navy-800 max-w-xs" />
      )}
    </div>
  );
}
