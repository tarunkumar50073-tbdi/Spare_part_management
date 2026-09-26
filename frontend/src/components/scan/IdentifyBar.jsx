import React, { useEffect, useRef, useState } from "react";
import { Keyboard, LoaderCircle, ScanLine, Search } from "lucide-react";
import ScanPanel from "../ScanPanel.jsx";
import PartSearch from "./PartSearch.jsx";

// The workstation's input bar (spec 4): three ways to name a part.
//   Scan Barcode / QR — the gun or the tablet camera (the usual way in);
//   Search Part No.   — type-ahead over the store's parts;
//   Manual Entry      — type a Part No. or a supplier code exactly as printed.
// Every way ends in the same resolve on the server (audited, store-scoped), so
// a part is identified the same however it was named.
const INPUT_TABS = [
  { key: "SCAN", label: "Scan Barcode / QR", short: "Scan", icon: ScanLine },
  { key: "SEARCH", label: "Search Part No.", short: "Search", icon: Search },
  { key: "MANUAL", label: "Manual Entry", short: "Manual", icon: Keyboard },
];

function ManualEntry({ onSubmit, busy }) {
  const [code, setCode] = useState("");
  const inputRef = useRef(null);
  useEffect(() => {
    const id = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, []);
  // Cleared once the part is identified; kept when the operator chose to stay
  // on an open form or the code did not identify a part (onSubmit resolves
  // false), so a mistyped code can be corrected rather than typed again.
  const submit = async (e) => {
    e.preventDefault();
    const c = code.trim();
    if (!c || busy) return;
    if ((await onSubmit(c)) !== false) setCode("");
  };
  return (
    <form onSubmit={submit}>
      <label htmlFor="scan-manual-code" className="text-sm text-slate-600 dark:text-slate-300">
        Part No. or supplier barcode
      </label>
      <div className="mt-1 flex gap-2">
        <input
          id="scan-manual-code"
          ref={inputRef}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          placeholder="e.g. SP-10254"
          className="input-field h-12 flex-1 font-mono text-base tracking-wide"
        />
        <button type="submit" disabled={busy || !code.trim()} className="btn-primary h-12 px-5">
          {busy ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <Search size={16} aria-hidden="true" />}
          Identify
        </button>
      </div>
      <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
        Type it exactly as printed on the label — use this when a label won&apos;t scan.
      </p>
    </form>
  );
}

/**
 * tab / onTab   the active input (the parent owns it: "Search Part No." on an
 *               unknown-barcode panel switches here, and the workstation
 *               switches back to Scan once a part is identified or a form /
 *               dialog closes — only this tab mounts the gun field)
 * onScan(code, scanSource)   gun / camera read
 * onPick(stockRow)           a part chosen in Search
 * onManual(code)             a code typed in Manual Entry
 * focusSignal                bumped by the workstation when a form or dialog
 *                            closes, so the gun field is ready for the next scan
 * compact                    a part is on screen — the scan box drops its how-to
 *                            text so the part and its actions fit on screen
 * narrow                     the bar sits in a side column (Receive & Label):
 *                            the tabs keep their short names at every width
 */
export default function IdentifyBar({
  tab, onTab, onScan, onPick, onManual, busy, storeCode, focusSignal, compact = false, narrow = false,
}) {
  return (
    <section className="rounded-xl2 border border-slate-200 bg-white dark:border-navy-800 dark:bg-navy-900" aria-label="Identify a part">
      <div role="tablist" aria-label="How to identify the part" className="grid grid-cols-3 gap-1 border-b border-slate-100 p-1.5 dark:border-navy-800">
        {INPUT_TABS.map((t) => {
          const on = tab === t.key;
          return (
            <button key={t.key} type="button" role="tab" aria-selected={on} id={`scan-tab-${t.key}`}
              aria-controls="scan-tabpanel" onClick={() => onTab(t.key)} disabled={busy && !on}
              className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50 ${on
                ? "bg-toyotared text-white shadow-sm"
                : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-navy-800"}`}>
              <t.icon size={16} aria-hidden="true" />
              {narrow ? (
                <span title={t.label}>{t.short}</span>
              ) : (
                <>
                  <span className="hidden sm:inline">{t.label}</span>
                  <span className="sm:hidden">{t.short}</span>
                </>
              )}
            </button>
          );
        })}
      </div>
      <div id="scan-tabpanel" role="tabpanel" aria-labelledby={`scan-tab-${tab}`} className={compact ? "p-3" : "p-4"}>
        {tab === "SCAN" && (
          <ScanPanel variant="bare" compact={compact} onCode={onScan} busy={busy}
            hint={compact ? "Scan the next part…" : "Waiting for scan…"} focusSignal={focusSignal} />
        )}
        {tab === "SEARCH" && (
          <PartSearch storeCode={storeCode} onPick={onPick} busy={busy}
            label="Search Part No." placeholder="Part No., description or rack location…" />
        )}
        {tab === "MANUAL" && <ManualEntry onSubmit={onManual} busy={busy} />}
      </div>
    </section>
  );
}
