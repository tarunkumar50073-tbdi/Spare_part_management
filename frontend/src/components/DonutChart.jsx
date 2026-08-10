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

  return (
    <div className="flex items-center gap-4">
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
            onClick={onSliceClick ? () => onSliceClick(d) : undefined}
            className={onSliceClick ? "cursor-pointer hover:opacity-80 transition-opacity" : undefined}
          />
        ))}
      </svg>

      <div className="min-w-0 flex-1">
        {(centerValue != null || centerLabel) && (
          <div className="mb-2">
            {centerValue != null && <p className="kpi-value text-2xl">{centerValue}</p>}
            {centerLabel && <p className="text-[11px] text-slate-400">{centerLabel}</p>}
          </div>
        )}
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
