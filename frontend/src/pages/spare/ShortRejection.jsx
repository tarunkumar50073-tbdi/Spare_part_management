import React, { useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarClock, CalendarRange, Database, FileDown, FileText, Inbox, IndianRupee, Info, PackageMinus,
  PackageSearch, PackageX, Search, TriangleAlert, Truck, Undo2, Unplug, X,
} from "lucide-react";
import CardHead from "../../components/CardHead.jsx";
import ErrorState from "../../components/ErrorState.jsx";
import KpiCard from "../../components/KpiCard.jsx";
import { useStores } from "../../context/StoreContext.jsx";
import { usePartDrawer } from "../../context/PartDrawerContext.jsx";
import { useCan } from "../../components/Can.jsx";
import { NO_ROWS } from "../../lib/stockQueries.js";
import { compactMoney, money, num } from "../../lib/format.js";
import { shortRejectionService } from "../../services/shortRejectionService.js";
import ShortMailDialog from "../../components/spare/ShortMailDialog.jsx";
import RejectionMailDialog from "../../components/spare/RejectionMailDialog.jsx";

// Short & Rejection — what suppliers sent short, and what was rejected, on this
// store's ERP GRN lines, supplier-wise and line by line, with the days each has
// been pending. The store asked for it on 17 Oct 2026: "rejection ka bhi banana
// padega taaki pta chale kis supplier ki rejection padi h kitne dino se and kis
// lot k against me reject hui — ye erp api se mil jaayega".
//
// Never mixed. On hearing the plan he asked "rejection and short mix nhi rhega
// na": two tabs, Short and Rejection, each with its own tiles, supplier table,
// lines, totals and download — the server answers ONE kind per call. Rejection
// is punched in ERP in two types ("rejection me drop down se srv rejection,
// line rejection"), chosen by the Type dropdown and never mixed either. Line
// Rejection is not readable yet, and the screen says so instead of a list.
//
// As simple as the Issuance & Consumption Report (ReportScreen.jsx): a title,
// the tabs, ONE filter bar of named boxes with the downloads at its end.

const TABS = [
  { key: "short", label: "Short", icon: PackageMinus },
  { key: "rejection", label: "Rejection", icon: PackageX },
  // ERP's line rejection return slips (read with every ERP read, 27 Oct 2026).
  { key: "line", label: "Line rejection", icon: Undo2 },
];
const TYPES = [
  { key: "srv", label: "SRV Rejection" },
  { key: "line", label: "Line Rejection" },
];
// Each kind's words. The figures of one kind never sit beside another's.
const KIND = {
  short: {
    label: "Short", noun: "short", qty: "Short qty", value: "Short value", tone: "amber", icon: PackageMinus,
    suppliers: "with a short",
    nothing: "Nothing short in this period", none: "Nothing short", explain: "was received short",
    closedDays: "Closed — days from the GRN date to the settlement",
  },
  srv: {
    label: "SRV Rejection", noun: "SRV rejection", qty: "Rejected qty", value: "Rejected value", tone: "red", icon: PackageX,
    suppliers: "with an SRV rejection",
    nothing: "No SRV rejection in this period", none: "No SRV rejection", explain: "had a rejection on its SRV",
    closedDays: "Closed — days from the GRN date to the rejection invoice",
  },
  line: {
    label: "Line Rejection", noun: "line rejection", qty: "Rejected qty", value: "Rejected value", tone: "red", icon: PackageX,
    suppliers: "with a line rejection",
    nothing: "No line rejection in this period", none: "No line rejection", explain: "had a line rejection",
    closedDays: "Closed — days from the GRN date to the rejection invoice",
  },
};

// The Period dropdown: the server cuts each on the plant clock
// (ShortRejectionService.PERIODS); Custom takes From - To.
const PERIODS = [
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "this_fy", label: "This financial year" },
  { key: "last_fy", label: "Last financial year" },
  { key: "custom", label: "Custom" },
];
const DEFAULT_PERIOD = "90d";

// Days pending, in the server's bands (AGE_BANDS), coloured green → red.
const AGE = {
  "0-7": { label: "0–7 days", cls: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-400/30" },
  "8-15": { label: "8–15 days", cls: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-400/30" },
  "16-30": { label: "16–30 days", cls: "bg-orange-50 text-orange-700 ring-orange-600/25 dark:bg-orange-500/15 dark:text-orange-300 dark:ring-orange-400/30" },
  "30+": { label: "Over 30 days", cls: "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-400/30" },
};
const bandOf = (days) => (days == null ? null : days <= 7 ? "0-7" : days <= 15 ? "8-15" : days <= 30 ? "16-30" : "30+");

// Rows drawn at first; the totals and the files always cover every line.
const FIRST_ROWS = 200;

const FILES = [
  { key: "excel", label: "Excel", ext: "xlsx", icon: FileDown },
  { key: "pdf", label: "PDF", ext: "pdf", icon: FileText },
];

// A local-calendar YYYY-MM-DD — toISOString() would hand back yesterday for
// the first 5.5 hours of every plant day.
const isoDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// "28 Sep" — the browser's en-GB short month reads "Sept", which the store does not write.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayMonth = (s) => `${Number(s.slice(8, 10))} ${MONTHS[Number(s.slice(5, 7)) - 1]}`;
// "28 Sep 2026". Plant days are dates, not instants: read from the text, so
// they never drift a day in either direction.
const day = (s) => (s ? `${s.slice(8, 10)} ${MONTHS[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}` : "—");

// The server's file name for a title (reorder_mail_service._file_safe).
const fileSafe = (name) => [...String(name || "")]
  .map((c) => (c < " " || '\\/:*?"<>|'.includes(c) ? " " : c))
  .join("")
  .split(/\s+/)
  .filter(Boolean)
  .join(" ");

const plural = (n, word) => `${num(n)} ${word}${n === 1 ? "" : "s"}`;

// A run of plant days as the screen writes it: one day, or "a to b".
const span = (r) => (r.from === r.to ? day(r.from) : `${day(r.from)} to ${day(r.to)}`);

// A value: "No rate" when the part has none — blank, never ₹0 for unknown.
function Value({ value, strong }) {
  if (value == null) return <span className="text-[11px] text-slate-400" title="The part has no rate, so this is not valued">No rate</span>;
  return <span className={strong ? "font-semibold" : ""}>{money(value)}</span>;
}

// Days pending as a coloured chip. A line takes the server's band (age_band):
// a closed line has none — its days, GRN to closing, are no longer pending, so
// they are shown in neutral slate, as the files leave its Age cell unfilled
// and the band counts leave it out. A supplier or the total gives the oldest
// OPEN line's days, banded here.
function AgeChip({ days, band = bandOf(days), closedTitle = null }) {
  if (days == null) return <span className="text-slate-400">—</span>;
  if (!band) {
    return (
      <span title={closedTitle || undefined}
        className="inline-flex items-center whitespace-nowrap rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold tabular text-slate-500 ring-1 ring-inset ring-slate-400/25 dark:bg-navy-800 dark:text-slate-400 dark:ring-slate-500/30">
        {num(days)} d
      </span>
    );
  }
  return (
    <span title={`${AGE[band].label} pending`}
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold tabular ring-1 ring-inset ${AGE[band].cls}`}>
      {num(days)} d
    </span>
  );
}

// The server's status in two parts: "Open" / "Closed" as a chip, the rest
// ("rejection invoice not yet made", "invoice RI/26/0042 (07.10.2026)") under it.
function Status({ line }) {
  const closed = line.status === "closed";
  const [head, ...rest] = String(line.status_text || "").split(" — ");
  return (
    <span className="block">
      <span className={`inline-block rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${closed
        ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
        : "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300"}`}>
        {head}
      </span>
      {rest.length > 0 && <span className="mt-0.5 block text-[11px] leading-snug text-slate-500 dark:text-slate-400">{rest.join(" — ")}</span>}
    </span>
  );
}

export default function ShortRejection() {
  const canRejections = useCan("rejection_request", "view");
  const canShortMail = useCan("short_mail", "view");
  const canMakeShortMail = useCan("short_mail", "create");
  const canShortMailTo = useCan("short_mail", "update");
  const [shortMail, setShortMail] = useState(false);
  const [rejectionMail, setRejectionMail] = useState(false);
  const { activeCode, activeStore } = useStores();
  const { openPart } = usePartDrawer();
  const code = activeCode;

  // Every choice lives in the URL, so a view can be sent to someone. A change
  // replaces the history entry (typing would otherwise leave one per pause),
  // so Back leaves the screen rather than undoing a filter.
  const location = useLocation();
  const [urlParams, setUrlParams] = useSearchParams();
  // The router writes the URL in a transition, and until it lands React puts
  // the old choice back in a dropdown: an arrow-key press on Period or Type
  // then starts from the old option, and a quick second change (Period, then
  // the Rejection tab) would be built on the old URL and drop the first. So
  // the last pick is held here and read at once, as ReportScreen.jsx does; a
  // new URL — the pick landing, or a link followed here — takes over from it.
  const [picked, setPicked] = useState(null);
  const urlKey = `${location.pathname}?${urlParams.toString()}`;
  const [seenUrl, setSeenUrl] = useState(urlKey);
  if (urlKey !== seenUrl) {
    setSeenUrl(urlKey);
    setPicked(null);
  }
  const params = picked ?? urlParams;
  const tab = TABS.some((t) => t.key === params.get("tab")) ? params.get("tab") : "short";
  const type = TYPES.some((t) => t.key === params.get("type")) ? params.get("type") : "srv";
  const kind = tab === "short" ? "short" : type;
  const period = PERIODS.some((p) => p.key === params.get("period")) ? params.get("period") : DEFAULT_PERIOD;
  const custom = period === "custom";
  const from = custom ? params.get("from") || "" : "";
  const to = custom ? params.get("to") || "" : "";
  const supplier = params.get("supplier") || "";
  const part = params.get("part") || "";
  const badRange = Boolean(from && to && from > to);

  const update = (changes) => {
    const next = new URLSearchParams(params);
    Object.entries(changes).forEach(([k, v]) => { if (v) next.set(k, v); else next.delete(k); });
    setPicked(next);
    setUrlParams(next, { replace: true });
  };

  const query = {
    store_code: code,
    kind,
    period,
    from: from || undefined,
    to: to || undefined,
    supplier: supplier || undefined,
    part: part || undefined,
  };
  // The server cuts the period on the day it is asked: today's date in the key
  // asks again once the day turns, for a screen kept open across midnight.
  const today = isoDay(new Date());
  const q = useQuery({
    queryKey: ["short-rejection", code, kind, period, from, to, supplier, part, today],
    // Silent: the page shows its own error and Retry (api.js).
    queryFn: () => shortRejectionService.get(query, { silent: true }).then((r) => r.data.data),
    enabled: Boolean(code) && !badRange,
    // The same kind's figures stay up while a new period loads; another
    // kind's never stand in for this one's.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === code && prevQuery?.queryKey[2] === kind ? prev : undefined),
  });
  const d = q.data;
  const stale = q.isPlaceholderData;
  // Custom starts from the window already on screen, not from blank boxes.
  const choosePeriod = (key) => update(key === "custom"
    ? { period: "custom", from: d?.window?.from || "", to: d?.window?.to || "" }
    : { period: key, from: "", to: "" });

  if (!code) {
    return (
      <div className="card text-sm text-slate-500 dark:text-slate-400">
        No store is selected — choose the Spare Parts Store from the sidebar.
      </div>
    );
  }

  const words = KIND[kind];
  const unreadable = Boolean(d) && d.available === false;
  const empty = Boolean(d) && !unreadable && d.lines.length === 0;
  const filtered = Boolean(supplier || part);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-72">
          <h2 className="text-lg font-bold text-slate-800 dark:text-white">Short &amp; Rejection</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            What suppliers sent short, and what was rejected, on {activeStore?.name || "this store"}&apos;s ERP GRN
            lines — supplier-wise and line by line, with the days each has been pending.
          </p>
        </div>
        <span className="flex items-center gap-2">
          {q.isFetching && d && <span className="text-[11px] text-slate-400">Updating…</span>}
          {/* The mail to RQC to punch a rejection — on the Rejection tab only
              (25 Oct 2026: "short me bhi rejection mail dikha rha h"); opens
              here, no screen of its own (28 Oct 2026). */}
          {canRejections && tab === "rejection" && (
            <button type="button" className="btn-secondary text-[12.5px]" onClick={() => setRejectionMail(true)}>Rejection mail →</button>
          )}
          {/* The mail to Purchase for material received short — on the Short
              tab only, apart from the Rejection Mail (25 Oct 2026). */}
          {canShortMail && tab === "short" && (
            <button type="button" className="btn-secondary text-[12.5px]" onClick={() => setShortMail(true)}>Short mail →</button>
          )}
        </span>
      </div>

      <div role="tablist" aria-label="Short or rejection"
        className="grid w-full grid-cols-3 gap-1 rounded-xl border border-slate-200 bg-white p-1 dark:border-navy-800 dark:bg-navy-900 sm:inline-grid sm:w-auto">
        {TABS.map((t) => {
          const on = tab === t.key;
          return (
            <button key={t.key} type="button" role="tab" aria-selected={on} id={`sr-tab-${t.key}`}
              aria-controls="sr-panel"
              onClick={() => update({ tab: t.key === "short" ? "" : t.key })}
              className={`inline-flex items-center justify-center gap-2 rounded-lg px-5 py-2 text-sm font-semibold transition-colors ${on
                ? "bg-toyotared text-white shadow-sm"
                : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-navy-800"}`}>
              <t.icon size={15} aria-hidden="true" />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "line" && <LineRejections storeCode={code} />}
      <div id="sr-panel" role="tabpanel" aria-labelledby={`sr-tab-${tab}`} className={`space-y-5 ${tab === "line" ? "hidden" : ""}`}>
        {/* No note on how days are counted for a kind that has no list at all. */}
        <ErpBanner asOf={d?.data_as_of} kind={kind} basis={unreadable ? null : d?.basis} closuresKnown={d?.closures_known}
          gap={d?.window?.not_held} notGiven={d?.not_given || NO_ROWS} />

        <FilterBar
          tab={tab} type={type} period={period} from={from} to={to} badRange={badRange}
          supplier={supplier} part={part} shown={stale ? null : d?.window}
          onPeriod={choosePeriod}
          onDates={(f, t) => update({ period: "custom", from: f, to: t })}
          onChange={update}
          downloads={<Downloads d={d} query={query} off={!d || stale || empty || unreadable}
            why={unreadable ? "Nothing to download — line rejections are not read from ERP yet"
              : empty ? `Nothing to download — ${lowerFirst(nothingSaid(d.window, words))}` : null}
            label={words.label} />}
        />

        {badRange ? (
          <div className="card text-sm text-slate-500 dark:text-slate-400">
            The From date is after the To date — pick a period that runs forwards.
          </div>
        ) : q.isError && !d ? (
          <div className="card">
            <ErrorState
              title={`Could not load the ${words.noun} list`}
              message={q.error?.response?.data?.message || "The list did not load."}
              onRetry={() => q.refetch()}
            />
          </div>
        ) : !d ? (
          <Loading />
        ) : unreadable ? (
          <LineRejectionUnavailable table={d.erp_table} asOf={d.data_as_of} />
        ) : (
          <div className={`space-y-5 transition-opacity ${stale ? "opacity-60" : ""}`} aria-busy={stale || undefined}>
            {/* No 0 tiles for a period of which nothing is known — before the
                oldest GRN held, or after the last ERP refresh: 0 would read as
                "nothing short / rejected". */}
            {!(empty && d.window?.known === null) && <Tiles totals={d.totals} words={words} />}
            <UnmatchedNote unmatched={d.unmatched} words={words} />
            {empty ? (
              <EmptyState window={d.window} asOf={d.data_as_of} filtered={filtered} words={words}
                period={period} onPeriod={choosePeriod} />
            ) : (
              <>
                <SupplierTable
                  summary={d.summary} totals={d.totals} selected={supplier} words={words}
                  onPick={(s) => {
                    const key = s.supplier_code || s.supplier_name || "";
                    update({ supplier: supplier.toLowerCase() === key.toLowerCase() ? "" : key });
                  }}
                />
                <LinesTable key={kind} lines={d.lines} totals={d.totals} words={words} onPart={openPart} />
              </>
            )}
          </div>
        )}
      </div>

      {shortMail && (
        <ShortMailDialog lines={tab === "short" && d && !stale && !unreadable ? d.lines : []} storeCode={code}
          canMake={canMakeShortMail} canSettings={canShortMailTo} onClose={() => setShortMail(false)} />
      )}
      {rejectionMail && <RejectionMailDialog storeCode={code} onClose={() => setRejectionMail(false)} />}
    </div>
  );
}

// ------------------------------------------------------------------ banner

// How current the ERP data is (amber once its last refresh is more than two
// days old), where it starts — the ERP sync keeps only its last N days, so an
// open line on an older GRN is not listed (amber when the period reaches back
// before it) — how the days are counted, and what ERP does not give yet.
function ErpBanner({ asOf, kind, basis, closuresKnown, gap, notGiven }) {
  if (!asOf) return null;
  const stale = asOf.stale;
  const staleBox = stale || Boolean(gap);
  return (
    <div className={`rounded-xl border px-3.5 py-2.5 text-xs leading-relaxed ${staleBox
      ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
      : "border-slate-200 bg-white text-slate-600 dark:border-navy-800 dark:bg-navy-900 dark:text-slate-300"}`}>
      <p className="flex items-start gap-2 font-medium">
        {stale
          ? <TriangleAlert size={14} className="mt-px shrink-0" aria-hidden="true" />
          : <Database size={14} className="mt-px shrink-0 text-slate-400" aria-hidden="true" />}
        <span>
          {asOf.synced_day ? (
            <>
              ERP data up to {day(asOf.synced_day)}
              {stale && asOf.age_days != null && ` — ${plural(asOf.age_days, "day")} old. GRNs, shorts and rejections booked in ERP since then are not here until the ERP sync runs again.`}
            </>
          ) : "No ERP GRN data has been read yet — the list fills on the first ERP sync."}
        </span>
      </p>
      {asOf.held_from && kind !== "line" && (
        <p className={`mt-1 flex items-start gap-2 ${gap ? "" : "text-slate-500 dark:text-slate-400"}`}>
          <CalendarRange size={14} className="mt-px shrink-0 opacity-70" aria-hidden="true" />
          <span>
            GRN lines are held from {day(asOf.held_from)}
            {asOf.keeps_days ? ` (the ERP sync keeps the last ${num(asOf.keeps_days)} days)` : ""}: an open{" "}
            {KIND[kind].noun} on an older GRN is not listed.
            {gap && (
              <b className="font-semibold"> No GRN line is held for {span(gap)} — nothing can show for those dates.</b>
            )}
          </span>
        </p>
      )}
      {basis && (
        <p className={`mt-1 flex items-start gap-2 ${staleBox ? "" : "text-slate-500 dark:text-slate-400"}`}>
          <Info size={14} className="mt-px shrink-0 opacity-70" aria-hidden="true" />
          <span>
            {basis.days} {closuresKnown ? basis.closed : basis.no_closure}
            {notGiven.length > 0 && (
              <> Not given by ERP yet: <b className="font-semibold">{notGiven.join(", ")}</b> — shown blank until ERP carries them.</>
            )}
          </span>
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ filters

// A control with its name above it, as on the Issuance & Consumption Report.
// A <label> wraps a lone box, so a click on the name lands in it; a search box
// holds a clear button of its own and is named with a caption instead.
function Field({ label, as: Tag = "label", className = "", children }) {
  return (
    <Tag className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{label}</span>
      {children}
    </Tag>
  );
}

const select = "input-field py-1.5 text-[13px] font-medium text-slate-800 dark:text-white sm:w-auto sm:min-w-[9rem] sm:max-w-[14rem]";

// A search box that types freely; the list follows a moment after typing stops.
function SearchBox({ value, onChange, placeholder, label, icon: Icon }) {
  const [text, setText] = useState(value);
  // The newest onChange, read when the pause ends: the one of the render that
  // started the timer would build on the filters of that moment and drop a
  // Period or Type picked while typing.
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });
  // Follow the URL only when it says something else (a supplier clicked,
  // filters cleared): the debounce sends the text trimmed, and copying that
  // back would eat the space just typed between two words.
  useEffect(() => { setText((t) => (t.trim() === value ? t : value)); }, [value]);
  useEffect(() => {
    if (text.trim() === value) return undefined;
    const t = setTimeout(() => onChangeRef.current(text.trim()), 400);
    return () => clearTimeout(t);
  }, [text, value]);
  return (
    <span className="relative block">
      <Icon size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label={label}
        className={`input-field w-full py-1.5 pl-7 text-[13px] sm:w-48 ${text ? "pr-7" : ""}`} />
      {text && (
        <button type="button" onClick={() => { setText(""); onChange(""); }} aria-label={`Clear: ${label}`}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-toyotared">
          <X size={13} />
        </button>
      )}
    </span>
  );
}

// On a phone each box takes a whole row — beside the icon rail half a row cut
// "Last 90 days", "SRV Rejection" and a date short; from sm: up one row that
// wraps, the downloads at its end.
function FilterBar({ tab, type, period, from, to, badRange, supplier, part, shown, onPeriod, onDates, onChange, downloads }) {
  const custom = period === "custom";
  const date = `input-field py-1.5 text-[13px] min-w-0 sm:w-auto ${badRange ? "border-toyotared" : ""}`;
  return (
    <div className="card grid grid-cols-2 gap-x-2 gap-y-3 sm:flex sm:flex-wrap sm:items-end">
      <Field label="Period" className="col-span-2">
        <select className={select} value={period} onChange={(e) => onPeriod(e.target.value)}>
          {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </Field>
      {custom && (
        <>
          <Field label="From" className="col-span-2">
            <input type="date" value={from} max={to || undefined} onChange={(e) => onDates(e.target.value, to)} className={date} />
          </Field>
          <Field label="To" className="col-span-2">
            <input type="date" value={to} min={from || undefined} onChange={(e) => onDates(from, e.target.value)} className={date} />
          </Field>
        </>
      )}
      {tab === "rejection" && (
        <Field label="Type" className="col-span-2">
          <select className={select} value={type} onChange={(e) => onChange({ type: e.target.value === "srv" ? "" : e.target.value })}>
            {TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </Field>
      )}
      <Field label="Supplier" as="div" className="col-span-2">
        <SearchBox value={supplier} onChange={(v) => onChange({ supplier: v })} placeholder="Name or code"
          label="Filter by supplier" icon={Truck} />
      </Field>
      <Field label="Part no." as="div" className="col-span-2">
        <SearchBox value={part} onChange={(v) => onChange({ part: v })} placeholder="Part no. or name"
          label="Filter by part number or description" icon={Search} />
      </Field>
      <div className="col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 sm:ml-auto">
        {/* The window the figures cover, as the server cut it. */}
        {shown && (
          <span className="text-[11px] text-slate-400">
            GRN date <span className="font-medium text-slate-600 dark:text-slate-300">{span(shown)}</span>
          </span>
        )}
        {(supplier || part) && (
          <button type="button" onClick={() => onChange({ supplier: "", part: "" })}
            className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-toyotared">
            <X size={13} aria-hidden="true" /> Clear filters
          </button>
        )}
        <span className="flex items-center gap-1.5">{downloads}</span>
      </div>
    </div>
  );
}

// The shown tab's file only: its own supplier-wise sheet and lines, named as
// the server names it ("Short <dates>", "SRV Rejection <dates>").
function Downloads({ d, query, off, why, label }) {
  const [busy, setBusy] = useState(null);
  const download = (file) => {
    setBusy(file.key);
    shortRejectionService.exportFile(query, file.key, `${fileSafe(d.title)}.${file.ext}`)
      // A failure is already on screen as the API client's toast.
      .catch(() => {})
      .finally(() => setBusy(null));
  };
  return FILES.map((file) => (
    <button key={file.key} type="button" onClick={() => download(file)} disabled={off || busy != null}
      title={why || `Download the ${label} supplier-wise list and lines as ${file.label}`}
      className="btn-secondary inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50">
      <file.icon size={14} aria-hidden="true" />
      {busy === file.key ? "Preparing…" : file.label}
    </button>
  ));
}

// ------------------------------------------------------------------ figures

function Tiles({ totals: t, words }) {
  const oldBand = bandOf(t.oldest_days);
  const any = t.lines > 0;
  // One tile a row on a phone: beside the app's icon rail two would cut
  // their labels to a few letters.
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <KpiCard featured tone={any ? words.tone : "navy"} label={words.qty} icon={words.icon}
        value={num(t.qty)} hint={plural(t.lines, "GRN line")} />
      <KpiCard featured tone={any ? words.tone : "navy"} label={words.value} icon={IndianRupee}
        value={any && t.value == null ? "No rate" : compactMoney(t.value || 0)}
        valueTitle={t.value != null ? money(t.value) : undefined}
        hint={t.unrated_lines ? `${plural(t.unrated_lines, "line")} without a rate — not valued` : "at each part's current rate"} />
      <KpiCard featured tone={t.suppliers ? "blue" : "navy"} label="Suppliers" icon={Truck}
        value={t.suppliers} hint={words.suppliers} />
      <KpiCard featured tone={oldBand === "30+" ? "red" : oldBand && oldBand !== "0-7" ? "amber" : "navy"}
        label="Oldest" icon={CalendarClock}
        value={t.oldest_days ?? "—"} unit={t.oldest_days != null ? "days" : undefined}
        hint="pending since the GRN date" />
    </div>
  );
}

// Lines of this kind whose item code is no store's Part No: no store lists
// them, so they are counted here rather than vanish.
function UnmatchedNote({ unmatched: u, words }) {
  if (!u?.lines) return null;
  const one = u.lines === 1;
  const rest = u.item_count - u.items.length;
  return (
    <details className="rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-xs text-slate-600 dark:border-navy-800 dark:bg-navy-900 dark:text-slate-300">
      <summary className="cursor-pointer select-none">
        <PackageSearch size={14} className="-mt-0.5 mr-1.5 inline text-slate-400" aria-hidden="true" />
        <b className="font-semibold">{num(u.lines)}</b> {words.noun} ERP GRN {one ? "line" : "lines"} in this
        period {one ? "is" : "are"} for item codes that are no store&apos;s Part No, so no store lists {one ? "it" : "them"}.{" "}
        <span className="font-medium text-toyotared">Show the codes</span>
      </summary>
      <ul className="mt-2 space-y-1 pl-5">
        {u.items.map((i) => (
          <li key={i.item_cd || "none"} className="list-disc">
            <b className="font-semibold">{i.item_cd || "(no code)"}</b>
            {i.item_desc ? <span className="text-slate-500 dark:text-slate-400"> · {i.item_desc}</span> : null}
            <span className="text-slate-400"> · {plural(i.lines, "line")}</span>
          </li>
        ))}
        {rest > 0 && <li className="list-none text-slate-400">and {plural(rest, "more item code")}</li>}
      </ul>
      <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
        If one is this store&apos;s part, add it to the part master with that Part No and its lines show here.
      </p>
    </details>
  );
}

// "from A to B", or "on A" for one day.
const within = (r) => (r.from === r.to ? `on ${day(r.from)}` : `from ${day(r.from)} to ${day(r.to)}`);

// The dates of the period the ERP data covers: the server's window.known (a
// server from before it gave none — the whole period); null when none is.
const knownOf = (w) => (w.known === undefined ? { from: w.from, to: w.to } : w.known);

// What an empty period says — "nothing" only for the dates the ERP data
// covers. Before the oldest GRN held, or after the last ERP refresh (on the
// live data, synced 28 Sep 2026, every day of October) nothing is known, which
// is not "nothing short" / "no rejection". The empty state's heading and the
// disabled downloads' title say the same.
function nothingSaid(w, words) {
  const known = knownOf(w);
  if (!known) return "No GRN line is held for these dates";
  return known.from === w.from && known.to === w.to ? words.nothing : `${words.none} ${within(known)}`;
}
// "No SRV rejection …" inside a sentence: only the first letter lowered, so "SRV" stays.
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

function EmptyState({ window: w, asOf, filtered, words, period, onPeriod }) {
  const known = knownOf(w);
  const until = asOf?.data_until || asOf?.synced_day;
  const heldFrom = asOf?.held_from;
  return (
    <div className="card">
      <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-4 py-8 text-center dark:border-navy-700 dark:bg-navy-800/40">
        <Inbox size={26} strokeWidth={1.6} className="mx-auto mb-2 text-slate-300 dark:text-slate-600" aria-hidden="true" />
        <p className="text-sm font-medium text-slate-600 dark:text-slate-300">
          {nothingSaid(w, words)}
        </p>
        <p className="mt-1 text-[11px] text-slate-400">
          {!known ? (
            !until ? <>No ERP GRN data has been read yet, so nothing can show for {span(w)}.</>
              : w.not_held ? <>GRN lines are held from {day(heldFrom)}, so nothing can show for {span(w)}.</>
                : <>ERP data ends {day(until)}, so nothing is known for {span(w)}: a GRN booked in ERP since then is not here until the ERP sync runs again.</>
          ) : (
            <>
              No GRN line dated {span(known)}{filtered ? " under these filters" : ""} {words.explain}.
              {w.not_held ? ` Nothing before ${day(heldFrom)} is held.` : ""}
              {w.not_synced && until ? ` ERP data ends ${day(until)} — nothing is known for ${span(w.not_synced)}.` : ""}
            </>
          )}
          {period !== "this_fy" && (
            <>
              {" "}
              <button type="button" onClick={() => onPeriod("this_fy")}
                className="font-semibold text-toyotared underline underline-offset-2 hover:no-underline">
                Look at this financial year
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

// Line Rejection: ERP holds them, the app cannot read them yet — said plainly,
// never filled with made-up rows. The store's sentence (17 Oct 2026) is for
// today, when no ERP data has come since 28 Sep; once the ERP sync is current
// again the reason left is that line_rejection_report is not read, so the
// screen says that instead of an "unreachable" the banner above contradicts.
function LineRejectionUnavailable({ table, asOf }) {
  const name = <code className="font-mono text-[11px]">{table || "line_rejection_report"}</code>;
  const unreachable = !asOf?.synced_day || asOf.stale;
  const since = asOf?.synced_day ? `no ERP data since ${dayMonth(asOf.synced_day)}` : "no ERP data has been read yet";
  return (
    <div className="card">
      <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-4 py-8 text-center dark:border-navy-700 dark:bg-navy-800/40">
        <Unplug size={26} strokeWidth={1.6} className="mx-auto mb-2 text-slate-400 dark:text-slate-500" aria-hidden="true" />
        <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Line rejections are not readable yet</p>
        <p className="mx-auto mt-1.5 max-w-xl text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          {unreachable ? (
            <>
              Line rejections are punched in ERP (table {name}). The app cannot reach the ERP database yet ({since}),
              so they will appear here once the ERP connection or API works.
            </>
          ) : (
            <>
              Line rejections are punched in ERP (table {name}). The app does not read that table yet, so they
              will appear here once it is read through the ERP connection or API.
            </>
          )}
        </p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ tables

// A table row that acts as a button, as components/Table.jsx makes every
// clickable row: reachable by Tab, worked by Enter or Space.
const rowButton = (act) => ({
  role: "button",
  tabIndex: 0,
  onClick: act,
  onKeyDown: (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      act();
    }
  },
});

const TH = "px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap bg-slate-50 dark:bg-navy-800";
// The lines table's headings may wrap ("Challan / qty"): sixteen columns beside
// the sidebar, and the qty, days and status the store reads first are at the end.
const LTH = "px-2.5 py-2 text-[11px] font-semibold uppercase leading-tight tracking-wide bg-slate-50 dark:bg-navy-800";

function SupplierTable({ summary, totals, selected, words, onPick }) {
  const isOn = (s) => Boolean(selected)
    && selected.toLowerCase() === (s.supplier_code || s.supplier_name || "").toLowerCase();
  return (
    <div className="card min-w-0">
      <CardHead icon={Truck} tone="blue" title={`${words.label} — supplier-wise`}
        hint={`${plural(summary.length, "supplier")} · the longest pending first · tap a supplier to see only its lines`} />

      {/* Phones: one card per supplier. */}
      <ul className="space-y-2 md:hidden">
        {summary.map((s) => (
          <li key={s.supplier_code || s.supplier_name}>
            <button type="button" onClick={() => onPick(s)} aria-pressed={isOn(s)}
              className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${isOn(s)
                ? "border-toyotared bg-rose-50/60 dark:bg-rose-500/10"
                : "border-slate-200 hover:border-slate-300 dark:border-navy-700"}`}>
              <span className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-slate-800 dark:text-white">
                    {s.supplier_name || s.supplier_code || "Supplier not given"}
                  </span>
                  <span className="block text-[11px] text-slate-400">
                    {s.supplier_code || "—"} · latest GRN {day(s.latest_grn_date)}
                  </span>
                </span>
                <AgeChip days={s.oldest_days} />
              </span>
              <span className="mt-1.5 block text-xs text-slate-600 dark:text-slate-300">
                {plural(s.lines, "line")} · {num(s.qty)} qty · <Value value={s.value} strong />
              </span>
            </button>
          </li>
        ))}
        <li className="flex flex-wrap items-center justify-between gap-x-2 rounded-xl bg-slate-100 px-3 py-2 text-xs font-bold text-slate-900 dark:bg-navy-800 dark:text-white">
          <span>Total · {plural(totals.suppliers, "supplier")}</span>
          <span className="tabular">
            {plural(totals.lines, "line")} · {num(totals.qty)} qty · <Value value={totals.value} />
          </span>
        </li>
      </ul>

      <div className="hidden overflow-x-auto rounded-xl border border-slate-200 dark:border-navy-800 md:block">
        <table className="min-w-full text-[13px]">
          <thead className="text-slate-600 dark:text-slate-300">
            <tr>
              <th scope="col" className={`${TH} text-left`}>Supplier</th>
              <th scope="col" className={`${TH} text-right`}>Lines</th>
              <th scope="col" className={`${TH} text-right`}>{words.qty}</th>
              <th scope="col" className={`${TH} text-right`}>{words.value}</th>
              <th scope="col" className={`${TH} text-left`}>Oldest (days)</th>
              <th scope="col" className={`${TH} text-left`}>Latest GRN</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-700 dark:divide-navy-800 dark:text-slate-200">
            {summary.map((s) => (
              <tr key={s.supplier_code || s.supplier_name} {...rowButton(() => onPick(s))}
                aria-pressed={isOn(s)}
                className={`cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-toyotared ${isOn(s) ? "bg-rose-50/70 dark:bg-rose-500/10" : "hover:bg-slate-50 dark:hover:bg-navy-800/60"}`}>
                <td className="max-w-[22rem] px-3 py-2">
                  <span className="block truncate font-medium text-slate-800 dark:text-white" title={s.supplier_name || undefined}>
                    {s.supplier_name || "Supplier not given"}
                  </span>
                  <span className="text-[11px] text-slate-400">{s.supplier_code || "—"}</span>
                </td>
                <td className="px-3 py-2 text-right tabular">{num(s.lines)}</td>
                <td className="px-3 py-2 text-right font-semibold tabular">{num(s.qty)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular"><Value value={s.value} strong /></td>
                <td className="px-3 py-2"><AgeChip days={s.oldest_days} /></td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-500 dark:text-slate-400">{day(s.latest_grn_date)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-slate-100 font-bold text-slate-900 dark:bg-navy-800 dark:text-white">
              <td className="px-3 py-2.5">Total · {plural(totals.suppliers, "supplier")}</td>
              <td className="px-3 py-2.5 text-right tabular">{num(totals.lines)}</td>
              <td className="px-3 py-2.5 text-right tabular">{num(totals.qty)}</td>
              <td className="whitespace-nowrap px-3 py-2.5 text-right tabular"><Value value={totals.value} /></td>
              <td className="px-3 py-2.5"><AgeChip days={totals.oldest_days} /></td>
              <td className="whitespace-nowrap px-3 py-2.5">{day(totals.latest_grn_date)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function LinesTable({ lines, totals, words, onPart }) {
  const [all, setAll] = useState(false);
  const drawn = all ? lines : lines.slice(0, FIRST_ROWS);
  const notGiven = <span className="text-[11px] text-slate-400" title="ERP's GRN register does not carry it yet">Not given</span>;
  // The lot a line came in with: its gate entry no. and date.
  const lot = (ln) => (ln.gate_entry_no
    ? <>{ln.gate_entry_no}{ln.gate_entry_dt ? <span className="block text-[11px] text-slate-400">{day(ln.gate_entry_dt)}</span> : null}</>
    : notGiven);
  const challan = (ln) => (ln.challan_no || ln.challan_dt
    ? <>{ln.challan_no || "—"}{ln.challan_dt ? <span className="block text-[11px] text-slate-400">{day(ln.challan_dt)}</span> : null}</>
    : "—");
  const heads = [["GRN Date", "left"], ["GRN No", "left"], ["Lot (gate entry)", "left"], ["Challan", "left"],
    ["PO No", "left"], ["Supplier", "left"], ["Part No", "left"], ["Description", "left"], ["Challan qty", "right"],
    ["Received", "right"], ["Accepted", "right"], [words.qty, "right"], ["Rate", "right"], [words.value, "right"],
    ["Days pending", "left"], ["Status", "left"]];
  const qtyTone = words.tone === "amber" ? "text-amber-700 dark:text-amber-300" : "text-rose-700 dark:text-rose-300";
  return (
    <div className="card min-w-0">
      <CardHead icon={words.icon} tone={words.tone === "amber" ? "amber" : "red"} title={`${words.label} — lines`}
        hint={`${plural(lines.length, "line")} · the longest pending first · tap a line to open the part`} />

      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[11px]">
        {Object.entries(AGE).map(([key, a]) => (
          <span key={key} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ring-1 ring-inset ${a.cls}`}>
            {a.label} · {num(totals.age_bands?.[key] || 0)}
          </span>
        ))}
      </div>

      {/* Phones: one card per line. */}
      <ul className="space-y-2 md:hidden">
        {drawn.map((ln) => (
          <li key={ln.id}>
            <button type="button" onClick={() => onPart(ln.part_id)}
              className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-left hover:border-slate-300 dark:border-navy-700">
              <span className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block text-[11px] text-slate-400">GRN {ln.grn_no || "—"} · {day(ln.grn_date)}</span>
                  <span className="block truncate text-sm font-semibold text-slate-800 dark:text-white">{ln.part_no}</span>
                  <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{ln.description}</span>
                </span>
                <AgeChip days={ln.days_pending} band={ln.age_band} closedTitle={words.closedDays} />
              </span>
              <span className="mt-1.5 block truncate text-xs text-slate-600 dark:text-slate-300">
                {ln.supplier_name || ln.supplier_code || "Supplier not given"}
                {ln.supplier_code && ln.supplier_name ? <span className="text-slate-400"> · {ln.supplier_code}</span> : null}
              </span>
              <span className={`mt-2 block rounded-lg px-2 py-1.5 text-xs ${words.tone === "amber" ? "bg-amber-50 dark:bg-amber-500/10" : "bg-rose-50 dark:bg-rose-500/10"}`}>
                <span className="block text-[10px] uppercase tracking-wide text-slate-400">{words.qty}</span>
                <b className={`font-semibold ${qtyTone}`}>{num(ln.qty)}</b> · <Value value={ln.value} strong />
              </span>
              <span className="mt-1.5 block text-[11px] text-slate-500 dark:text-slate-400">
                Challan {num(ln.challan_qty)} · received {num(ln.received_qty)} · accepted {num(ln.accepted_qty)} · lot{" "}
                {ln.gate_entry_no ? `${ln.gate_entry_no}${ln.gate_entry_dt ? ` (${day(ln.gate_entry_dt)})` : ""}` : "not given by ERP"}
              </span>
              <span className="mt-1.5 block"><Status line={ln} /></span>
            </button>
          </li>
        ))}
      </ul>

      <div className="hidden max-h-[65vh] overflow-auto rounded-xl border border-slate-200 dark:border-navy-800 md:block">
        <table className="min-w-full text-[13px]">
          <thead className="text-slate-600 dark:text-slate-300">
            <tr>
              {heads.map(([h, align]) => (
                <th key={h} scope="col"
                  className={`${LTH} sticky top-0 z-10 shadow-[inset_0_-1px_0_rgba(148,163,184,0.35)] ${align === "right" ? "text-right" : "text-left"}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-700 dark:divide-navy-800 dark:text-slate-200">
            {drawn.map((ln) => (
              <tr key={ln.id} {...rowButton(() => onPart(ln.part_id))}
                className="cursor-pointer hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-toyotared dark:hover:bg-navy-800/60">
                <td className="whitespace-nowrap px-2.5 py-2">{day(ln.grn_date)}</td>
                <td className="whitespace-nowrap px-2.5 py-2 font-medium">{ln.grn_no || "—"}</td>
                <td className="whitespace-nowrap px-2.5 py-2">{lot(ln)}</td>
                <td className="whitespace-nowrap px-2.5 py-2">{challan(ln)}</td>
                <td className="whitespace-nowrap px-2.5 py-2">{ln.po_no || notGiven}</td>
                <td className="px-2.5 py-2">
                  <span className="block max-w-[9rem] truncate" title={ln.supplier_name || undefined}>{ln.supplier_name || "—"}</span>
                  <span className="text-[11px] text-slate-400">{ln.supplier_code || ""}</span>
                </td>
                <td className="whitespace-nowrap px-2.5 py-2 font-medium text-slate-800 dark:text-white">{ln.part_no}</td>
                <td className="px-2.5 py-2">
                  <span className="block max-w-[10rem] truncate" title={ln.description || undefined}>{ln.description}</span>
                </td>
                <td className="px-2.5 py-2 text-right tabular">{num(ln.challan_qty)}</td>
                <td className="px-2.5 py-2 text-right tabular">{num(ln.received_qty)}</td>
                <td className="px-2.5 py-2 text-right tabular">{num(ln.accepted_qty)}</td>
                <td className={`px-2.5 py-2 text-right font-semibold tabular ${qtyTone}`}>{num(ln.qty)}</td>
                <td className="whitespace-nowrap px-2.5 py-2 text-right tabular">{ln.rate != null ? money(ln.rate) : <span className="text-[11px] text-slate-400">No rate</span>}</td>
                <td className="whitespace-nowrap px-2.5 py-2 text-right tabular"><Value value={ln.value} strong /></td>
                <td className="px-2.5 py-2"><AgeChip days={ln.days_pending} band={ln.age_band} closedTitle={words.closedDays} /></td>
                <td className="min-w-[9.5rem] px-2.5 py-2"><Status line={ln} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="sticky bottom-0 bg-slate-100 font-bold text-slate-900 dark:bg-navy-800 dark:text-white">
              <td className="px-2.5 py-2.5" colSpan={11}>Total · {plural(totals.lines, "line")}</td>
              <td className="px-2.5 py-2.5 text-right tabular">{num(totals.qty)}</td>
              <td />
              <td className="whitespace-nowrap px-2.5 py-2.5 text-right tabular"><Value value={totals.value} /></td>
              <td className="px-2.5 py-2.5"><AgeChip days={totals.oldest_days} /></td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      {lines.length > FIRST_ROWS && !all && (
        <p className="mt-2 text-[11px] text-slate-400">
          Showing the first {num(FIRST_ROWS)} of {num(lines.length)} lines ·{" "}
          <button type="button" onClick={() => setAll(true)} className="font-medium text-toyotared hover:underline">Show all</button>
          {" "}(the totals and the files cover every line)
        </p>
      )}
    </div>
  );
}

function Loading() {
  return (
    <div className="space-y-5" aria-label="Loading the list">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <KpiCard key={i} loading />)}
      </div>
      <div className="card space-y-2">
        {[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-9 w-full" />)}
      </div>
    </div>
  );
}

// ERP's line rejection return slips — read from ERP with every ERP read, never
// typed here. This store's parts by default (the table is mostly child parts).
function LineRejections({ storeCode }) {
  const [all, setAll] = useState(false);
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { const t = setTimeout(() => setQ(typed.trim()), 300); return () => clearTimeout(t); }, [typed]);
  const list = useQuery({
    queryKey: ["short-rejection", "line", storeCode, all, q],
    queryFn: () => shortRejectionService.lineRejections({ store_code: storeCode, all: all ? 1 : undefined, q: q || undefined },
      { silent: true }).then((r) => r.data.data),
    enabled: Boolean(storeCode),
  });
  const d = list.data;
  return (
    <div className="card p-0" role="tabpanel" aria-labelledby="sr-tab-line">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-navy-800">
        <div className="flex flex-wrap items-center gap-1">
          {[[false, "This store's parts"], [true, "All items"]].map(([v, label]) => (
            <button key={label} type="button" onClick={() => setAll(v)} aria-pressed={all === v}
              className={`rounded-full px-3 py-1 text-[12px] font-semibold ${all === v ? "bg-navy-900 text-white dark:bg-white dark:text-navy-900" : "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300"}`}>
              {label}
            </button>
          ))}
          {d && <span className="ml-2 text-[11px] text-slate-400">{d.rows.length} slip line{d.rows.length === 1 ? "" : "s"} · {d.total_in_erp} in ERP · read {d.synced_at ? new Date(d.synced_at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "not yet"}</span>}
        </div>
        <span className="relative">
          <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input className="input-field w-64 py-1.5 pl-8 text-[13px]" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Slip no., item, party…" />
        </span>
      </div>
      {list.isError ? <div className="p-4"><ErrorState title="Line rejections did not load" message={list.error?.response?.data?.message || list.error?.message} onRetry={() => list.refetch()} /></div> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-[12.5px]">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-navy-950/40 dark:text-slate-400">
              <tr>{["Date", "Return slip", "Item", "Qty", "From", "Party"].map((h) => <th key={h} className={`px-3 py-2.5 font-semibold ${h === "Qty" ? "text-right" : ""}`}>{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
              {(d?.rows || []).map((r, i) => (
                <tr key={`${r.slip_no}-${r.item_cd}-${i}`} className="align-top text-slate-700 dark:text-slate-200">
                  <td className="whitespace-nowrap px-3 py-2.5">{r.date ? new Date(`${r.date}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—"}<div className="text-[11px] text-slate-400">{r.time}</div></td>
                  <td className="px-3 py-2.5 font-mono">{r.slip_no}</td>
                  <td className="px-3 py-2.5"><div className="font-mono font-semibold">{r.item_cd}</div><div className="max-w-[280px] truncate text-[11px] text-slate-400" title={r.item_desc}>{r.item_desc}</div></td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular">{r.qty ?? "—"} {r.uom}</td>
                  <td className="px-3 py-2.5">{r.from}</td>
                  <td className="px-3 py-2.5">{r.party}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {d && d.rows.length === 0 && <p className="px-4 py-8 text-center text-sm text-slate-400">{all || q ? "No line rejection matches." : "No line rejection of this store's parts in ERP — see All items."}</p>}
        </div>
      )}
    </div>
  );
}
