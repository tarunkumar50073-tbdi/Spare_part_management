import React from "react";

// For a panel whose figure the database cannot answer yet.
//
// The alternative was drawing the card with zeros, and a zero is a claim: it
// says "we measured this and it was none". Where nothing is captured at all,
// that claim is false and unfalsifiable — the panel would look healthy forever.
// So the card is built, laid out and ready for its API, and says plainly what
// has to be recorded before it can show anything.
export default function NotCaptured({ what, needs, endpoint }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 dark:border-navy-700
      bg-slate-50/60 dark:bg-navy-800/40 px-4 py-5 text-center">
      <p className="text-2xl leading-none mb-2" aria-hidden="true">📭</p>
      <p className="text-sm font-medium text-slate-600 dark:text-slate-300">{what}</p>
      {needs && <p className="text-[11px] text-slate-400 mt-1.5 max-w-md mx-auto leading-relaxed">{needs}</p>}
      {endpoint && (
        <p className="text-[10px] text-slate-400 mt-2 font-mono">
          waiting on <span className="text-slate-500 dark:text-slate-300">{endpoint}</span>
        </p>
      )}
    </div>
  );
}
