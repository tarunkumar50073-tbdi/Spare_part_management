import React from "react";
import { Minus, Plus } from "lucide-react";

// [ - ] 1 [ + ] quantity input used across the Scan Part forms (label quantity,
// issue / return / inspection / RGP quantities). Clamped to [min, max]; typing
// is allowed for big numbers. `step` defaults to 1; decimals are kept to 2 dp.
export default function QtyStepper({
  value, onChange, min = 1, max = Infinity, step = 1, disabled = false,
  id, label = "Quantity", size = "md",
}) {
  const clamp = (n) => {
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
  };
  const v = Number(value);
  const set = (n) => onChange?.(clamp(n));
  const h = size === "lg" ? "h-12 text-lg" : "h-10";
  const btn = `${h} w-10 inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-navy-700 `
    + "bg-white dark:bg-navy-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-navy-700 "
    + "disabled:opacity-40 disabled:cursor-not-allowed transition-colors";
  return (
    <div className="inline-flex items-center gap-2" role="group" aria-label={label}>
      <button type="button" className={btn} onClick={() => set(v - step)}
        disabled={disabled || !(v > min)} aria-label={`Decrease ${label.toLowerCase()}`}>
        <Minus className="w-4 h-4" />
      </button>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        className={`input-field ${h} !w-20 text-center tabular-nums font-semibold`}
        value={Number.isFinite(v) ? v : ""}
        min={min}
        max={Number.isFinite(max) ? max : undefined}
        step={step}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => {
          const n = e.target.value === "" ? NaN : Number(e.target.value);
          onChange?.(Number.isFinite(n) ? n : e.target.value);
        }}
        onBlur={() => set(v)}
      />
      <button type="button" className={btn} onClick={() => set(v + step)}
        disabled={disabled || !(v < max)} aria-label={`Increase ${label.toLowerCase()}`}>
        <Plus className="w-4 h-4" />
      </button>
    </div>
  );
}
