import React from "react";
import { QrCode } from "lucide-react";

// The right side of Scan Part before a part is scanned. (The bin-label card
// that showed the tag hanging at the part's location went on 27 Oct 2026: the
// store puts no tag at the location — "location par tag lagana nhi h".)

export function PartVisualPlaceholder() {
  return (
    <section className="card flex flex-col items-center p-6 text-center" aria-label="Part visual">
      <span className="flex h-14 w-14 items-center justify-center rounded-xl bg-slate-100 text-slate-400 dark:bg-navy-800">
        <QrCode size={28} aria-hidden="true" />
      </span>
      <p className="mt-3 text-sm font-semibold text-slate-700 dark:text-slate-200">No part on screen</p>
      <p className="mt-1 max-w-xs text-xs text-slate-500 dark:text-slate-400">
        Scan a part — where it is, its stock and its history appear here.
      </p>
    </section>
  );
}
