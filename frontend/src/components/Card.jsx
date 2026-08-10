import React from "react";
import KpiCard from "./KpiCard.jsx";

// A thin adapter over KpiCard rather than a second implementation of the same
// tile. Existing call sites pass title/accent/subtitle and keep working, while
// the tile itself is drawn in exactly one place.
const ACCENT_TO_TONE = {
  navy: "navy",
  red: "red",
  green: "green",
  amber: "amber",
  blue: "blue",
  gray: "navy",
};

export default function Card({ title, value, icon, accent = "navy", subtitle, loading, onClick }) {
  return (
    <KpiCard
      label={title}
      value={value}
      icon={icon}
      tone={ACCENT_TO_TONE[accent] || "navy"}
      // Subtitles are sometimes a rendered element (the vs-yesterday line);
      // only a plain string belongs in the hint slot.
      hint={typeof subtitle === "string" ? subtitle : undefined}
      loading={loading}
      onClick={onClick}
    />
  );
}
