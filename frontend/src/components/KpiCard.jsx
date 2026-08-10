import React from "react";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import Sparkline from "./Sparkline.jsx";
import { useCountUp } from "../hooks/useCountUp.js";

// One KPI tile for the whole app. The dashboard previously carried its own
// inline version and Card.jsx a second — same tile, two implementations that
// had already drifted apart. Both now come through here.
//
// Tones are semantic, not decorative: navy is the default reading, amber and
// red mean something needs attention. A page where every tile is coloured
// tells the operator nothing, so most stay navy.
const TONES = {
  navy: {
    value: "text-slate-900 dark:text-white",
    icon: "bg-navy-900/[0.06] text-navy-900 dark:bg-white/10 dark:text-white",
    spark: "#0f1f38",
    rail: "bg-navy-900/70",
  },
  green: {
    value: "text-emerald-700 dark:text-emerald-400",
    icon: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    spark: "#059669",
    rail: "bg-emerald-500",
  },
  amber: {
    value: "text-amber-700 dark:text-amber-400",
    icon: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    spark: "#d97706",
    rail: "bg-amber-500",
  },
  red: {
    value: "text-rose-700 dark:text-rose-400",
    icon: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
    spark: "#e11d48",
    rail: "bg-toyotared",
  },
  blue: {
    value: "text-blue-700 dark:text-blue-400",
    icon: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    spark: "#2563eb",
    rail: "bg-blue-500",
  },
  violet: {
    value: "text-violet-700 dark:text-violet-400",
    icon: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    spark: "#7c3aed",
    rail: "bg-violet-500",
  },
  cyan: {
    value: "text-cyan-700 dark:text-cyan-400",
    icon: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
    spark: "#0891b2",
    rail: "bg-cyan-500",
  },
};

// The featured-tile chip, matching CardHead's so a KPI strip and the cards
// under it read as one page. Tint plus a coloured glyph — not a solid block:
// the number is what should be loudest on a white card.
const CHIP = {
  navy: "bg-navy-900/[0.06] text-navy-900 dark:bg-white/10 dark:text-white",
  blue: "bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300",
  amber: "bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300",
  green: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300",
  red: "bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300",
  violet: "bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300",
  cyan: "bg-cyan-50 text-cyan-600 dark:bg-cyan-500/15 dark:text-cyan-300",
};

// `featured` is a layout, not a palette: the same white card as every other
// card on the page, with a larger chip held to the right and the label above
// the figure. A store whose whole dashboard is a strip of headline numbers
// needs them to carry, but a dark strip over white cards read as a different
// page pasted on top — so the colour stays in the chip and the figure.

// For a shortage, more is worse — so the arrow direction and its colour are
// separate decisions. `invertTrend` says which way is good.
function Trend({ delta, invert }) {
  if (delta == null) return null;
  const flat = delta === 0;
  const rising = delta > 0;
  const bad = invert ? rising : !rising;
  const Icon = flat ? Minus : rising ? ArrowUp : ArrowDown;
  const tone = flat
    ? "text-slate-400"
    : bad
      ? "text-rose-600 dark:text-rose-400"
      : "text-emerald-600 dark:text-emerald-400";
  return (
    <span className={clsx("inline-flex items-center gap-0.5 text-[11px] font-semibold tabular", tone)}>
      <Icon size={12} strokeWidth={2.5} />
      {flat ? "0" : Math.abs(delta).toLocaleString()}
    </span>
  );
}

export default function KpiCard({
  label,
  value,
  // The unrounded figure, when `value` is abbreviated for width. Shown on
  // hover so a rounded headline never hides the real number.
  valueTitle,
  // Short qualifier printed after the number in small caps — "PCS", "JUL".
  // Keeps the unit out of the figure itself so the digits stay scannable.
  unit,
  icon: Icon,
  tone = "navy",
  hint,
  delta = null,
  invertTrend = false,
  trendLabel = "vs yesterday",
  series = null,
  priority = false,
  loading = false,
  // The headline-tile layout — see the note above CHIP.
  featured = false,
  onClick,
}) {
  const colors = TONES[tone] || TONES.navy;
  const shown = useCountUp(value);

  if (loading) {
    return (
      <div className="card !p-4">
        <div className="skeleton h-3 w-24 mb-3" />
        <div className="skeleton h-7 w-16 mb-2" />
        <div className="skeleton h-3 w-20" />
      </div>
    );
  }

  const clickable = Boolean(onClick);

  const figure = (
    <>
      <p className={clsx("kpi-value truncate", colors.value)} title={valueTitle}>
        {typeof shown === "number" ? shown.toLocaleString() : shown}
        {unit && <span className="ml-1 text-[11px] font-semibold uppercase text-slate-400">{unit}</span>}
      </p>
      <div className="flex items-center gap-1.5 mt-1.5 min-h-[15px]">
        <Trend delta={delta} invert={invertTrend} />
        {hint ? (
          <span className="truncate kpi-hint">{hint}</span>
        ) : (
          delta != null && <span className="truncate kpi-hint">{trendLabel}</span>
        )}
      </div>
    </>
  );

  const chip = CHIP[tone] || CHIP.navy;
  const badge = typeof Icon === "string" ? (
    <span className={clsx("shrink-0 leading-none", featured
      ? `w-10 h-10 rounded-xl ${chip} flex items-center justify-center text-lg`
      : "text-base")} aria-hidden="true">{Icon}</span>
  ) : Icon ? (
    <span className={clsx("flex items-center justify-center shrink-0 rounded-lg",
      featured ? `w-10 h-10 ${chip}` : `w-7 h-7 ${colors.icon}`)}>
      <Icon size={featured ? 18 : 15} strokeWidth={2} />
    </span>
  ) : null;

  return (
    <div
      onClick={onClick}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => e.key === "Enter" && onClick() : undefined}
      className={clsx(
        "relative overflow-hidden p-4 rounded-xl2 transition-all duration-200 ease-enterprise card !p-4",
        !featured && "flex flex-col gap-2",
        clickable && "card-interactive",
        // The one visual weight available for "read this first". Used sparingly
        // or it stops meaning anything.
        priority && "ring-1 ring-inset ring-rose-500/20",
      )}
    >
      {priority && <span className={clsx("absolute inset-y-0 left-0 w-[3px]", colors.rail)} />}

      {featured ? (
        // Label above the figure, chip held to the right. The chip stops
        // competing with the number for the top line, which is what a strip of
        // ten headline readings needs.
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate kpi-label mb-1.5">{label}</p>
            {figure}
          </div>
          {badge}
        </div>
      ) : (
        <>
          {/* Icon and label share the top line, the way a dense KPI strip
              reads — the eye runs down a column of numbers, not around each
              card. The emoji stays unboxed: it carries its own colour. */}
          <div className="flex items-center gap-2 min-w-0">
            {badge}
            <p className="truncate kpi-label">{label}</p>
          </div>
          <div className="flex items-end justify-between gap-2">
            <div className="min-w-0">{figure}</div>
            {series && series.length > 1 && (
              <Sparkline data={series} stroke={colors.spark} className="shrink-0 opacity-80" />
            )}
          </div>
        </>
      )}
    </div>
  );
}
