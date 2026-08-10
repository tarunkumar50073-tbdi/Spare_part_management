import React, { useId } from "react";

// Hand-drawn SVG rather than a chart library. A KPI card may hold a dozen of
// these, and Recharts mounts a full responsive container per chart — far too
// much machinery for sixty pixels of trend line that carries no axis, legend
// or tooltip of its own.
export default function Sparkline({
  data = [],
  width = 72,
  height = 24,
  className = "",
  stroke = "currentColor",
  fill = true,
}) {
  const gradientId = useId();
  const points = (data || []).filter((n) => typeof n === "number" && Number.isFinite(n));

  // One point is not a trend, so draw nothing rather than a misleading dot.
  if (points.length < 2) return null;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const stepX = width / (points.length - 1);
  // A flat series would otherwise hug the very bottom edge; the inset keeps
  // the stroke visible and stops it clipping.
  const inset = 2;
  const usableHeight = height - inset * 2;

  const coords = points.map((value, i) => {
    const x = i * stepX;
    const y = inset + usableHeight - ((value - min) / span) * usableHeight;
    return [x, y];
  });

  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden="true"
      focusable="false"
      preserveAspectRatio="none"
    >
      {fill && (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.18" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gradientId})`} />
        </>
      )}
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* The latest reading is the one being asked about, so it gets a dot. */}
      <circle cx={coords[coords.length - 1][0]} cy={coords[coords.length - 1][1]} r="1.8" fill={stroke} />
    </svg>
  );
}
