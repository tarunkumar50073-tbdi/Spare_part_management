import React from "react";

// The app-icon tile's look — a tile washed and ringed in its own colour. On the
// sidebar's navy rail it is navy; `light` gives it the white of the top bar
// instead (the store, 23 Oct 2026: "in sabka colour top bar jaisa hi rkhna side
// bar ka jaisa nhi"). Shared so a control with a label (the plant switch) wears
// the same face as the icon tiles. `lit` marks the open / active one.
export const tileStyle = (color, lit = false, light = false) => (light
  ? {
    background: `linear-gradient(150deg, ${color}2e, #ffffff 70%)`,
    border: `1.5px solid ${color}${lit ? "" : "99"}`,
    boxShadow: `0 3px 10px ${color}${lit ? "40" : "1f"}, inset 0 1px 0 rgba(255,255,255,0.9)`,
  }
  : {
    background: `linear-gradient(150deg, ${color}3d, rgba(8,18,38,0.9) 64%)`,
    border: `1.5px solid ${color}${lit ? "" : "b3"}`,
    boxShadow: `0 4px 12px ${color}${lit ? "59" : "26"}, inset 0 1px 0 rgba(255,255,255,0.16)`,
  });

// The app-icon tile: an emoji in that tile. The sidebar's modules show it, and
// the top bar's buttons use the same tile so the two read as one set ("header
// wale icon bhi side bar type icon kar de" — the store, 23 Oct 2026).
export default function IconTile({ emoji, color, size = 40, lit = false, light = false, className = "" }) {
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-[11px] leading-none select-none ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5), ...tileStyle(color, lit, light) }}
    >
      {emoji}
    </span>
  );
}
