import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  CalendarClock, CalendarRange, Database, FileDown, FileText, Inbox, Info, Package, PackageMinus, PackageSearch,
  PackageX, Search, TriangleAlert, Truck, X,
} from "lucide-react";
import CardHead from "../../components/CardHead.jsx";
import ErrorState from "../../components/ErrorState.jsx";
import KpiCard from "../../components/KpiCard.jsx";
import { useStores } from "../../context/StoreContext.jsx";
import { usePartDrawer } from "../../context/PartDrawerContext.jsx";
import { NO_ROWS, useStockList } from "../../lib/stockQueries.js";
import { compactMoney, money, num } from "../../lib/format.js";
import { shortRejectionService } from "../../services/shortRejectionService.js";

// Short & Rejection — what suppliers sent short and what quality rejected on
// this store's ERP GRN lines, supplier-wise and line by line, with the days
// each has been pending. The store asked for it on 17 Oct 2026: "rejection ka
// bhi banana padega taaki pta chale kis supplier ki rejection padi h kitne
// dino se and kis lot k against me reject hui — ye erp api se mil jaayega".
// The server reads ERP's GRN register (ShortRejectionService); this screen
// only shows it. ERP does not yet say when a short or a rejection is closed, so
// the days run from the GRN date and the screen says so.

const PRESETS = [
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "fy", label: "This FY" },
  { key: "custom", label: "Custom" },
];
const DEFAULT_PRESET = "90d";

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

function presetRange(key) {
  const today = new Date();
  if (key === "fy") {
    // The Indian financial year: 1 April to 31 March.
    const year = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
    return [isoDay(new Date(year, 3, 1)), isoDay(today)];
  }
  const from = new Date(today);
  from.setDate(from.getDate() - ((key === "30d" ? 30 : 90) - 1));
  return [isoDay(from), isoDay(today)];
}

// Plant days are dates, not instants: parsed as local midnight so they never
// drift a day in either direction.
const day = (s) => (s
  ? new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
  : "—");

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

// A value on a line or a supplier: "—" when there is nothing of that kind,
// "No rate" when there is but the part has no rate — never ₹0 for unknown.
function Value({ qty, value, strong }) {
  if (!qty) return <span className="text-slate-300 dark:text-slate-600">—</span>;
  if (value == null) return <span className="text-[11px] text-slate-400" title="The part has no rate, so this is not valued">No rate</span>;
  return <span className={strong ? "font-semibold" : ""}>{money(value)}</span>;
}

// One kind (rejected / short) of a supplier: its money, then lines and qty.
function KindCell({ lines, qty, value }) {
  return (
    <td className="whitespace-nowrap px-3 py-2 text-right tabular">
      <span className="block"><Value qty={lines} value={value} strong /></span>
      <span className="block text-[11px] font-normal text-slate-400">
        {lines ? `${plural(lines, "line")} · ${num(qty)} qty` : "none"}
      </span>
    </td>
  );
}

// One line's rejected or short qty, its money under it.
function QtyCell({ qty, value, tone }) {
  if (!qty) return <td className="px-3 py-2 text-right text-slate-300 dark:text-slate-600">—</td>;
  return (
    <td className="whitespace-nowrap px-3 py-2 text-right tabular">
      <span className={`block font-semibold ${tone}`}>{num(qty)}</span>
      <span className="block text-[11px]"><Value qty={qty} value={value} /></span>
    </td>
  );
}

function AgeChip({ days }) {
  const band = bandOf(days);
  if (!band) return <span className="text-slate-400">—</span>;
  return (
    <span title={`${AGE[band].label} since the GRN date`}
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold tabular ring-1 ring-inset ${AGE[band].cls}`}>
      {num(days)} d
    </span>
  );
}

export default function ShortRejection() {
  const { activeCode, activeStore } = useStores();
  const { openPart } = usePartDrawer();
  const code = activeCode;

  // Every filter lives in the URL, so a view can be sent to someone. A change
  // replaces the history entry (typing would otherwise leave one per pause),
  // so Back leaves the screen rather than undoing a filter.
  const [params, setParams] = useSearchParams();
  const range = PRESETS.some((p) => p.key === params.get("range")) ? params.get("range") : DEFAULT_PRESET;
  const [from, to] = range === "custom"
    ? [params.get("from") || "", params.get("to") || ""]
    : presetRange(range);
  const supplier = params.get("supplier") || "";
  const part = params.get("part") || "";
  const partNo = params.get("pno") || "";
  const badRange = Boolean(from && to && from > to);

  const update = (changes) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    Object.entries(changes).forEach(([k, v]) => { if (v) next.set(k, v); else next.delete(k); });
    return next;
  }, { replace: true });
  const choosePreset = (key) => update(key === "custom"
    // Custom starts from the window already on screen, not from blank boxes.
    ? { range: "custom", from, to }
    : { range: key, from: "", to: "" });

  const query = {
    store_code: code,
    from: from || undefined,
    to: to || undefined,
    supplier: supplier || undefined,
    part_id: part || undefined,
  };
  const q = useQuery({
    queryKey: ["short-rejection", code, from, to, supplier, part],
    // Silent: the page shows its own error and Retry (api.js).
    queryFn: () => shortRejectionService.get(query, { silent: true }).then((r) => r.data.data),
    enabled: Boolean(code) && !badRange,
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  const stale = q.isPlaceholderData;
  const [busy, setBusy] = useState(null);

  const download = (file) => {
    setBusy(file.key);
    // The window and filters on screen, named as the server names the file.
    shortRejectionService.exportFile(query, file.key, `${fileSafe(d.title)}.${file.ext}`)
      // A failure is already on screen as the API client's toast.
      .catch(() => {})
      .finally(() => setBusy(null));
  };

  if (!code) {
    return (
      <div className="card text-sm text-slate-500 dark:text-slate-400">
        No store is selected — choose the Spare Parts Store from the sidebar.
      </div>
    );
  }

  const empty = Boolean(d) && d.lines.length === 0;
  const filtered = Boolean(supplier || part);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-72">
          <h2 className="text-lg font-bold text-slate-800 dark:text-white">Short &amp; Rejection</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            What suppliers sent short and what quality rejected on {activeStore?.name || "this store"}&apos;s ERP
            GRN lines — supplier-wise and line by line, with the days each has been pending.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {q.isFetching && d && <span className="mr-1 text-[11px] text-slate-400">Updating…</span>}
          {FILES.map((file) => (
            <button
              key={file.key}
              type="button"
              onClick={() => download(file)}
              disabled={!d || stale || empty || busy != null}
              title={empty ? "Nothing to download — nothing short or rejected in this window"
                : `Download the supplier-wise list and the lines as ${file.label}`}
              className="btn-secondary inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
            >
              <file.icon size={14} aria-hidden="true" />
              {busy === file.key ? "Preparing…" : file.label}
            </button>
          ))}
        </div>
      </div>

      <ErpBanner asOf={d?.data_as_of} gap={d?.window?.not_held} notGiven={d?.not_given || NO_ROWS} />

      <FilterBar
        range={range} from={from} to={to} badRange={badRange} code={code}
        shown={stale ? null : d?.window}
        supplier={supplier} part={part} partLabel={partNo || d?.filters?.part_no || (part ? `Part #${part}` : "")}
        onPreset={choosePreset}
        onDates={(f, t) => update({ range: "custom", from: f, to: t })}
        onChange={update}
      />

      {badRange ? (
        <div className="card text-sm text-slate-500 dark:text-slate-400">
          The From date is after the To date — pick a window that runs forwards.
        </div>
      ) : q.isError && !d ? (
        <div className="card">
          <ErrorState
            title="Could not load the short & rejection list"
            message={q.error?.response?.data?.message || "The list did not load."}
            onRetry={() => q.refetch()}
          />
        </div>
      ) : !d ? (
        <Loading />
      ) : (
        <div className={`space-y-5 transition-opacity ${stale ? "opacity-60" : ""}`} aria-busy={stale || undefined}>
          <Tiles totals={d.totals} />
          <UnmatchedNote unmatched={d.unmatched} />
          {empty ? (
            <EmptyState window={d.window} heldFrom={d.data_as_of?.held_from} filtered={filtered} range={range}
              onPreset={choosePreset} />
          ) : (
            <>
              <SupplierTable
                summary={d.summary} totals={d.totals} selected={supplier}
                onPick={(s) => {
                  const key = s.supplier_code || s.supplier_name || "";
                  update({ supplier: supplier.toLowerCase() === key.toLowerCase() ? "" : key });
                }}
              />
              <LinesTable lines={d.lines} totals={d.totals} onPart={openPart} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ banner

// How current the ERP data is (amber once its last refresh is more than two
// days old), where it starts — the ERP sync keeps only its last N days, so an
// open line on an older GRN is not listed (amber when the window reaches back
// before it) — how the days are counted, and what ERP does not give yet.
function ErpBanner({ asOf, gap, notGiven }) {
  if (!asOf) return null;
  // Amber when the data is old or the window reaches before it; the "old"
  // sentence and its warning sign only when the data itself is old.
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
      {asOf.held_from && (
        <p className={`mt-1 flex items-start gap-2 ${gap ? "" : "text-slate-500 dark:text-slate-400"}`}>
          <CalendarRange size={14} className="mt-px shrink-0 opacity-70" aria-hidden="true" />
          <span>
            GRN lines are held from {day(asOf.held_from)}
            {asOf.keeps_days ? ` (the ERP sync keeps the last ${num(asOf.keeps_days)} days)` : ""}: an open short or
            rejection on an older GRN is not listed.
            {gap && (
              <b className="font-semibold"> No GRN line is held for {span(gap)} — nothing can show for those dates.</b>
            )}
          </span>
        </p>
      )}
      <p className={`mt-1 flex items-start gap-2 ${staleBox ? "" : "text-slate-500 dark:text-slate-400"}`}>
        <Info size={14} className="mt-px shrink-0 opacity-70" aria-hidden="true" />
        <span>
          Days pending are counted from the GRN date until ERP tells the app the item is closed (a replacement
          or a debit note). ERP gives no closure yet, so every line here counts as open.
          {notGiven.length > 0 && (
            <> Not given by ERP yet: <b className="font-semibold">{notGiven.join(", ")}</b> — shown blank until ERP carries them.</>
          )}
        </span>
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ filters

function FilterBar({ range, from, to, badRange, code, shown, supplier, part, partLabel, onPreset, onDates, onChange }) {
  // The supplier box types freely; the list follows a moment after typing stops.
  const [text, setText] = useState(supplier);
  // Follow the URL only when it says something else (a supplier clicked,
  // filters cleared): the debounce sends the text trimmed, and copying that
  // back would eat the space just typed between two words.
  useEffect(() => { setText((t) => (t.trim() === supplier ? t : supplier)); }, [supplier]);
  useEffect(() => {
    if (text.trim() === supplier) return undefined;
    const t = setTimeout(() => onChange({ supplier: text.trim() }), 400);
    return () => clearTimeout(t);
    // onChange is a fresh function each render; the text is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, supplier]);

  return (
    <div className="card space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => onPreset(p.key)}
            aria-pressed={range === p.key}
            className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${range === p.key
              ? "border-toyotared bg-toyotared text-white"
              : "border-slate-200 text-slate-600 hover:border-toyotared dark:border-navy-700 dark:text-slate-300"}`}
          >
            {p.label}
          </button>
        ))}
        {/* On a phone the pair takes a line of its own, never a box squeezed
            until its date is cut off. */}
        <span className="flex w-full flex-wrap items-center gap-1.5 sm:ml-1 sm:w-auto sm:flex-nowrap">
          <input type="date" aria-label="GRN date from" value={from} max={to || undefined}
            onChange={(e) => onDates(e.target.value, to)}
            className={`input-field min-w-[8.5rem] flex-1 py-1.5 text-[13px] sm:w-auto sm:min-w-0 sm:flex-none ${badRange ? "border-toyotared" : ""}`} />
          <span className="flex min-w-[9.75rem] flex-1 items-center gap-1.5 sm:min-w-0 sm:flex-none">
            <span className="text-xs text-slate-400">to</span>
            <input type="date" aria-label="GRN date to" value={to} min={from || undefined}
              onChange={(e) => onDates(from, e.target.value)}
              className={`input-field min-w-0 flex-1 py-1.5 text-[13px] sm:w-auto sm:flex-none ${badRange ? "border-toyotared" : ""}`} />
          </span>
        </span>
        {/* The window the figures cover, as the server took it: a box left
            blank is filled by its default, which the box itself never shows. */}
        <span className="text-[11px] text-slate-400">
          on the GRN date
          {shown && (
            <> · showing <span className="font-medium text-slate-600 dark:text-slate-300">{span(shown)}</span></>
          )}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Truck size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Supplier name or code…"
            aria-label="Filter by supplier"
            className="input-field w-full py-1.5 pl-7 pr-7 text-[13px]"
          />
          {text && (
            <button type="button" onClick={() => { setText(""); onChange({ supplier: "" }); }}
              aria-label="Clear the supplier filter"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-toyotared">
              <X size={13} />
            </button>
          )}
        </div>
        <PartPicker code={code} part={part} label={partLabel}
          onPick={(r) => onChange({ part: r ? String(r.part_id) : "", pno: r ? r.part_no : "" })} />
        {(supplier || part) && (
          <button type="button" onClick={() => { setText(""); onChange({ supplier: "", part: "", pno: "" }); }}
            className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-toyotared">
            <X size={13} aria-hidden="true" /> Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

// Part-number type-ahead over the shared stock list (already cached by the
// other stock screens), fetched only once the box is used. A combobox: focus
// stays in the box, the arrow keys move through the matches, Enter picks.
function PartPicker({ code, part, label, onPick }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputRef = useRef(null);
  const listQ = useStockList(code, null, { enabled: open });
  const matches = useMemo(() => {
    const t = text.trim().toLowerCase();
    if (!t || !listQ.data) return NO_ROWS;
    const out = [];
    for (const r of listQ.data) {
      if (`${r.part_no || ""} ${r.part_name || ""} ${r.old_part_no || ""} ${r.new_part_no || ""}`.toLowerCase().includes(t)) {
        out.push(r);
        if (out.length >= 8) break;
      }
    }
    return out;
  }, [text, listQ.data]);

  if (part) {
    return (
      <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[13px] dark:border-navy-700">
        <Package size={13} className="shrink-0 text-slate-400" aria-hidden="true" />
        <span className="truncate font-medium text-slate-700 dark:text-slate-200">{label}</span>
        <button type="button" onClick={() => onPick(null)} aria-label="Remove the part filter"
          className="text-slate-400 hover:text-toyotared">
          <X size={13} />
        </button>
      </span>
    );
  }
  const showList = open && Boolean(text.trim());
  const pickable = showList && !listQ.isError && !listQ.isPending && matches.length > 0;
  const cur = Math.min(active, Math.max(matches.length - 1, 0));
  const optionId = (i) => `${listId}-opt-${i}`;
  const pick = (r) => { onPick(r); setText(""); setOpen(false); };

  return (
    <div className="relative w-full sm:w-56"
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
      <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => { setText(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            if (pickable) setActive((cur + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
          } else if (e.key === "Enter" && pickable) {
            e.preventDefault();
            pick(matches[cur]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder="Part no…"
        aria-label="Filter by part number"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={pickable ? optionId(cur) : undefined}
        className="input-field w-full py-1.5 pl-7 text-[13px]"
      />
      {showList && (
        <ul id={listId} role="listbox" aria-label="Matching part numbers"
          className="absolute z-20 mt-1 max-h-72 w-full min-w-[16rem] overflow-auto rounded-lg border border-slate-200 bg-white py-1 text-[13px] shadow-lg dark:border-navy-700 dark:bg-navy-900">
          {listQ.isError ? (
            <li role="presentation" className="px-3 py-2 text-slate-500 dark:text-slate-400">
              Could not load the part list.{" "}
              <button type="button" onClick={() => { listQ.refetch(); inputRef.current?.focus(); }}
                className="font-medium text-toyotared hover:underline">
                Retry
              </button>
            </li>
          ) : listQ.isPending ? (
            <li role="presentation" className="px-3 py-2 text-slate-400">Loading parts…</li>
          ) : matches.length === 0 ? (
            <li role="presentation" className="px-3 py-2 text-slate-400">No part number matches</li>
          ) : matches.map((r, i) => (
            <li
              key={r.part_id}
              id={optionId(i)}
              role="option"
              aria-selected={i === cur}
              // Keeps focus in the box, so its blur does not close the list first.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(r)}
              onMouseEnter={() => setActive(i)}
              className={`cursor-pointer px-3 py-1.5 ${i === cur ? "bg-slate-100 dark:bg-navy-800" : ""}`}
            >
              <span className="font-medium text-slate-800 dark:text-white">{r.part_no}</span>
              <span className="ml-1.5 text-slate-400">{r.part_name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ figures

function Tiles({ totals: t }) {
  const oldBand = bandOf(t.oldest_days);
  const tone = (lines, base) => (lines ? base : "navy");
  const valueOf = (lines, value) => (lines && value == null ? "No rate" : compactMoney(value || 0));
  // One tile a row on a phone: beside the app's icon rail two would cut
  // their labels to a few letters.
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <KpiCard featured tone={tone(t.short_lines, "amber")} label="Short" icon={PackageMinus}
        value={valueOf(t.short_lines, t.short_value)} valueTitle={t.short_value != null ? money(t.short_value) : undefined}
        hint={`${plural(t.short_lines, "line")} · ${num(t.short_qty)} qty short`} />
      <KpiCard featured tone={tone(t.rejected_lines, "red")} label="Rejected" icon={PackageX}
        value={valueOf(t.rejected_lines, t.rejected_value)}
        valueTitle={t.rejected_value != null ? money(t.rejected_value) : undefined}
        hint={`${plural(t.rejected_lines, "line")} · ${num(t.rejected_qty)} qty rejected`} />
      <KpiCard featured tone={t.suppliers ? "blue" : "navy"} label="Suppliers" icon={Truck}
        value={t.suppliers} hint="with a short or a rejection" />
      <KpiCard featured tone={oldBand === "30+" ? "red" : oldBand && oldBand !== "0-7" ? "amber" : "navy"}
        label="Oldest" icon={CalendarClock}
        value={t.oldest_days ?? "—"} unit={t.oldest_days != null ? "days" : undefined}
        hint="pending since the GRN date" />
      {t.unrated_lines > 0 && (
        <p className="-mt-1 text-[11px] text-slate-500 dark:text-slate-400 sm:col-span-2 lg:col-span-4">
          The money covers lines whose part has a rate: {plural(t.unrated_lines, "line")} {t.unrated_lines === 1 ? "has" : "have"} no
          rate and {t.unrated_lines === 1 ? "is" : "are"} counted in the quantities only — blank, not ₹0.
        </p>
      )}
    </div>
  );
}

// Short or rejected ERP lines whose item code is no store's Part No: no
// store lists them, so they are counted here rather than vanish.
function UnmatchedNote({ unmatched: u }) {
  if (!u?.lines) return null;
  const one = u.lines === 1;
  const rest = u.item_count - u.items.length;
  return (
    <details className="rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-xs text-slate-600 dark:border-navy-800 dark:bg-navy-900 dark:text-slate-300">
      <summary className="cursor-pointer select-none">
        <PackageSearch size={14} className="mr-1.5 inline -mt-0.5 text-slate-400" aria-hidden="true" />
        <b className="font-semibold">{num(u.lines)}</b> short or rejected ERP GRN {one ? "line" : "lines"} in this window{" "}
        {one ? "is" : "are"} for item codes that are no store&apos;s Part No, so no store lists {one ? "it" : "them"}.{" "}
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

function EmptyState({ window: w, heldFrom, filtered, range, onPreset }) {
  // The whole window is older than the oldest GRN held: not "nothing short or
  // rejected" — nothing is known for it.
  const notHeld = Boolean(w.not_held) && w.not_held.to === w.to;
  return (
    <div className="card">
      <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-4 py-8 text-center dark:border-navy-700 dark:bg-navy-800/40">
        <Inbox size={26} strokeWidth={1.6} className="mx-auto mb-2 text-slate-300 dark:text-slate-600" aria-hidden="true" />
        <p className="text-sm font-medium text-slate-600 dark:text-slate-300">
          {notHeld ? "No GRN line is held for these dates" : "Nothing short or rejected in this window"}
        </p>
        <p className="mt-1 text-[11px] text-slate-400">
          {notHeld ? (
            <>GRN lines are held from {day(heldFrom)}, so nothing can show for {span(w)}.</>
          ) : (
            <>
              No GRN line dated {span(w)}{filtered ? " under these filters" : ""} was received short or rejected by
              quality{w.not_held ? ` (nothing before ${day(heldFrom)} is held)` : ""}.
            </>
          )}
          {range !== "fy" && (
            <>
              {" "}
              <button type="button" onClick={() => onPreset("fy")}
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

function SupplierTable({ summary, totals, selected, onPick }) {
  const isOn = (s) => Boolean(selected)
    && selected.toLowerCase() === (s.supplier_code || s.supplier_name || "").toLowerCase();
  return (
    <div className="card min-w-0">
      <CardHead icon={Truck} tone="blue" title="Supplier-wise"
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
              <span className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <span className="rounded-lg bg-slate-50 px-2 py-1.5 dark:bg-navy-800">
                  <span className="block text-[10px] uppercase tracking-wide text-slate-400">Rejected</span>
                  {plural(s.rejected_lines, "line")} · <Value qty={s.rejected_lines} value={s.rejected_value} strong />
                </span>
                <span className="rounded-lg bg-slate-50 px-2 py-1.5 dark:bg-navy-800">
                  <span className="block text-[10px] uppercase tracking-wide text-slate-400">Short</span>
                  {plural(s.short_lines, "line")} · <Value qty={s.short_lines} value={s.short_value} strong />
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {/* Wider screens: one row per supplier — each kind's money on top, its
          lines and qty under it, so the table fits beside the sidebar. */}
      <div className="hidden overflow-x-auto rounded-xl border border-slate-200 dark:border-navy-800 md:block">
        <table className="min-w-full text-[13px]">
          <thead className="text-slate-600 dark:text-slate-300">
            <tr>
              <th scope="col" className={`${TH} text-left`}>Supplier</th>
              <th scope="col" className={`${TH} text-right`}>Rejected</th>
              <th scope="col" className={`${TH} text-right`}>Short</th>
              <th scope="col" className={`${TH} text-left`}>Oldest pending</th>
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
                <KindCell lines={s.rejected_lines} qty={s.rejected_qty} value={s.rejected_value} />
                <KindCell lines={s.short_lines} qty={s.short_qty} value={s.short_value} />
                <td className="px-3 py-2"><AgeChip days={s.oldest_days} /></td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-500 dark:text-slate-400">{day(s.latest_grn_date)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-slate-100 font-bold text-slate-900 dark:bg-navy-800 dark:text-white">
              <td className="px-3 py-2.5">Total · {plural(totals.suppliers, "supplier")}</td>
              <KindCell lines={totals.rejected_lines} qty={totals.rejected_qty} value={totals.rejected_value} />
              <KindCell lines={totals.short_lines} qty={totals.short_qty} value={totals.short_value} />
              <td className="px-3 py-2.5"><AgeChip days={totals.oldest_days} /></td>
              <td className="whitespace-nowrap px-3 py-2.5">{day(totals.latest_grn_date)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function LinesTable({ lines, totals, onPart }) {
  const [all, setAll] = useState(false);
  const drawn = all ? lines : lines.slice(0, FIRST_ROWS);
  // The lot a line came in with: its gate entry no. and date, in the screen's date style.
  const lot = (ln) => (ln.gate_entry_no
    ? <>{ln.gate_entry_no}{ln.gate_entry_dt ? <span className="text-[11px] text-slate-400"> · {day(ln.gate_entry_dt)}</span> : null}</>
    : <span className="text-[11px] text-slate-400" title="ERP's GRN register does not carry the gate entry yet">Not given</span>);
  return (
    <div className="card min-w-0">
      <CardHead icon={PackageX} tone="red" title="GRN lines short or rejected"
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
                <AgeChip days={ln.days_pending} />
              </span>
              <span className="mt-1.5 block truncate text-xs text-slate-600 dark:text-slate-300">
                {ln.supplier_name || ln.supplier_code || "Supplier not given"}
                {ln.supplier_code && ln.supplier_name ? <span className="text-slate-400"> · {ln.supplier_code}</span> : null}
              </span>
              <span className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <span className={`rounded-lg px-2 py-1.5 ${ln.rejected_qty ? "bg-rose-50 dark:bg-rose-500/10" : "bg-slate-50 dark:bg-navy-800"}`}>
                  <span className="block text-[10px] uppercase tracking-wide text-slate-400">Rejected</span>
                  {ln.rejected_qty ? <>{num(ln.rejected_qty)} · <Value qty={ln.rejected_qty} value={ln.rejected_value} strong /></> : "—"}
                </span>
                <span className={`rounded-lg px-2 py-1.5 ${ln.short_qty ? "bg-amber-50 dark:bg-amber-500/10" : "bg-slate-50 dark:bg-navy-800"}`}>
                  <span className="block text-[10px] uppercase tracking-wide text-slate-400">Short</span>
                  {ln.short_qty ? <>{num(ln.short_qty)} · <Value qty={ln.short_qty} value={ln.short_value} strong /></> : "—"}
                </span>
              </span>
              <span className="mt-1.5 block text-[11px] text-slate-500 dark:text-slate-400">
                Challan {num(ln.challan_qty)} · received {num(ln.received_qty)} · accepted {num(ln.accepted_qty)} · lot {ln.gate_entry_no ? `${ln.gate_entry_no}${ln.gate_entry_dt ? ` (${day(ln.gate_entry_dt)})` : ""}` : "not given by ERP"}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="hidden max-h-[65vh] overflow-auto rounded-xl border border-slate-200 dark:border-navy-800 md:block">
        <table className="min-w-full text-[13px]">
          <thead className="text-slate-600 dark:text-slate-300">
            <tr>
              {/* What the store acts on first — age, GRN, supplier, part, what is
                  wrong and its money — then the ERP detail, off to the right. */}
              {[["Age", "left"], ["GRN", "left"], ["Supplier", "left"], ["Part", "left"], ["Rejected", "right"],
                ["Short", "right"], ["Lot (gate entry)", "left"], ["Challan qty", "right"], ["Received", "right"],
                ["Accepted", "right"], ["Rate", "right"], ["Challan no", "left"], ["PO no", "left"]].map(([h, align]) => (
                <th key={h} scope="col"
                  className={`${TH} sticky top-0 z-10 shadow-[inset_0_-1px_0_rgba(148,163,184,0.35)] ${align === "right" ? "text-right" : "text-left"}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-700 dark:divide-navy-800 dark:text-slate-200">
            {drawn.map((ln) => (
              <tr key={ln.id} {...rowButton(() => onPart(ln.part_id))}
                className="cursor-pointer hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-toyotared dark:hover:bg-navy-800/60">
                <td className="px-3 py-2"><AgeChip days={ln.days_pending} /></td>
                <td className="whitespace-nowrap px-3 py-2">
                  <span className="block font-medium">{ln.grn_no || "—"}</span>
                  <span className="text-[11px] text-slate-400">{day(ln.grn_date)}</span>
                </td>
                <td className="max-w-[14rem] px-3 py-2">
                  <span className="block truncate" title={ln.supplier_name || undefined}>{ln.supplier_name || "—"}</span>
                  <span className="text-[11px] text-slate-400">{ln.supplier_code || ""}</span>
                </td>
                <td className="max-w-[16rem] px-3 py-2">
                  <span className="block font-medium text-slate-800 dark:text-white">{ln.part_no}</span>
                  <span className="block truncate text-[11px] text-slate-400" title={ln.description || undefined}>{ln.description}</span>
                </td>
                <QtyCell qty={ln.rejected_qty} value={ln.rejected_value} tone="text-rose-700 dark:text-rose-300" />
                <QtyCell qty={ln.short_qty} value={ln.short_value} tone="text-amber-700 dark:text-amber-300" />
                <td className="whitespace-nowrap px-3 py-2">{lot(ln)}</td>
                <td className="px-3 py-2 text-right tabular">{num(ln.challan_qty)}</td>
                <td className="px-3 py-2 text-right tabular">{num(ln.received_qty)}</td>
                <td className="px-3 py-2 text-right tabular">{num(ln.accepted_qty)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular">{ln.rate != null ? money(ln.rate) : <span className="text-[11px] text-slate-400">No rate</span>}</td>
                <td className="whitespace-nowrap px-3 py-2">{ln.challan_no || "—"}{ln.challan_dt ? <span className="text-[11px] text-slate-400"> · {day(ln.challan_dt)}</span> : null}</td>
                <td className="whitespace-nowrap px-3 py-2">{ln.po_no || <span className="text-[11px] text-slate-400">Not given</span>}</td>
              </tr>
            ))}
          </tbody>
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
    <div className="space-y-5" aria-label="Loading the short & rejection list">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <KpiCard key={i} loading />)}
      </div>
      <div className="card space-y-2">
        {[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-9 w-full" />)}
      </div>
    </div>
  );
}
