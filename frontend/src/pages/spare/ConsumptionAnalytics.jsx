import React, { useId, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  ArrowDown, ArrowUp, BarChart3, Boxes, Building2, Cog, FileDown, Info, IndianRupee, Layers,
  ListOrdered, Minus, Package, Search, Tags, X, Zap,
} from "lucide-react";
import CardHead from "../../components/CardHead.jsx";
import ErrorState from "../../components/ErrorState.jsx";
import HorizontalBars from "../../components/HorizontalBars.jsx";
import KpiCard from "../../components/KpiCard.jsx";
import NotCaptured from "../../components/NotCaptured.jsx";
import Sparkline from "../../components/Sparkline.jsx";
import Table from "../../components/Table.jsx";
import { useStores } from "../../context/StoreContext.jsx";
import { usePartDrawer } from "../../context/PartDrawerContext.jsx";
import { useTheme } from "../../context/ThemeContext.jsx";
import { NO_ROWS, useStockList } from "../../lib/stockQueries.js";
import { compactMoney, money, num } from "../../lib/format.js";
import { downloadXlsx } from "../../utils/excel.js";
import { consumptionAnalyticsService } from "../../services/consumptionAnalyticsService.js";

const PRESETS = [
  { key: "month", label: "This month" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "custom", label: "Custom" },
];
const GRANULARITIES = [
  { key: "", label: "Auto" },
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
];
const GRAN_NOUN = { day: "day", week: "week", month: "month" };

// Current vs previous: two hues checked for colour-blind separation in both
// themes, and two different marks (bars / dashed line), so the pair never
// rests on colour alone.
const SERIES = {
  light: { current: "#4f46e5", previous: "#0d9488" },
  dark: { current: "#6366f1", previous: "#0d9488" },
};

// A local-calendar YYYY-MM-DD — toISOString() would hand back yesterday for
// the first 5.5 hours of every plant day.
const isoDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function presetRange(key) {
  const today = new Date();
  if (key === "month") return [isoDay(new Date(today.getFullYear(), today.getMonth(), 1)), isoDay(today)];
  const from = new Date(today);
  from.setDate(from.getDate() - ((key === "90d" ? 90 : 30) - 1));
  return [isoDay(from), isoDay(today)];
}

// Plant days are dates, not instants: parsed as local midnight so they never
// drift a day in either direction.
const day = (s, year = true) => (s
  ? new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", ...(year ? { year: "numeric" } : {}),
  })
  : "—");
const span = (a, b) => (a === b ? day(a) : `${day(a, false)} – ${day(b)}`);

const select = "input-field py-1.5 text-[13px] w-auto min-w-[9rem] max-w-[14rem]";

export default function ConsumptionAnalytics() {
  const { activeCode, activeStore } = useStores();
  const { openPart } = usePartDrawer();
  const { dark } = useTheme() || {};
  const colors = dark ? SERIES.dark : SERIES.light;

  // Every filter lives in the URL, so a view can be sent to someone and the
  // back button undoes a filter.
  const [params, setParams] = useSearchParams();
  const range = PRESETS.some((p) => p.key === params.get("range")) ? params.get("range") : "30d";
  const [from, to] = range === "custom"
    ? [params.get("from") || "", params.get("to") || ""]
    : presetRange(range);
  const gran = GRANULARITIES.some((g) => g.key === params.get("gran")) ? params.get("gran") : "";
  const section = params.get("section") || "";
  const dept = params.get("dept") || "";
  const type = params.get("type") || "";
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
  const filtersActive = Boolean(section || dept || type || part);

  const q = useQuery({
    queryKey: ["stock", "consumption", activeCode, from, to, gran, section, dept, type, part],
    queryFn: () => consumptionAnalyticsService.get({
      store_code: activeCode,
      from: from || undefined,
      to: to || undefined,
      granularity: gran || undefined,
      section_id: section || undefined,
      department: dept || undefined,
      type: type || undefined,
      part_id: part || undefined,
    }).then((r) => r.data.data),
    enabled: Boolean(activeCode) && !badRange,
    placeholderData: keepPreviousData,
  });
  const opts = useQuery({
    queryKey: ["stock", "consumption-options", activeCode],
    queryFn: () => consumptionAnalyticsService.options(activeCode).then((r) => r.data.data),
    enabled: Boolean(activeCode),
    staleTime: 5 * 60_000,
  });
  const d = q.data;

  if (!activeCode) {
    return (
      <div className="card text-sm text-slate-500 dark:text-slate-400">
        No store is selected — choose the Spare Parts Store from the sidebar.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800 dark:text-white">Consumption Analytics</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            What {activeStore?.name || "this store"} issued in a window, against the same-length window just before it
          </p>
        </div>
        {q.isFetching && d && <span className="text-[11px] text-slate-400">Updating…</span>}
      </div>

      <FilterBar
        range={range} from={from} to={to} gran={gran} badRange={badRange}
        section={section} dept={dept} type={type} part={part}
        partLabel={partNo || d?.filters?.part_no || (part ? `Part #${part}` : "")}
        sectionLabel={d?.filters?.section_name}
        options={opts.data} optionsError={opts.isError} onRetryOptions={() => opts.refetch()}
        code={activeCode}
        onPreset={choosePreset}
        onDates={(f, t) => update({ range: "custom", from: f, to: t })}
        onChange={update}
        active={filtersActive}
        onClear={() => update({ section: "", dept: "", type: "", part: "", pno: "" })}
      />

      {badRange ? (
        <div className="card text-sm text-slate-500 dark:text-slate-400">
          The From date is after the To date — pick a window that runs forwards.
        </div>
      ) : q.isError && !d ? (
        <div className="card">
          <ErrorState
            title="Could not load consumption"
            message={q.error?.response?.data?.message || "The consumption figures did not load."}
            onRetry={() => q.refetch()}
          />
        </div>
      ) : !d ? (
        <LoadingState />
      ) : (
        <Body d={d} colors={colors} openPart={openPart} onFilter={update} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ filters

function FilterBar({
  range, from, to, gran, badRange, section, dept, type, part, partLabel, sectionLabel,
  options, optionsError, onRetryOptions, code, onPreset, onDates, onChange, active, onClear,
}) {
  const sections = options?.sections || NO_ROWS;
  const types = options?.types || NO_ROWS;
  const departments = options?.departments || NO_ROWS;
  return (
    <div className="card space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => onPreset(p.key)}
            aria-pressed={range === p.key}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${range === p.key
              ? "bg-toyotared text-white border-toyotared"
              : "border-slate-200 dark:border-navy-700 text-slate-600 dark:text-slate-300 hover:border-toyotared"}`}
          >
            {p.label}
          </button>
        ))}
        <span className="flex items-center gap-1.5 ml-1">
          <input type="date" aria-label="From" value={from} max={to || undefined}
            onChange={(e) => onDates(e.target.value, to)}
            className={`input-field py-1.5 text-[13px] w-auto ${badRange ? "border-toyotared" : ""}`} />
          <span className="text-xs text-slate-400">to</span>
          <input type="date" aria-label="To" value={to} min={from || undefined}
            onChange={(e) => onDates(from, e.target.value)}
            className={`input-field py-1.5 text-[13px] w-auto ${badRange ? "border-toyotared" : ""}`} />
        </span>
        <span className="inline-flex rounded-lg border border-slate-200 dark:border-navy-700 overflow-hidden ml-auto"
          role="group" aria-label="Group by">
          {GRANULARITIES.map((g) => (
            <button
              key={g.key || "auto"}
              type="button"
              onClick={() => onChange({ gran: g.key })}
              aria-pressed={gran === g.key}
              className={`text-xs px-2.5 py-1.5 transition-colors ${gran === g.key
                ? "bg-navy-900 text-white dark:bg-white dark:text-navy-900"
                : "text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-navy-800"}`}
            >
              {g.label}
            </button>
          ))}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Section" className={select} value={section}
          onChange={(e) => onChange({ section: e.target.value })}>
          <option value="">All sections</option>
          {/* The data is filtered to this section even while the list is loading,
              failed, or no longer offers it — so the box must say so, not "All". */}
          {section && !sections.some((s) => String(s.id) === section) && (
            <option value={section}>{sectionLabel || `Section #${section}`}</option>
          )}
          {sections.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
        </select>
        <select aria-label="Department" className={select} value={dept}
          onChange={(e) => onChange({ dept: e.target.value })}>
          <option value="">All departments</option>
          {/* A department picked from a breakdown bar may not be in the master. */}
          {dept && !departments.includes(dept) && <option value={dept}>{dept}</option>}
          {departments.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <select aria-label="Part type" className={select} value={type}
          onChange={(e) => onChange({ type: e.target.value })}>
          <option value="">All part types</option>
          {type && !types.some((t) => t.name === type) && <option value={type}>{type}</option>}
          {types.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.parts})</option>)}
        </select>
        <PartPicker code={code} part={part} label={partLabel}
          onPick={(r) => onChange({ part: r ? String(r.part_id) : "", pno: r ? r.part_no : "" })} />
        {optionsError && (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
            The section, department and type lists did not load.
            <button type="button" onClick={onRetryOptions} className="font-medium text-toyotared hover:underline">
              Retry
            </button>
          </span>
        )}
        {active && (
          <button type="button" onClick={onClear}
            className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-toyotared">
            <X size={13} aria-hidden="true" /> Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

// Part-number type-ahead over the shared stock list (already cached by the
// other stock screens); the list is only fetched once the box is used. A
// combobox: focus stays in the box, the arrow keys move through the matches
// and Enter picks the highlighted one.
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
      if ((r.part_no || "").toLowerCase().includes(t) || (r.old_part_no || "").toLowerCase().includes(t)) {
        out.push(r);
        if (out.length >= 8) break;
      }
    }
    return out;
  }, [text, listQ.data]);

  if (part) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-navy-700 px-2.5 py-1.5 text-[13px]">
        <Package size={13} className="text-slate-400" aria-hidden="true" />
        <span className="font-medium text-slate-700 dark:text-slate-200">{label}</span>
        <button type="button" onClick={() => onPick(null)} aria-label="Remove part filter"
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
    <div
      className="relative"
      // Closes only when focus leaves the whole picker, so Tab can reach Retry.
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}
    >
      <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" aria-hidden="true" />
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
        className="input-field py-1.5 pl-7 text-[13px] w-44"
      />
      {showList && (
        <ul id={listId} role="listbox" aria-label="Matching part numbers"
          className="absolute z-20 mt-1 w-72 max-h-72 overflow-auto rounded-lg border border-slate-200 dark:border-navy-700
          bg-white dark:bg-navy-900 shadow-lg py-1 text-[13px]">
          {listQ.isError ? (
            <li role="presentation" className="px-3 py-2 text-slate-500 dark:text-slate-400">
              Could not load the part list.{" "}
              {/* Back to the box: this button is gone once the list loads. */}
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
              className={`px-3 py-1.5 cursor-pointer ${i === cur ? "bg-slate-50 dark:bg-navy-800" : ""}`}
            >
              <span className="font-medium text-slate-800 dark:text-white">{r.part_no}</span>{" "}
              <span className="text-slate-400">{r.part_name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ states

function LoadingState() {
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => <KpiCard key={i} loading />)}
      </div>
      <div className="card">
        <div className="skeleton h-4 w-40 mb-4" />
        <div className="skeleton h-[240px] w-full" />
      </div>
      <div className="grid lg:grid-cols-2 gap-6">
        <div className="card"><div className="skeleton h-4 w-32 mb-4" /><div className="skeleton h-40 w-full" /></div>
        <div className="card"><div className="skeleton h-4 w-32 mb-4" /><div className="skeleton h-40 w-full" /></div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ body

function Body({ d, colors, openPart, onFilter }) {
  const { current: cur, previous: prev, window: win, previous_window: pw } = d;
  const nothing = cur.qty === 0 && prev.qty === 0;
  const granNoun = GRAN_NOUN[win.granularity];
  // A window wholly before the ledger was never measured — its tiles show a
  // dash, not a zero that claims nothing was issued.
  const unmeasured = cur.coverage === "none";
  const shown = (v) => (unmeasured ? "—" : v);
  // The ledger starts inside the window: its figures cover only the days since.
  const partial = cur.coverage === "partial";
  const unmeasuredDays = partial
    ? Math.round((new Date(`${d.ledger_since}T00:00:00`) - new Date(`${win.from}T00:00:00`)) / 86_400_000)
    : 0;
  // "Nothing issued" may only cover days the ledger was recording.
  const quietFrom = [prev.coverage === "none" ? win.from : pw.from, d.ledger_since]
    .filter(Boolean).sort().pop();
  const emptyMsg = unmeasured
    ? "Not measured — this window is before the app's ledger"
    : partial
      ? `Nothing issued between ${day(d.ledger_since)} and ${day(win.to)}`
      : "Nothing issued in this window";
  // A window's value is unknown, not ₹0, when none of its lines has a rate.
  const valueFig = (v) => (v == null ? "no rate" : compactMoney(v));
  const unrated = !prev.value_note && (cur.unvalued_lines > 0 || prev.unvalued_lines > 0);
  const notes = Boolean(partial || prev.change_note || prev.value_note || unrated);

  return (
    <>
      <div className="flex flex-wrap items-start gap-2.5 rounded-xl border border-slate-200 dark:border-navy-800
        bg-slate-50/70 dark:bg-navy-800/40 px-4 py-3 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
        <Info size={15} className="shrink-0 mt-0.5 text-slate-400" aria-hidden="true" />
        <p className="min-w-0 flex-1">
          <b className="text-slate-800 dark:text-white">{span(win.from, win.to)}</b> ({win.days} days)
          {" "}against <b className="text-slate-800 dark:text-white">{span(pw.from, pw.to)}</b>.
          {win.clamped_to_today && " The window was cut at today — later days have not happened yet."}
          {win.ends_today && " Today is still in progress: its issues so far are counted, so the last day is not complete."}
          {" "}Gross issued quantity from the app&apos;s ledger — returns are not netted off, and quantities
          add across units of measure. Value is each part&apos;s <b>current</b> rate, not the rate at issue.
          {" "}{d.ledger_since
            ? <>The app&apos;s ledger starts <b className="text-slate-800 dark:text-white">{day(d.ledger_since)}</b>; days before it are not measured.</>
            : <>The app&apos;s ledger has no rows yet.</>}
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Formatted, not a number: the tile's count-up rounds, and 0.4 MTR is not 0. */}
        <KpiCard featured tone="navy" label="Issued quantity" icon={Package} value={shown(num(cur.qty))}
          hint={<Change pct={prev.change_pct.qty} prev={prevFig(prev, num(prev.qty))} note={prev.change_note} />} />
        <KpiCard featured tone="navy" label="Issue lines" icon={ListOrdered} value={shown(cur.lines)}
          hint={<Change pct={prev.change_pct.lines} prev={prevFig(prev, num(prev.lines))} note={prev.change_note} />} />
        <KpiCard featured tone="navy" label="Parts issued" icon={Boxes} value={shown(cur.parts)}
          hint={<Change pct={prev.change_pct.parts} prev={prevFig(prev, num(prev.parts))} note={prev.change_note} />} />
        <KpiCard featured tone="blue" label="Value at today's rate" icon={IndianRupee}
          value={shown(cur.value == null ? "No rate" : compactMoney(cur.value))}
          valueTitle={unmeasured || cur.value == null ? undefined : money(cur.value)}
          hint={<Change pct={prev.change_pct.value} prev={prevFig(prev, valueFig(prev.value))}
            note={prev.change_note || prev.value_note} />} />
      </div>
      {notes && (
        <div className="-mt-3 space-y-0.5 text-[11px] text-slate-400">
          {partial && (
            <p>
              Measured from {day(d.ledger_since)}, when the app&apos;s ledger starts — the first {unmeasuredDays}
              {" "}day{unmeasuredDays === 1 ? "" : "s"} of this window {unmeasuredDays === 1 ? "is" : "are"} not counted.
            </p>
          )}
          {prev.change_note && <p>No % change shown: {prev.change_note}.</p>}
          {prev.value_note && <p>No value % change: {prev.value_note}.</p>}
          {unrated && (
            <p>
              Issue lines on parts with no rate are left out of the value: {cur.unvalued_lines} of {cur.lines} in this window
              {prev.coverage !== "none" && `, ${prev.unvalued_lines} of ${prev.lines} in the previous one`}.
            </p>
          )}
        </div>
      )}

      <div className="card">
        <CardHead
          icon={BarChart3} tone="blue"
          title={`Issued per ${granNoun}`}
          hint="Bars: this window · dashed line: the previous window, laid over the same days"
          action={!nothing && (
            <button type="button" className="btn-secondary inline-flex items-center gap-1.5 text-xs"
              onClick={() => exportSeries(d)}>
              <FileDown size={14} aria-hidden="true" /> Excel
            </button>
          )}
        />
        {nothing ? (
          <NotCaptured
            what={unmeasured
              ? "This window is before the app's ledger started — nothing was measured"
              : `Nothing issued between ${day(quietFrom)} and ${day(win.to)}`}
            needs={d.ledger_since
              ? `Consumption is read from ISSUE movements in the app's ledger, which starts ${day(d.ledger_since)}. Parts issued on Scan Part show here as they happen.`
              : "The app's ledger has no rows yet. Parts issued on Scan Part show here as they happen."}
          />
        ) : (
          <SeriesChart series={d.series} colors={colors} win={win} pw={pw} />
        )}
      </div>

      <div className="grid xl:grid-cols-5 gap-6">
        <div className="card xl:col-span-3">
          <CardHead icon={ListOrdered} tone="navy" title="Top 10 parts by issued quantity"
            hint={d.issued_parts > 10 ? `${d.issued_parts} parts issued in this window · click a row to open the part`
              : "Click a row to open the part"} />
          <Table
            columns={TOP_COLUMNS}
            rows={d.top_parts}
            exportName={`consumption_top_parts_${win.from}_${win.to}`}
            onRowClick={(r) => openPart(r.part_id)}
            rowKey={(r) => r.part_id}
            emptyMessage={emptyMsg}
          />
        </div>
        <SpikesPanel spikes={d.spikes} colors={colors} openPart={openPart} />
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <Breakdown icon={Building2} title="By department" rows={d.by_department} color={colors.current}
          hint="Click a bar to filter to that department" empty={emptyMsg}
          looseNote="no department on the movement"
          onPick={(key) => onFilter({ dept: key })} />
        <Breakdown icon={Layers} title="By section" rows={d.by_section} color={colors.current}
          hint="Click a bar to filter to that section" empty={emptyMsg}
          looseNote="parts not placed in a section"
          onPick={(key) => onFilter({ section: String(key) })} />
        <Breakdown icon={Tags} title="By part type" rows={d.by_type} color={colors.current}
          hint="Part sub-category · click a bar to filter" empty={emptyMsg}
          onPick={(key) => onFilter({ type: key })} />
        {/* Stage 1 (the store issue) carries no machine; the fitter records it on
            confirming at Stage 2 — so most blanks are pending, not missing. */}
        <Breakdown icon={Cog} title="By machine" rows={d.by_machine} color={colors.current}
          hint="Recorded when the fitter confirms the issue on Scan Part · Awaiting fitter's confirmation = not confirmed yet · Not recorded = closed with no machine given"
          empty={emptyMsg} />
      </div>
    </>
  );
}

// A previous window the ledger never covered has no figure to quote; one it
// covered only in part says so beside the figure.
const prevFig = (prev, fig) => (prev.coverage === "none" ? "not measured"
  : prev.coverage === "partial" ? `${fig} (part-measured)` : fig);

// Neutral on purpose: more usage is not "bad" and less is not "good", so the
// arrow says which way it moved and nothing more.
function Change({ pct, prev, note }) {
  if (pct == null) {
    // Why there is no % is spelled out under the tiles (and on hover).
    return <span title={note || undefined}>previous {prev}</span>;
  }
  const Icon = pct > 0 ? ArrowUp : pct < 0 ? ArrowDown : Minus;
  return (
    <span title={note || undefined} className="inline-flex items-center gap-1">
      <span className="inline-flex items-center gap-0.5 font-semibold text-slate-600 dark:text-slate-300">
        <Icon size={12} strokeWidth={2.5} aria-hidden="true" />
        {/* The arrow is hidden from screen readers, so the direction is said in words. */}
        <span className="sr-only">{pct > 0 ? "up " : pct < 0 ? "down " : "unchanged, "}</span>
        {Math.abs(pct).toLocaleString("en-IN")}%
      </span>
      <span>vs {prev} before</span>
    </span>
  );
}

function SeriesTip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg bg-navy-900 text-white px-3 py-2 shadow-xl text-xs border border-white/10 max-w-[260px]">
      <p className="font-semibold">{span(p.from, p.to)}</p>
      {p.coverage === "none" ? (
        <p className="text-slate-300 mt-0.5">Before the app&apos;s ledger started — not measured</p>
      ) : (
        <p className="mt-0.5">
          Issued <b>{num(p.qty)}</b> · {p.lines} line{p.lines === 1 ? "" : "s"}
          {p.value == null ? " · no rate" : p.value ? ` · ${money(p.value)}` : ""}
          {p.coverage === "partial" && <span className="block text-slate-400">The ledger started part-way through</span>}
        </p>
      )}
      <p className="mt-1 text-slate-300">
        Previous ({span(p.previous_from, p.previous_to)}):{" "}
        {p.previous_coverage === "none" ? "not measured" : <b className="text-white">{num(p.previous_qty)}</b>}
      </p>
    </div>
  );
}

function SeriesChart({ series, colors, win, pw }) {
  // A bucket the ledger never covered has no bar and no line point: an
  // unmeasured period is a gap, never a drawn zero.
  const data = useMemo(() => series.map((s) => ({
    ...s,
    shownQty: s.coverage === "none" ? null : s.qty,
    shownPrev: s.previous_coverage === "none" ? null : s.previous_qty,
  })), [series]);
  const labels = useMemo(() => Object.fromEntries(series.map((s) => [s.key, s.label])), [series]);
  // Mark where the ledger begins when that is inside the window.
  const ledgerStart = series.length > 0 && series[0].coverage !== "full"
    ? series.find((s) => s.coverage !== "none")?.key
    : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-4 mb-2 text-[11px] text-slate-500 dark:text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm" style={{ background: colors.current }} aria-hidden="true" />
          This window · {span(win.from, win.to)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="18" height="6" aria-hidden="true">
            <line x1="0" y1="3" x2="18" y2="3" stroke={colors.previous} strokeWidth="2" strokeDasharray="5 3" />
          </svg>
          Previous · {span(pw.from, pw.to)}
        </span>
      </div>
      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }} barCategoryGap="18%">
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(148,163,184,0.2)" />
            <XAxis dataKey="key" tickFormatter={(k) => labels[k] || k} tick={{ fontSize: 10, fill: "#94a3b8" }}
              axisLine={{ stroke: "rgba(148,163,184,0.45)" }} tickLine={false}
              interval="preserveStartEnd" minTickGap={18} />
            <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} width={40} axisLine={false} tickLine={false} />
            <Tooltip content={<SeriesTip />} cursor={{ fill: "rgba(148,163,184,0.12)" }} />
            {ledgerStart && (
              <ReferenceLine x={ledgerStart} stroke="#94a3b8" strokeDasharray="4 3"
                label={{ value: "Ledger starts", position: "insideTopLeft", fontSize: 10, fill: "#94a3b8" }} />
            )}
            <Bar dataKey="shownQty" name="This window" fill={colors.current} radius={[4, 4, 0, 0]}
              maxBarSize={28} isAnimationActive={false} />
            <Line dataKey="shownPrev" name="Previous window" stroke={colors.previous} strokeWidth={2}
              strokeDasharray="5 4" dot={false} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

function exportSeries(d) {
  const headers = ["From", "To", "Issued Qty", "Issue Lines", "Value (today's rate)",
    "Previous From", "Previous To", "Previous Issued Qty", "Measured"];
  const rows = d.series.map((s) => [
    s.from, s.to,
    s.coverage === "none" ? "" : s.qty,
    s.coverage === "none" ? "" : s.lines,
    s.coverage === "none" ? "" : s.value,
    s.previous_from, s.previous_to,
    s.previous_coverage === "none" ? "" : s.previous_qty,
    s.coverage === "none" ? "No — before the ledger" : s.coverage === "partial" ? "Part of the period" : "Yes",
  ]);
  downloadXlsx(`consumption_${d.window.granularity}_${d.window.from}_${d.window.to}`, headers, rows, "Consumption");
}

const TOP_COLUMNS = [
  { key: "part_no", label: "Part No", sortable: true,
    render: (r) => <span className="font-medium text-slate-800 dark:text-white">{r.part_no}</span> },
  { key: "name", label: "Description", sortable: true },
  { key: "qty", label: "Issued", align: "right", sortable: true, exportValue: (r) => r.qty,
    render: (r) => <span className="font-semibold tabular">{num(r.qty)}</span> },
  // Its own column, so the export keeps each quantity's unit (NO, PCS, MTR…).
  { key: "uom", label: "UoM", sortable: true,
    render: (r) => <span className="text-[11px] text-slate-500 dark:text-slate-400">{r.uom || "—"}</span> },
  { key: "lines", label: "Lines", align: "right", sortable: true },
  { key: "share_pct", label: "Share", align: "right", sortable: true, exportValue: (r) => r.share_pct ?? "",
    render: (r) => (r.share_pct == null ? "—" : `${r.share_pct}%`) },
  { key: "value", label: "Value (today's rate)", align: "right", sortable: true, exportValue: (r) => r.value ?? "",
    render: (r) => (r.value == null
      ? <span className="text-slate-400" title="No rate on the part master">no rate</span>
      : money(r.value)) },
];

function SpikesPanel({ spikes, colors, openPart }) {
  return (
    <div className="card xl:col-span-2">
      <CardHead icon={Zap} tone="violet" title="Usage spikes"
        hint={spikes.available
          ? `Week of ${span(spikes.last_week.from, spikes.last_week.to)} against the ${spikes.baseline_weeks} full weeks before`
          : "A part's last full week far above its usual weekly issue"} />
      {!spikes.available ? (
        <NotCaptured
          what="Not enough history to judge spikes yet"
          needs={`Spike detection ${spikes.reason}. A spike is a last full week above the mean + 3 × the standard deviation of the weeks before it — with fewer weeks that rule would flag noise.`}
        />
      ) : spikes.items.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400 py-6 text-center leading-relaxed">
          No part ran above its usual range in the week of {span(spikes.last_week.from, spikes.last_week.to)}.
          <span className="block text-[11px] text-slate-400 mt-1">Rule: {spikes.rule}.</span>
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-navy-800">
          {spikes.items.slice(0, 8).map((s) => (
            <li key={s.part_id}>
              <button type="button" onClick={() => openPart(s.part_id)}
                className="w-full text-left flex items-center gap-3 py-2.5 group">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-800 dark:text-white truncate group-hover:text-toyotared">
                    {s.part_no} <span className="font-normal text-slate-400">{s.part_name}</span>
                  </p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    {num(s.last_week_qty)} {s.uom} last week · usual {num(s.mean)} · {s.times_mean}x
                  </p>
                </div>
                <Sparkline data={s.weekly} stroke={colors.current} width={84} height={26} className="shrink-0" />
              </button>
            </li>
          ))}
          {spikes.items.length > 8 && (
            <li className="pt-2 text-[11px] text-slate-400">+ {spikes.items.length - 8} more</li>
          )}
        </ul>
      )}
    </div>
  );
}

function Breakdown({ icon, title, hint, rows, color, onPick, empty, looseNote }) {
  // Only named groups can be filtered to. When the bars are clickable, the
  // unnamed ones ("Not recorded" / "Unassigned") leave the bars for a caption
  // line, so no bar invites a click that does nothing.
  const pickable = onPick && rows.some((r) => r.key != null);
  const barRows = pickable ? rows.filter((r) => r.key != null) : rows;
  const loose = pickable ? rows.filter((r) => r.key == null && r.qty > 0) : NO_ROWS;
  const shown = barRows.slice(0, 8);
  const rest = barRows.slice(8);
  return (
    <div className="card">
      <CardHead icon={icon} tone="navy" title={title} hint={onPick && !pickable ? undefined : hint} />
      <HorizontalBars
        data={shown.map((r) => ({ name: r.name, value: r.qty, key: r.key }))}
        color={color}
        valueFormat={num}
        onBarClick={pickable ? (bar) => onPick(bar.key) : undefined}
        emptyMessage={empty}
      />
      {rest.length > 0 && (
        <p className="mt-2 text-[11px] text-slate-400">
          + {rest.length} more · {num(Math.round(rest.reduce((a, r) => a + r.qty, 0) * 100) / 100)} issued
        </p>
      )}
      {loose.map((r) => (
        <p key={r.name} className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
          <span className="font-medium text-slate-700 dark:text-slate-200">{r.name}</span>
          {" "}· {num(r.qty)} issued{looseNote ? ` (${looseNote} — cannot be filtered to)` : ""}
        </p>
      ))}
    </div>
  );
}
