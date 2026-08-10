import React from "react";

// Radial progress ring for a single percentage. A number on its own gives no
// sense of where it sits in its range; the arc does, at a glance, from across
// a plant floor.
//
// The colour follows the value, but which direction is "good" depends on the
// metric: 95% healthy stock and 95% rack fill are opposite readings. `polarity`
// says which way round it is, so a gauge is never green for a bad number.
const RADIUS = 42;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const GREEN = "#059669";
const AMBER = "#f59e0b";
const ROSE = "#e11d48";

const toneFor = (pct, polarity) => {
  if (polarity === "higher-better") {
    if (pct >= 80) return GREEN;
    if (pct >= 50) return AMBER;
    return ROSE;
  }
  // higher-worse: the original reading — fill rate, critical share, excess.
  if (pct >= 90) return ROSE;
  if (pct >= 70) return AMBER;
  return GREEN;
};

export default function RadialGauge({
  value,
  size = 128,
  thickness = 12,
  label,
  emptyNote,
  // "higher-better" for coverage and health, "higher-worse" for critical and
  // excess. Left as-is for the rack fill gauge that first used this.
  polarity = "higher-worse",
  // Fixed colour, when the metric's meaning is not a simple good/bad ramp.
  color,
  // Small caption under the ring — the count behind the percentage, so the
  // share and the absolute figure are read together.
  caption,
  // Hover text. A percentage always hides its own arithmetic; this shows it.
  tooltip,
}) {
  // A metric with no denominator still gets its ring — the track is drawn and
  // the centre reads "—". Every card in a row then looks like the same kind of
  // card, without the blank one claiming it measured something and found 0%.
  const measured = value != null;
  const pct = measured ? Math.max(0, Math.min(100, value)) : 0;
  const stroke = color || toneFor(pct, polarity);

  return (
    <div className="flex flex-col items-center">
      <div
        className="relative shrink-0 max-w-full"
        style={{ width: size, height: size }}
        title={measured ? tooltip || undefined : emptyNote || "Not measurable yet"}
        role="img"
        aria-label={measured
          ? `${label || "Value"}: ${Math.round(pct)}%`
          : `${label || "Value"}: not measurable yet`}
      >
        <svg viewBox="0 0 100 100" className="-rotate-90 w-full h-full" aria-hidden="true">
          <circle
            cx="50" cy="50" r={RADIUS}
            fill="none" strokeWidth={thickness}
            className="stroke-slate-100 dark:stroke-navy-800"
          />
          {measured && (
            <circle
              cx="50" cy="50" r={RADIUS}
              fill="none" stroke={stroke} strokeWidth={thickness}
              strokeDasharray={`${(pct / 100) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
              strokeLinecap="round"
              className="transition-[stroke-dasharray] duration-700 ease-enterprise motion-reduce:transition-none"
            />
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center px-2">
          {measured ? (
            <span className="kpi-value text-2xl leading-none">{Math.round(pct)}%</span>
          ) : (
            <span className="text-2xl leading-none text-slate-300 dark:text-slate-600">—</span>
          )}
          {label && <span className="text-[10px] text-slate-400 mt-1 text-center leading-tight">{label}</span>}
        </div>
      </div>
      <p className="text-[11px] mt-2 text-center leading-tight px-1
        text-slate-500 dark:text-slate-400">
        {measured ? caption : (emptyNote || "Not measurable yet")}
      </p>
    </div>
  );
}
