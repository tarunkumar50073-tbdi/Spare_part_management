import React, { useEffect, useRef } from "react";
import JsBarcode from "jsbarcode";

// On-screen preview of the physical label: Code-128 barcode (Part No. only) +
// Part No + short description. Sized proportional to the configured mm label so
// the operator sees the real proportions before printing.
export default function BarcodeLabel({ value, partNo, description, config }) {
  const ref = useRef(null);
  const w = Number(config?.width_mm) || 100;
  const h = Number(config?.height_mm) || 50;
  const maxChars = Number(config?.description_max_chars) || 48;
  const desc = (description || "").slice(0, maxChars);

  useEffect(() => {
    if (ref.current && value) {
      try {
        JsBarcode(ref.current, String(value), {
          format: "CODE128", displayValue: false, width: 2, height: 60, margin: 0,
        });
      } catch {
        /* an unencodable value just renders blank; resolve/print still guard it */
      }
    }
  }, [value]);

  const pxH = 150;
  const pxW = Math.round(pxH * (w / h));
  return (
    <div
      className="flex flex-col items-center justify-center border border-slate-300 bg-white text-black"
      style={{ width: pxW, height: pxH, padding: 8 }}
    >
      <svg ref={ref} style={{ width: "88%", height: "auto", maxHeight: "55%" }} />
      {config?.show_part_no !== false && (
        <div style={{ fontWeight: 700, fontSize: 16, marginTop: 4, letterSpacing: 0.5 }}>{partNo}</div>
      )}
      {config?.show_description !== false && desc && (
        <div style={{ fontSize: 10, textAlign: "center", lineHeight: 1.1, marginTop: 2 }}>{desc}</div>
      )}
    </div>
  );
}
