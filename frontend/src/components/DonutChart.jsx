import React from "react";

// Composition chart for a handful of mutually exclusive buckets (rack status,
// supplier punctuality). Hand-drawn SVG for the same reason as Sparkline: a
// Recharts PieChart brings a responsive container, tooltip layer and legend
// engine for what is four arcs and four labels.
//
// Drawn with stroke-dasharray on a single circle rather than arc paths — no
// trigonometry to get wrong, and a segment of 100% stays a full ring instead
// of collapsing into a zero-length arc.
const RADIUS = 42;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export default function DonutChart({
  data = [],
  colors = {},
  size = 132,
  thickness = 14,
  centerValue,
  centerLabel,
  emptyMessage = "No data yet",
  // Opens the list behind a slice. Optional — a chart nobody has given a
  // handler to stays exactly as inert as it was.
  onSliceClick,
  // Render only the ring (centre value in its hole), no built-in legend — for
  // callers that draw their own richer legend beside it (e.g. the health card,
  // which also carries a value column). The ring + its slice clicks are kept.
  hideLegend = false,
  // Ring on TOP, legend BELOW it full-width (not beside) — for a narrow column
  // where a side-by-side legend would truncate the labels. Full names, no clip.
  stack = false,
}) {
  const slices = data.filter((d) => d.value > 0);
  const total = slices.reduce((sum, d) => sum + d.value, 0);

  if (total === 0) {
    return <p className="text-sm text-slate-400 text-center py-8">{emptyMessage}</p>;
  }

  let offset = 0;
  const arcs = slices.map((d) => {
    const length = (d.value / total) * CIRCUMFERENCE;
    const arc = { ...d, length, offset };
    offset += length;
    return arc;
  });

  const ring = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className="shrink-0 -rotate-90"
      role="img"
      aria-label={slices.map((d) => `${d.name}: ${d.value}`).join(", ")}
    >
      <circle
        cx="50" cy="50" r={RADIUS}
        fill="none" strokeWidth={thickness}
        className="stroke-slate-100 dark:stroke-navy-800"
      />
      {arcs.map((d) => (
        <circle
          key={d.name}
          cx="50" cy="50" r={RADIUS}
          fill="none"
          stroke={colors[d.name] || "#94a3b8"}
          strokeWidth={thickness}
          strokeDasharray={`${d.length} ${CIRCUMFERENCE - d.length}`}
          strokeDashoffset={-d.offset}
          strokeLinecap="butt"
          onClick={onSliceClick ? (e) => { e.stopPropagation(); onSliceClick(d); } : undefined}
          className={onSliceClick ? "cursor-pointer hover:opacity-80 transition-opacity" : undefined}
        />
      ))}
    </svg>
  );

  // The ring with its total in the hole, where a donut's total is looked for
  // (it used to sit under or beside the ring and read as off-centre) — the
  // same in every layout below. The figure scales with the ring and a longer
  // one is set smaller, so it stays inside the hole; the overlay takes no
  // clicks, so every slice still opens.
  const digits = String(centerValue ?? "").length;
  const centreScale = digits > 8 ? 0.1 : digits > 6 ? 0.125 : 0.16;
  const centred = (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      {ring}
      {(centerValue != null || centerLabel) && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          {centerValue != null && (
            <p className="kpi-value leading-none" style={{ fontSize: Math.round(size * centreScale) }}>
              {centerValue}
            </p>
          )}
          {centerLabel && <p className="mt-1 text-[11px] leading-none text-slate-400">{centerLabel}</p>}
        </div>
      )}
    </div>
  );

  // Ring only (caller supplies its own legend).
  if (hideLegend) return <div className="flex flex-col items-center">{centred}</div>;

  // Stacked: ring centred on top, legend below using the FULL width so long
  // labels ("Not Counted", "Above Maximum", "Out of Stock") never truncate.
  if (stack) {
    return (
      <div className="flex flex-col items-center gap-2">
        {centred}
        <ul className="mt-1 w-full space-y-0.5">
          {data.map((d) => {
            const pct = Math.round((d.value / total) * 100);
            const inner = (
              <div className="flex items-center gap-2 rounded-md px-2 py-1 text-sm">
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: colors[d.name] || "#94a3b8" }} />
                <span className={`flex-1 text-left text-slate-600 dark:text-slate-300 ${onSliceClick ? "group-hover:text-toyotared" : ""}`}>{d.name}</span>
                <span className="tabular font-semibold text-slate-800 dark:text-white">{d.value}</span>
                <span className="tabular w-10 text-right text-[11px] text-slate-400">{pct}%</span>
              </div>
            );
            return (
              <li key={d.name}>
                {onSliceClick ? (
                  <button type="button" onClick={() => onSliceClick(d)}
                    className="group w-full cursor-pointer hover:bg-slate-50 dark:hover:bg-navy-800/60 rounded-md">{inner}</button>
                ) : inner}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-4">
      {centred}

      <div className="min-w-0 flex-1">
        <ul className="space-y-1">
          {data.map((d) => {
            // The legend is the reliable target — an arc is a thin ring and a
            // 0-value slice has no arc to aim at at all.
            const row = (
              <>
                <span
                  className="h-2.5 w-2.5 rounded-sm shrink-0"
                  style={{ background: colors[d.name] || "#94a3b8" }}
                />
                <span className={`text-slate-500 dark:text-slate-400 truncate flex-1 text-left
                  ${onSliceClick ? "group-hover:text-toyotared" : ""}`}>{d.name}</span>
                <span className="font-semibold text-slate-800 dark:text-white tabular">{d.value}</span>
                <span className="text-[10px] text-slate-400 tabular w-9 text-right">
                  {Math.round((d.value / total) * 100)}%
                </span>
              </>
            );
            return (
              <li key={d.name}>
                {onSliceClick ? (
                  <button type="button" onClick={() => onSliceClick(d)}
                    className="group w-full flex items-center gap-2 text-xs cursor-pointer">
                    {row}
                  </button>
                ) : (
                  <div className="flex items-center gap-2 text-xs">{row}</div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
