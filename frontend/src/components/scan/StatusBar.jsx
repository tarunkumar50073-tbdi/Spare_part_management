import React, { memo, useEffect, useState } from "react";
import { UserRound, Wifi, WifiOff } from "lucide-react";
import { SCAN_MODE } from "../../lib/scanStatus.js";
import { scanIcon } from "./scanIcons.js";

// The workstation's top strip: screen + store, the mode switch, network state,
// operator, clock.
//
// The clock ticks every second and the network chip listens to the browser, so
// each keeps its OWN state here — a tick re-renders the few characters of the
// clock, never the Scan Part page or a half-filled action form beneath it.

// Issue | Put-away Check — what the page does with a scan (lib/scanStatus
// SCAN_MODE). `modes` are the ones this user may use. The page owns the mode;
// `modes` and `onMode` must be stable (this strip is memoised). With the lot
// tags gone (17 Oct 2026) a user without the Store Stock right has Issue only,
// and a switch with one button is left out.
function ModeSwitch({ mode, modes, onMode }) {
  return (
    <div role="group" aria-label="Scan mode — what a scan opens"
      className="inline-flex rounded-lg bg-slate-100 p-0.5 dark:bg-navy-800">
      {modes.map((key) => {
        const m = SCAN_MODE[key];
        const on = mode === key;
        const Icon = scanIcon(m.icon);
        return (
          <button key={key} type="button" aria-pressed={on} onClick={() => { if (!on) onMode(key); }}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${on
              ? "bg-toyotared text-white shadow-sm"
              : "text-slate-600 hover:bg-white hover:text-slate-800 dark:text-slate-300 dark:hover:bg-navy-700 dark:hover:text-white"}`}>
            <Icon size={14} aria-hidden="true" />{m.label}
          </button>
        );
      })}
    </div>
  );
}

function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const date = now.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  const time = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return (
    <time dateTime={now.toISOString()} className="tabular text-slate-600 dark:text-slate-300">
      {date} <span className="font-semibold text-slate-800 dark:text-white">{time}</span>
    </time>
  );
}

// navigator.onLine only knows whether the device has a network link — it says
// nothing about the server — so the chip says "Network", not "Server".
function NetworkChip() {
  const [online, setOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  const Icon = online ? Wifi : WifiOff;
  return (
    <span role="status"
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${online
        ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
        : "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"}`}>
      <span className={`h-2 w-2 rounded-full ${online ? "bg-emerald-500" : "bg-rose-500 animate-pulse"}`} aria-hidden="true" />
      <Icon size={13} aria-hidden="true" />
      {online ? "Network online" : "Network offline"}
    </span>
  );
}

function StatusBar({ storeName, operator, mode, modes, onMode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl2 border border-slate-200 bg-white px-4 py-2 text-sm dark:border-navy-800 dark:bg-navy-900">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="h-5 w-1 shrink-0 rounded-full bg-toyotared" aria-hidden="true" />
        <h1 className="font-bold text-slate-800 dark:text-white">Scan Part</h1>
        {/* The store's own name, not its internal code ("MAINTENANCE"). */}
        <span className="truncate rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-navy-800 dark:text-slate-300">
          {storeName || "Spare Parts Store"}
        </span>
        {onMode && modes?.length > 1 && <ModeSwitch mode={mode} modes={modes} onMode={onMode} />}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <NetworkChip />
        <span className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
          <UserRound size={14} className="text-slate-400" aria-hidden="true" />
          <span className="sr-only">Operator:</span>{operator || "—"}
        </span>
        <LiveClock />
      </div>
    </div>
  );
}

export default memo(StatusBar);
