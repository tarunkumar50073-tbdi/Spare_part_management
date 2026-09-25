import React from "react";
import Glyph from "./Glyph.jsx";

// Card header: a small tinted glyph chip, the title, and a one-line subtitle.
// The chip is what makes a wall of cards scannable from a distance — you find
// the card by its colour before you have read a word of its name.
const HEAD_TONES = {
  navy: "bg-navy-900/[0.06] text-navy-900 dark:bg-white/10 dark:text-white",
  blue: "bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300",
  amber: "bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300",
  green: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300",
  red: "bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300",
  violet: "bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300",
};

export default function CardHead({ icon, tone = "navy", title, hint, action }) {
  return (
    <div className="flex items-start justify-between gap-3 mb-3">
      <div className="flex items-center gap-2.5 min-w-0">
        {icon && (
          <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-base leading-none ${HEAD_TONES[tone]}`}>
            <Glyph icon={icon} size={16} />
          </span>
        )}
        <div className="min-w-0">
          <h3 className="font-semibold text-slate-800 dark:text-white text-sm leading-tight truncate">{title}</h3>
          {hint && <p className="text-[11px] text-slate-400 leading-tight mt-0.5">{hint}</p>}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
