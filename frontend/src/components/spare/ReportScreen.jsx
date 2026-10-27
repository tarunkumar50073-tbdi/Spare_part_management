import React, { useId, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Package, Search, X } from "lucide-react";
import ErrorState from "../ErrorState.jsx";
import ConsumptionTable, { TableDownloads } from "./ConsumptionTable.jsx";
import { useStores } from "../../context/StoreContext.jsx";
import { NO_ROWS, useStockList } from "../../lib/stockQueries.js";
import { num } from "../../lib/format.js";
import { REPORT, consumptionAnalyticsService } from "../../services/consumptionAnalyticsService.js";

// The layout of the Issuance & Consumption Report — two reports for a day
// (17 Oct 2026), one again since 18 Oct 2026 ("issuance and consumption report
// same dikh rhi h dono me differance nhi to ye kaam merge me bhi ho sakta h" —
// the store) — kept as simple as the store asked on 17 Oct ("ye thoda
// complicated ho gya, thoda simple ho jisme dropdown me date wise, month wise,
// year wise etc."): a title, ONE filter bar of dropdowns with the downloads at
// its end, and the table card. No view tabs, no subtotal toggle: the Issue
// list's subtotals follow the period's length (the server's auto_group).
// `children(state)` adds what the screen has beyond the table — the charts.
//
// The Period dropdown. `served`: the range is cut by the server on the plant
// clock and arrives with the filter lists (options.presets) — yesterday, last
// month and the financial year (1 April - 31 March) the store asked for on
// 17 Oct 2026 ("issuance and consumption ka bna de"). This year and the last
// 12 months are for the month- and year-wise table ("month wise ya year wise"
// — the store, 14 Oct 2026). Today is "aaj kitna part, konsa konsa part, kis kis
// depart ko issue kiya" (27 Oct 2026), cut on the browser's calendar as This month is.
const PRESETS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday", served: true },
  { key: "month", label: "This month" },
  { key: "last_month", label: "Last month", served: true },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "year", label: "This year" },
  { key: "12m", label: "Last 12 months" },
  { key: "this_fy", label: "This financial year", served: true },
  { key: "last_fy", label: "Last financial year (Apr–Mar)", served: true },
  { key: "custom", label: "Custom" },
];
const presetOf = (key) => PRESETS.find((p) => p.key === key);
const DEFAULT_PRESET = "month";
// The Issue list first: every issue a line, a subtotal per day — the store's
// first ask ("kis date ko kitna part and kon kon sa issue hua to dikh jaayega"
// — 14 Oct 2026).
const DEFAULT_VIEW = "list";
// Links made before 17 Oct 2026 named the period `range` and could carry
// `gran` (the chart's grouping) and `group` (the Issue list's subtotals). The
// period is read from `range` when there is no `period`; the other two are
// the screen's own pick now and are dropped at the next change.
const LEGACY = ["range", "gran", "group"];
// The server's range rule (ConsumptionAnalyticsService): a window of at most
// five years, so the table can compare years.
const MAX_DAYS = 1830;
const DEFAULT_DAYS = 30;

// A local-calendar YYYY-MM-DD — toISOString() would hand back yesterday for
// the first 5.5 hours of every plant day.
const isoDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// [from, to] of a preset. A served one is the server's plant-clock range, ["", ""]
// until the filter lists have brought it.
function presetRange(key, served) {
  if (presetOf(key)?.served) {
    const w = served?.[key];
    return w ? [w.from, w.to] : ["", ""];
  }
  const today = new Date();
  if (key === "today") return [isoDay(today), isoDay(today)];
  if (key === "month") return [isoDay(new Date(today.getFullYear(), today.getMonth(), 1)), isoDay(today)];
  if (key === "year") return [isoDay(new Date(today.getFullYear(), 0, 1)), isoDay(today)];
  // Twelve calendar months, this one to date: a month-wise table then starts on
  // a 1st, so its first row is a whole month and not a stray half of one.
  if (key === "12m") return [isoDay(new Date(today.getFullYear(), today.getMonth() - 11, 1)), isoDay(today)];
  const from = new Date(today);
  from.setDate(from.getDate() - ((key === "90d" ? 90 : 30) - 1));
  return [isoDay(from), isoDay(today)];
}

// The days a From - To covers as the server counts them: its end cut at today,
// a blank From meaning the 30 days to the end.
function spanDays(from, to) {
  const today = isoDay(new Date());
  const end = to && to < today ? to : today;
  if (!from) return DEFAULT_DAYS;
  return Math.round((new Date(`${end}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86_400_000) + 1;
}

// The first preset whose range spans more than one month (unit 7: "YYYY-MM")
// or one year (unit 4: "YYYY") — what the table offers when Month- or
// Year-wise would be a single row.
const longerThan = (unit) => {
  const key = ["year", "12m"].find((k) => {
    const [f, t] = presetRange(k);
    return f.slice(0, unit) !== t.slice(0, unit);
  });
  return key ? presetOf(key) : null;
};

// Full width in a phone's two columns, sized to their options from sm: up.
const select = "input-field py-1.5 text-[13px] sm:w-auto sm:min-w-[9rem] sm:max-w-[14rem]";
// The Period box may run wider: "Last financial year (Apr–Mar)" is read whole.
const periodSelect = select.replace("sm:max-w-[14rem]", "sm:max-w-[16rem]");

export default function ReportScreen({ children }) {
  const { activeCode } = useStores();
  const location = useLocation();

  // Every choice lives in the URL, so a link opens the same report.
  const [urlParams, setUrlParams] = useSearchParams();
  // The router writes the URL in a transition, and until it lands React puts
  // the old choice back in a dropdown: a second arrow-key press on Period or
  // View then starts from the old option, and a quick second change (Period,
  // then View) would be built on the old URL and drop the first. So the last
  // pick is held here and read at once; a new URL — the pick landing, or a
  // link followed to this screen — takes over from it.
  const [picked, setPicked] = useState(null);
  const urlKey = `${location.pathname}?${urlParams.toString()}`;
  const [seenUrl, setSeenUrl] = useState(urlKey);
  if (urlKey !== seenUrl) {
    setSeenUrl(urlKey);
    setPicked(null);
  }
  const params = picked ?? urlParams;
  // The served presets are cut on the day they were fetched. Today's date in
  // the key fetches them again once the day turns, so a screen kept open across
  // midnight (the night shift) does not go on offering the old day's
  // "Yesterday" or a financial year that stops short of today — the same
  // render-time "today" the browser-cut presets read.
  const today = isoDay(new Date());
  const opts = useQuery({
    queryKey: ["stock", "consumption-options", activeCode, today],
    queryFn: () => consumptionAnalyticsService.options(activeCode, { silent: true }).then((r) => r.data.data),
    enabled: Boolean(activeCode),
    staleTime: 5 * 60_000,
    // The same store's filter lists stay up while a new day's presets load;
    // another store's lists never stand in for this one's.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === activeCode ? prev : undefined),
  });
  // A placeholder carries the old day's ranges: a served preset waits for the new ones.
  const served = opts.isPlaceholderData ? undefined : opts.data?.presets;
  const asked = params.get("period") ?? params.get("range");
  const range = PRESETS.some((p) => p.key === asked) ? asked : DEFAULT_PRESET;
  const [from, to] = range === "custom"
    ? [params.get("from") || "", params.get("to") || ""]
    : presetRange(range, served);
  // A served preset whose range has not arrived yet: nothing is fetched for a
  // window not known — a blank From - To would mean the last 30 days.
  const waiting = Boolean(presetOf(range)?.served) && !served;
  const section = params.get("section") || "";
  const dept = params.get("dept") || "";
  const type = params.get("type") || "";
  const part = params.get("part") || "";
  const partNo = params.get("pno") || "";
  const badRange = Boolean(from && to && from > to);
  const days = badRange ? 0 : spanDays(from, to);
  const tooLong = days > MAX_DAYS;
  const blocked = badRange || tooLong || waiting;
  // Every view of the two reports of 17 Oct 2026 is a view of this one, so an
  // old link opens on the view it named; an unknown one on the Issue list.
  const askedView = params.get("view");
  const view = REPORT.views.some((v) => v.key === askedView) ? askedView : DEFAULT_VIEW;

  const update = (changes) => {
    const next = new URLSearchParams(params);
    if (!next.has("period") && next.has("range")) next.set("period", next.get("range"));
    LEGACY.forEach((k) => next.delete(k));
    Object.entries(changes).forEach(([k, v]) => { if (v) next.set(k, v); else next.delete(k); });
    setPicked(next);
    setUrlParams(next, { replace: true });
  };
  const choosePreset = (key) => update(key === "custom"
    // Custom starts from the window already on screen, not from blank boxes.
    ? { period: "custom", from, to }
    : { period: key, from: "", to: "" });
  const chooseDates = (f, t) => update({ period: "custom", from: f, to: t });
  const filtersActive = Boolean(section || dept || type || part);

  // The table, fetched here and not in its card: the downloads in the filter
  // bar take the same answer, so a file is always the table on screen.
  const tableParams = {
    store_code: activeCode,
    from: from || undefined,
    to: to || undefined,
    part_id: part || undefined,
    section_id: section || undefined,
    department: dept || undefined,
    type: type || undefined,
  };
  const tq = useQuery({
    queryKey: ["stock", "report-table", REPORT.key, activeCode, view, from, to, part, section, dept, type],
    // Silent: the table card shows its own error and Retry (api.js).
    queryFn: () => consumptionAnalyticsService.table({ ...tableParams, report: REPORT.key, view }, { silent: true })
      .then((r) => r.data.data),
    enabled: Boolean(activeCode) && !blocked,
    placeholderData: keepPreviousData,
  });
  const t = tq.data;

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
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-slate-800 dark:text-white">{REPORT.title}</h2>
          <p className="text-xs text-slate-400 mt-0.5">{REPORT.subtitle}</p>
        </div>
        {tq.isFetching && t && <span className="text-[11px] text-slate-400">Updating…</span>}
      </div>

      <FilterBar
        range={range} from={from} to={to} view={view} badRange={badRange || tooLong}
        section={section} dept={dept} type={type} part={part}
        partLabel={partNo || t?.filters?.part_no || (part ? `Part #${part}` : "")}
        partName={t?.filters?.part_name}
        sectionLabel={t?.filters?.section_name}
        options={opts.data} optionsError={opts.isError} onRetryOptions={() => opts.refetch()}
        code={activeCode}
        onPreset={choosePreset}
        onDates={chooseDates}
        onChange={update}
        active={filtersActive}
        onClear={() => update({ section: "", dept: "", type: "", part: "", pno: "" })}
        downloads={<TableDownloads tq={tq} params={tableParams} view={view} blocked={blocked} />}
      />

      {waiting ? (
        opts.isError ? (
          <div className="card">
            <ErrorState
              title={`Could not work out "${presetOf(range).label}"`}
              message="Its dates come from the server with the filter lists, which did not load."
              onRetry={() => opts.refetch()}
            />
          </div>
        ) : (
          <div className="card space-y-2" aria-label="Loading the dates">
            <div className="skeleton h-4 w-48" />
            <div className="skeleton h-40 w-full" />
          </div>
        )
      ) : badRange ? (
        <div className="card text-sm text-slate-500 dark:text-slate-400">
          The From date is after the To date — pick a period that runs forwards.
        </div>
      ) : tooLong ? (
        <div className="card text-sm text-slate-500 dark:text-slate-400">
          This period is {num(days)} days; the most is {num(MAX_DAYS)} (5 years) — pick a shorter range.
        </div>
      ) : (
        <>
          <ConsumptionTable
            tq={tq} view={view} filtered={filtersActive}
            longer={{ month: longerThan(7), year: longerThan(4) }} onPreset={choosePreset}
          />
          {children?.({ from, to, section, dept, type, part, onFilter: update })}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ filters

// A control with its name above it. A <label> wraps a lone box, so a click on
// the name lands in it; the part picker holds buttons of its own and is named
// with a caption instead.
function Field({ label, as: Tag = "label", className = "", children }) {
  return (
    <Tag className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{label}</span>
      {children}
    </Tag>
  );
}

// On a phone two columns (the Period alone on its row while Custom's From and
// To sit under it); from sm: up one row that wraps, the downloads at its end.
// Department and Part type take a phone's whole row: in half of one (115 px at
// 375) "All departments" read "All departm" and a picked name was cut too. The
// grid packs densely, so the Part no. box moves up beside the Section rather
// than leave a hole there.
function FilterBar({
  range, from, to, view, badRange, section, dept, type, part, partLabel, partName, sectionLabel,
  options, optionsError, onRetryOptions, code, onPreset, onDates, onChange, active, onClear, downloads,
}) {
  const sections = options?.sections || NO_ROWS;
  const types = options?.types || NO_ROWS;
  // The consuming departments — the one owning the part's section, never the
  // store, which only hands parts out ("store to issue karta h" — the store,
  // 18 Oct 2026).
  const departments = options?.departments || NO_ROWS;
  const custom = range === "custom";
  const date = `input-field py-1.5 text-[13px] min-w-0 sm:w-auto ${badRange ? "border-toyotared" : ""}`;
  return (
    <div className="card relative grid grid-flow-row-dense grid-cols-2 gap-x-2 gap-y-3 sm:flex sm:flex-wrap sm:items-end">
      <Field label="Period" className={custom ? "col-span-2" : ""}>
        <select className={`${periodSelect} font-medium text-slate-800 dark:text-white`} value={range}
          onChange={(e) => onPreset(e.target.value)}>
          {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </Field>
      {custom && (
        <>
          <Field label="From">
            <input type="date" value={from} max={to || undefined}
              onChange={(e) => onDates(e.target.value, to)} className={date} />
          </Field>
          <Field label="To">
            <input type="date" value={to} min={from || undefined}
              onChange={(e) => onDates(from, e.target.value)} className={date} />
          </Field>
        </>
      )}
      <Field label="View">
        <select className={`${select} font-medium text-slate-800 dark:text-white`} value={view}
          onChange={(e) => onChange({ view: e.target.value })}>
          {REPORT.views.map((v) => <option key={v.key} value={v.key}>{v.option || v.label}</option>)}
        </select>
      </Field>
      <Field label="Section">
        <select className={select} value={section} onChange={(e) => onChange({ section: e.target.value })}>
          <option value="">All sections</option>
          {/* The data is filtered to this section even while the list is loading,
              failed, or no longer offers it — so the box must say so, not "All". */}
          {section && !sections.some((s) => String(s.id) === section) && (
            <option value={section}>{sectionLabel || `Section #${section}`}</option>
          )}
          {sections.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
        </select>
      </Field>
      <Field label="Department" className="col-span-2">
        <select className={select} value={dept} title={REPORT.departmentHint}
          onChange={(e) => onChange({ dept: e.target.value })}>
          <option value="">All departments</option>
          {/* One the list does not offer (an older link, or a department no
              longer in use) is kept on screen, said neutrally: the figures
              below tell whether anything matches. */}
          {dept && !departments.includes(dept) && (
            <option value={dept}>{options ? `${dept} (not in the list)` : dept}</option>
          )}
          {departments.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </Field>
      <Field label="Category" className="col-span-2">
        <select className={select} value={type} onChange={(e) => onChange({ type: e.target.value })}>
          <option value="">All categories</option>
          {type && !types.some((x) => x.name === type) && <option value={type}>{type}</option>}
          {types.map((x) => <option key={x.name} value={x.name}>{x.name} ({x.parts})</option>)}
        </select>
      </Field>
      {/* With Custom's two date boxes the phone's columns fall one short: the
          picker then takes the whole last row rather than leave a hole. */}
      <Field label="Part no." as="div" className={custom ? "col-span-2" : ""}>
        <PartPicker code={code} part={part} label={partLabel} name={partName}
          onPick={(r) => onChange({ part: r ? String(r.part_id) : "", pno: r ? r.part_no : "" })} />
      </Field>
      {(optionsError || active) && (
        <div className="col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1 sm:h-[34px]">
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
      )}
      <div className="col-span-2 flex flex-wrap items-center gap-1.5 sm:ml-auto">{downloads}</div>
    </div>
  );
}

// Part-number type-ahead over the shared stock list (already cached by the
// other stock screens); the list is only fetched once the box is used. A
// combobox: focus stays in the box, the arrow keys move through the matches
// and Enter picks the highlighted one.
function PartPicker({ code, part, label, name, onPick }) {
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
      if (`${r.part_no || ""} ${r.part_name || ""} ${r.old_part_no || ""} ${r.new_part_no || ""} ${r.specification || ""}`.toLowerCase().includes(t)) {
        out.push(r);
        if (out.length >= 8) break;
      }
    }
    return out;
  }, [text, listQ.data]);

  if (part) {
    return (
      <span title={name ? `${label} — ${name}` : undefined}
        className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-slate-200 dark:border-navy-700 px-2.5 py-1.5 text-[13px] sm:max-w-[14rem]">
        <Package size={13} className="shrink-0 text-slate-400" aria-hidden="true" />
        <span className="truncate font-medium text-slate-700 dark:text-slate-200">{label}</span>
        <button type="button" onClick={() => onPick(null)} aria-label="Remove part filter"
          className="ml-auto shrink-0 text-slate-400 hover:text-toyotared">
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
    // Positioned from sm: up only: on a phone the list hangs from the whole
    // filter bar (relative), full width under the box, whichever column it is in.
    <div
      className="sm:relative"
      // Closes only when focus leaves the whole picker, so Tab can reach Retry.
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}
    >
      <span className="relative block">
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
          className="input-field py-1.5 pl-7 text-[13px] sm:w-44"
        />
      </span>
      {showList && (
        <ul id={listId} role="listbox" aria-label="Matching part numbers"
          className="absolute inset-x-5 z-20 mt-1 max-h-72 overflow-auto rounded-lg border border-slate-200 dark:border-navy-700
          bg-white dark:bg-navy-900 shadow-lg py-1 text-[13px] sm:inset-x-auto sm:left-0 sm:w-72">
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
