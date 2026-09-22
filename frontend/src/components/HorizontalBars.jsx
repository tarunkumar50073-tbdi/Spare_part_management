import React from "react";

// Ranked horizontal bars — for "which supplier is late most often", "which
// category holds the most short parts" and similar. Names in this plant are
// long ("NEEMRANA STEEL SERVICE CENTER INDIA P LT"), which is exactly the case
// a vertical bar chart handles worst: the label ends up rotated or truncated.
// Horizontally, the label gets a full line and the bar sits under it.
export default function HorizontalBars({
  data = [],
  color = "#e11d48",
  emptyMessage = "Nothing to show",
  onBarClick,
  valueSuffix = "",
  // Optional formatter for the figure printed at the end of each bar — e.g.
  // money() so a value bar reads "₹24,00,000" while the width still scales on
  // the raw number. Falls back to the plain number plus valueSuffix.
  valueFormat,
}) {
  const rows = data.filter((d) => d.value > 0);
  if (rows.length === 0) {
    return <p className="text-sm text-slate-400 text-center py-6">{emptyMessage}</p>;
  }

  // Scaled to the largest bar rather than to the total: this compares items
  // with each other, it is not a composition.
  const max = Math.max(...rows.map((d) => d.value));

  return (
    <ul className="space-y-2.5">
      {rows.map((d) => {
        const clickable = Boolean(onBarClick);
        return (
          <li key={d.name}>
            <button
              type="button"
              disabled={!clickable}
              onClick={clickable ? () => onBarClick(d) : undefined}
              className={`w-full text-left group ${clickable ? "cursor-pointer" : "cursor-default"}`}
            >
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <span className={`text-xs text-slate-600 dark:text-slate-300 truncate ${clickable ? "group-hover:text-toyotared" : ""}`}>
                  {d.name}
                </span>
                <span className="text-xs font-semibold text-slate-800 dark:text-white tabular shrink-0">
                  {valueFormat ? valueFormat(d.value) : `${d.value}${valueSuffix}`}
                </span>
              </div>
              <div className="h-2 rounded-full bg-slate-100 dark:bg-navy-800 overflow-hidden">
                <div
                  className="h-full rounded-full transition-[width] duration-700 ease-enterprise motion-reduce:transition-none"
                  style={{ width: `${(d.value / max) * 100}%`, background: d.color || color }}
                />
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
