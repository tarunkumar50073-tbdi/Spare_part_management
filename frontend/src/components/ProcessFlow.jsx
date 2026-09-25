import React from "react";
import Glyph from "./Glyph.jsx";

// The store's material flow as a row of stages with the count sitting at each.
//
// Drawn as connected tiles rather than a chart: this is a pipeline, and what a
// supervisor reads off it is where material is piling up. A stage holding
// nothing is drawn quiet rather than green — an empty stage is not a healthy
// stage, it is simply a stage with nothing in it.
const TONE = {
  active: {
    tile: "bg-white dark:bg-navy-900 border-slate-200 dark:border-navy-700",
    value: "text-slate-800 dark:text-white",
  },
  waiting: {
    tile: "bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30",
    value: "text-amber-700 dark:text-amber-300",
  },
  done: {
    tile: "bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/30",
    value: "text-emerald-700 dark:text-emerald-300",
  },
  empty: {
    tile: "bg-slate-50 dark:bg-navy-800/60 border-slate-200 dark:border-navy-700",
    value: "text-slate-300 dark:text-slate-600",
  },
};

export default function ProcessFlow({ stages = [], onStageClick }) {
  return (
    <div className="overflow-x-auto -mx-1 px-1">
      <ol className="flex items-stretch gap-1.5 min-w-max">
        {stages.map((s, i) => {
          const tone = TONE[s.count > 0 ? (s.tone || "active") : "empty"];
          const clickable = Boolean(onStageClick) && s.count > 0;
          return (
            <li key={s.key} className="flex items-stretch gap-1.5">
              <button
                type="button"
                disabled={!clickable}
                onClick={clickable ? () => onStageClick(s) : undefined}
                title={s.hint || undefined}
                className={`w-[124px] rounded-xl border px-2.5 py-2.5 text-left transition-all
                  ${tone.tile} ${clickable ? "cursor-pointer hover:-translate-y-0.5 hover:shadow-card" : "cursor-default"}`}
              >
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Glyph icon={s.icon || s.emoji} size={14} className="text-slate-500 dark:text-slate-400" />
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 truncate">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </div>
                <p className={`text-xl font-bold tabular leading-none ${tone.value}`}>{s.count}</p>
                <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-tight mt-1.5 line-clamp-2">
                  {s.label}
                </p>
              </button>
              {i < stages.length - 1 && (
                <span className="self-center text-slate-300 dark:text-navy-700 text-xs shrink-0" aria-hidden="true">
                  ›
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
