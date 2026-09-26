import React from "react";
import { Check } from "lucide-react";

// Where the operator is in a label print: set up -> confirm -> print (and say
// whether it came out) -> done. A print is only recorded at the last step, so
// seeing the steps makes it obvious that closing half-way records nothing.
export default function PrintSteps({ steps, current }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold" aria-label="Label print steps">
      {steps.map((s, i) => {
        const state = i < current ? "done" : i === current ? "now" : "todo";
        return (
          <li key={s} className="flex items-center gap-2" aria-current={state === "now" ? "step" : undefined}>
            <span className={`grid h-5 w-5 place-items-center rounded-full text-[10px] ${
              state === "now" ? "bg-toyotared text-white"
                : state === "done" ? "bg-emerald-500 text-white"
                  : "bg-slate-200 text-slate-500 dark:bg-navy-800 dark:text-slate-400"}`}>
              {state === "done" ? <Check size={11} aria-hidden="true" /> : i + 1}
            </span>
            <span className={state === "todo" ? "text-slate-400" : "text-slate-700 dark:text-slate-200"}>{s}</span>
            {i < steps.length - 1 && <span className="h-px w-5 bg-slate-200 dark:bg-navy-700" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}
