import React, { useEffect, useRef, useState } from "react";
import { FileDown, FileSpreadsheet, FileText, Inbox, Lightbulb } from "lucide-react";
import ErrorState from "../ErrorState.jsx";
import { num } from "../../lib/format.js";
import { LIST_GROUPS, REPORTS, consumptionAnalyticsService } from "../../services/consumptionAnalyticsService.js";

// The table card of the Issuance Report and the Consumption Report: pick a
// part (or all), a period and a view, read it here and take the same view away
// as Excel or PDF — no trip to the Reports page ("wahi mil jaaye app me, wahan
// select kare kis part ki kab se kab tak consumption ya month wise ya year wise
// consumption mil jaaye, alag se report me aane ki jarurat nhi, wahi se excel
// / pdf download ho jaaye" — the store, 14 Oct 2026). Issuance joined on 17 Oct
// 2026 — downloads only, never a mail ("issuance and consumption ka bna de but
// mail nhi karenge bas excel/pdf download ka option") — and the same day the
// one screen became two reports ("issuance and consumption ki report alag
// alag chahiye") with one simple filter bar ("ye thoda complicated ho gya
// thoda simple ho jisme dropdown me date wise, month wise, year wise etc.").
// The server builds every view (ConsumptionTableService): the Issuance Report
// gross, under the department written on the issue; the Consumption Report
// under the department owning the part's section, returns netted against their
// issue; a Total row last. The screen (ReportScreen) fetches the table once and
// hands the same query to the card and to the downloads in its filter bar, so
// what is downloaded is what is on screen.

// Columns holding a figure: right-aligned, Indian grouping. The money ones
// carry ₹ and always two places of paise, so the screen reads like the file
// and a column of rupees lines up on its decimal point.
const FIGURES = new Set(["Issues", "Parts", "Qty Issued", "Qty Returned", "Net Qty", "Rate", "Value", "Net Value"]);
const MONEY = new Set(["Rate", "Value", "Net Value"]);
// Free text that would otherwise stretch a row across the screen; the whole
// text is on hover.
const LONG_TEXT = new Set(["Description", "Issued To", "Line / Machine / Die"]);
// The order the "How this table is counted" lines are read in (JSON hands the
// server's keys back sorted); each report carries only its own.
const BASIS_KEYS = ["issuance", "consumption", "list", "returns", "value", "period", "person", "place"];

// Rows drawn at first. Five years Date-wise runs to thousands of rows and the
// line-side browser stalls drawing them all; the Total row and the files
// always cover every row.
const FIRST_ROWS = 300;

// A blank stays blank: an unknown value (no rate on any of its issues) is not
// ₹0, and an empty text cell is not a dash the file does not have.
const cell = (column, v) => {
  if (v == null || v === "") return "";
  if (MONEY.has(column)) {
    return `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (FIGURES.has(column)) return num(v);
  if (column === "Week") return week(v);
  return String(v);
};

// "17.07.2026 - 19.07.2026" on two lines on a phone ("17.07.2026 –" over
// "19.07.2026"), one line from sm: up. The week is the pinned first column:
// on one line it took a third of a phone's scroll box and left the figures a
// sliver.
const week = (v) => {
  const [first, last] = String(v).split(" - ");
  if (!last) return String(v);
  return <>{first}&nbsp;–<br className="sm:hidden" /> {last}</>;
};

// "Subtotal 10.03.2026" in the pinned first column: "Subtotal" over the period
// on a phone, for the same reason.
const subtotal = (v) => {
  const [word, ...period] = String(v).split(" ");
  return <>{word}<br className="sm:hidden" /> {period.join(" ")}</>;
};

// The server's file name for a title (reorder_mail_service._file_safe): what
// Windows refuses in a file name, and any control character, becomes a space.
const fileSafe = (name) => [...String(name || "")]
  .map((c) => (c < " " || '\\/:*?"<>|'.includes(c) ? " " : c))
  .join("")
  .split(/\s+/)
  .filter(Boolean)
  .join(" ");

// "2026-10-14" -> "14 Oct 2026"; the year dropped on the first of a pair in one year.
const day = (s, year = true) => new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", {
  day: "2-digit", month: "short", ...(year ? { year: "numeric" } : {}),
});
const span = (a, b) => (a === b ? day(a) : `${day(a, a.slice(0, 4) !== b.slice(0, 4))} – ${day(b)}`);
// The financial year (1 April - 31 March) a "YYYY-MM-DD" falls in, by its first year.
const fyOf = (s) => Number(s.slice(0, 4)) - (Number(s.slice(5, 7)) < 4 ? 1 : 0);

// Nothing to show: no issue counted — though a list of cancelled ones alone still shows.
const isEmpty = (t) => Boolean(t) && !(t.issues > 0) && !(t.cancelled_rows?.length > 0);
const reportOf = (key) => REPORTS[key] || REPORTS.consumption;
const viewOf = (report, key) => {
  const views = reportOf(report).views;
  return views.find((v) => v.key === key) || views[0];
};

const FILES = [
  { key: "excel", label: "Excel", ext: "xlsx", icon: FileDown },
  { key: "pdf", label: "PDF", ext: "pdf", icon: FileText },
];
// What one period of the Month-, Year- and Financial year-wise views is called,
// for the "this range is one period" hint.
const PERIOD = { month: "month", year: "year", fy: "financial year" };

// Excel, PDF and the Full pack, on the right of the screen's filter bar. `tq`
// is the screen's table query and `params` the report, store, range and
// filters it was asked with; `blocked` while the screen has no range to fetch
// (From after To, too long, or a served period whose dates are still on their
// way).
export function TableDownloads({ tq, params, view, report = "consumption", blocked }) {
  const [busy, setBusy] = useState(null);
  const t = tq.data;
  const empty = isEmpty(t);
  // A table still showing the previous choice must not be downloaded under the new one's name.
  const off = blocked || !t || tq.isPlaceholderData || empty || busy != null;
  const shownView = viewOf(report, view);

  const download = (file) => {
    setBusy(file.key);
    // The same report, view, range and filters as on screen, named as the server names it.
    consumptionAnalyticsService.exportTable({ ...params, report, view }, file.key, `${fileSafe(t.title)}.${file.ext}`)
      // A failure is already on screen as the API client's toast.
      .catch(() => {})
      .finally(() => setBusy(null));
  };
  const downloadPack = () => {
    setBusy("pack");
    consumptionAnalyticsService.exportPack({ ...params, report }, `${fileSafe(t.pack_title)}.xlsx`)
      .catch(() => {})
      .finally(() => setBusy(null));
  };
  const btn = "btn-secondary inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <>
      {FILES.map((file) => (
        <button
          key={file.key}
          type="button"
          onClick={() => download(file)}
          disabled={off}
          title={empty ? "Nothing to download — no issues in this period"
            : `Download this ${shownView.label.toLowerCase()} table as ${file.label}`}
          className={btn}
        >
          <file.icon size={14} aria-hidden="true" />
          {busy === file.key ? "Preparing…" : file.label}
        </button>
      ))}
      {/* Every cut of this report and range in one workbook, whatever view is on screen. */}
      <button
        type="button"
        onClick={downloadPack}
        disabled={off}
        title={empty ? "Nothing to download — no issues in this period"
          : `One Excel workbook of this period and filters: ${reportOf(report).pack}`}
        className={btn}
      >
        <FileSpreadsheet size={14} aria-hidden="true" />
        {busy === "pack" ? "Preparing…" : "Full pack (Excel)"}
      </button>
    </>
  );
}

export default function ConsumptionTable({ tq, view, report = "consumption", filtered, longer, onPreset }) {
  const t = tq.data;
  // "Show every row" holds for the table it was asked on; a new table starts short again.
  const [allFor, setAllFor] = useState(null);
  // A new table opens at its top-left: the box would otherwise keep the last
  // one's scroll and hide a new view's first columns under the pinned one.
  const boxRef = useRef(null);
  useEffect(() => { boxRef.current?.scrollTo?.(0, 0); }, [t]);

  const isList = view === "list";
  const rows = t?.rows || [];
  const total = rows[rows.length - 1];
  const body = rows.slice(0, -1);
  // The Issue list's group subtotals (bold) and cancelled issues (grey, not counted).
  const subtotals = new Set(t?.subtotal_rows || []);
  const cancelled = new Set(t?.cancelled_rows || []);
  const empty = isEmpty(t);
  const stale = tq.isPlaceholderData;
  const shownView = viewOf(report, view);
  // The Issue list's subtotals are the server's pick, from the range's length.
  const shownGroup = LIST_GROUPS.find((g) => g.key === t?.group) || LIST_GROUPS[0];
  const win = t?.window;
  // The table's own reading of the app's ledger (the same the Excel / PDF
  // carry as a note): before ledger_since no issue was recorded here, so an
  // empty period there is "not measured", not "nothing issued", and a range
  // reaching back past it is counted only from then.
  const since = win?.ledger_since;
  const unmeasured = win?.coverage === "none";
  const partly = win?.coverage === "partial";
  // Issues whose part has no rate: in the quantities, not in Value / Net Value.
  const unrated = t?.unrated_issues || 0;
  const issues = t?.issues || 0;

  // Month-, Year- and Financial year-wise over a range inside one such period
  // is a single row, nothing to compare: say so, and offer a range that compares.
  const oneRow = win && ((view === "month" && win.from.slice(0, 7) === win.to.slice(0, 7))
    || (view === "year" && win.from.slice(0, 4) === win.to.slice(0, 4))
    || (view === "fy" && fyOf(win.from) === fyOf(win.to)));
  const better = oneRow ? longer?.[view] : null;
  const period = PERIOD[view];

  const showAll = allFor === t;
  const drawn = showAll ? body : body.slice(0, FIRST_ROWS);
  const columns = t?.columns || [];
  // A row whose first cell repeats the last one drawn in full (the day's next
  // issue on the Issue list, a department's next machine or category) steps
  // back, so the eye reads the groups; the period views are one row a period. A cancelled row is grey already and does not count as
  // drawn in full: the first counted issue after it keeps the dark date. A
  // subtotal ends its group, so the row after it starts afresh.
  const repeats = new Set();
  drawn.reduce((shown, r, idx) => {
    if (subtotals.has(idx)) return null;
    if (cancelled.has(idx)) return shown;
    if (shown != null && r[columns[0]] === shown) repeats.add(idx);
    return r[columns[0]];
  }, null);

  return (
    <div className="card isolate min-w-0">
      {/* One line: the view, the range, and on the Issue list how it is
          subtotalled — picked from the range's length, so it is said. */}
      <p className="mb-3 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
        <b className="text-sm font-semibold text-slate-800 dark:text-white">{shownView.label}</b>
        {win && (
          <span>· {span(win.from, win.to)} · {num(win.days)} day{win.days === 1 ? "" : "s"}</span>
        )}
        {isList && t?.group && <span className="text-[11px] text-slate-400">· Subtotals by {shownGroup.noun}</span>}
      </p>

      {oneRow && (
        <p className="mb-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          <Lightbulb size={14} className="mt-px shrink-0" aria-hidden="true" />
          <span>
            This period sits inside one {period} — pick a longer period
            {better ? ` (e.g. ${better.label})` : ` (a Custom range across two ${period}s)`} to compare {period}s.
            {better && (
              <button type="button" onClick={() => onPreset(better.key)}
                className="ml-1.5 font-semibold underline underline-offset-2 hover:no-underline">
                Show {better.label.toLowerCase()}
              </button>
            )}
          </span>
        </p>
      )}

      {tq.isError && !t ? (
        <ErrorState
          title="Could not load the table"
          message={tq.error?.response?.data?.message || `The ${reportOf(report).title.toLowerCase()} did not load.`}
          onRetry={() => tq.refetch()}
        />
      ) : !t ? (
        <div className="space-y-2" aria-label="Loading the table">
          <div className="skeleton h-9 w-full" />
          {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton h-7 w-full" />)}
        </div>
      ) : empty ? (
        <div className="rounded-xl border border-dashed border-slate-300 dark:border-navy-700 bg-slate-50/60 dark:bg-navy-800/40 px-4 py-8 text-center">
          <Inbox size={26} strokeWidth={1.6} className="mx-auto mb-2 text-slate-300 dark:text-slate-600" aria-hidden="true" />
          {unmeasured ? (
            <>
              <p className="text-sm font-medium text-slate-600 dark:text-slate-300">
                {since ? "Not measured — this period is before the app's ledger" : "Not measured — the app's ledger has no rows yet"}
              </p>
              <p className="mt-1 text-[11px] text-slate-400">
                {since
                  ? <>The app&apos;s ledger starts {day(since)}; issues before it were never recorded here.</>
                  : "Issues show here once they are recorded on the app."}
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-slate-600 dark:text-slate-300">No issues in this period</p>
              <p className="mt-1 text-[11px] text-slate-400">
                Nothing was issued between {day(partly ? since : win.from)} and {day(win.to)}
                {filtered ? " under these filters" : ""} — widen the period or clear a filter.
              </p>
            </>
          )}
        </div>
      ) : (
        <>
          <div
            ref={boxRef}
            className={`max-h-[65vh] overflow-auto rounded-xl border border-slate-200 dark:border-navy-800 transition-opacity ${stale ? "opacity-60" : ""}`}
            aria-busy={stale || undefined}
          >
            <table className="min-w-full text-[13px]">
              <thead className="text-slate-600 dark:text-slate-300">
                <tr>
                  {columns.map((c, i) => (
                    <th
                      key={c}
                      scope="col"
                      // The pinned header may wrap on a phone ("Financial" over
                      // "Year"): its column is then as wide as its values, not
                      // as its one-line name, and leaves the figures room.
                      className={`sticky top-0 bg-slate-50 dark:bg-navy-800 px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide
                        shadow-[inset_0_-1px_0_rgba(148,163,184,0.35)]
                        ${FIGURES.has(c) ? "text-right" : "text-left"} ${i === 0 ? "left-0 z-20 whitespace-normal sm:whitespace-nowrap" : "z-10 whitespace-nowrap"}`}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-navy-800 text-slate-700 dark:text-slate-200">
                {drawn.map((r, idx) => {
                  const sub = subtotals.has(idx);
                  const gone = cancelled.has(idx);
                  const repeat = repeats.has(idx);
                  // A subtotal is bold on a tint; a cancelled issue grey and
                  // struck through — listed, not counted.
                  const tone = sub
                    ? "bg-slate-100 dark:bg-navy-800 font-semibold text-slate-900 dark:text-white"
                    : gone ? "text-slate-400 dark:text-slate-500" : "";
                  return (
                    <tr key={idx} className={`group ${tone}`}>
                      {columns.map((c, i) => (
                        <td
                          key={c}
                          title={LONG_TEXT.has(c) && r[c] ? r[c] : gone && i === 0 ? "Cancelled — listed, not counted" : undefined}
                          className={`px-3 py-2 whitespace-nowrap
                            ${FIGURES.has(c) ? "text-right tabular" : ""}
                            ${gone && FIGURES.has(c) ? "line-through" : ""}
                            ${LONG_TEXT.has(c) ? "max-w-[16rem] truncate" : ""}
                            ${i === 0
                              // A subtotal's label bold like the rest of its row:
                              // on a phone it is the one cell always in view.
                              ? `sticky left-0 z-[1] ${sub ? "font-semibold" : "font-medium"} ${sub ? "bg-slate-100 dark:bg-navy-800" : "bg-white dark:bg-navy-900 group-hover:bg-slate-50 dark:group-hover:bg-navy-800"} ${gone || repeat ? "text-slate-400 dark:text-slate-500" : sub ? "" : "text-slate-800 dark:text-white"}`
                              : sub ? "" : "group-hover:bg-slate-50 dark:group-hover:bg-navy-800/60"}`}
                        >
                          {sub && i === 0 ? subtotal(r[c]) : cell(c, r[c])}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
              {/* Pinned to the bottom of the box, so the Total is in view however
                  far the rows run. */}
              <tfoot>
                <tr>
                  {columns.map((c, i) => (
                    <td
                      key={c}
                      className={`sticky bottom-0 bg-slate-100 dark:bg-navy-800 px-3 py-2.5 whitespace-nowrap font-bold text-slate-900 dark:text-white
                        shadow-[inset_0_2px_0_rgba(148,163,184,0.45)]
                        ${FIGURES.has(c) ? "text-right tabular" : ""} ${i === 0 ? "left-0 z-20" : "z-10"}`}
                    >
                      {cell(c, total[c])}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-slate-400">
            <span>
              {isList
                ? <>{num(body.length - subtotals.size)} issue line{body.length - subtotals.size === 1 ? "" : "s"} · {num(subtotals.size)} {shownGroup.noun}{subtotals.size === 1 ? "" : "s"}</>
                : <>{num(body.length)} row{body.length === 1 ? "" : "s"}</>}
              {!showAll && body.length > FIRST_ROWS && (
                <>
                  {" "}· showing the first {num(FIRST_ROWS)} rows ·{" "}
                  <button type="button" onClick={() => setAllFor(t)} className="font-medium text-toyotared hover:underline">
                    Show all
                  </button>
                  {" "}(the Total and the files cover every row)
                </>
              )}
            </span>
            <span>Valued at today&apos;s rate</span>
          </div>
          {/* What the figures cannot say themselves — the same notes the Excel
              and PDF carry under the table. */}
          {(partly || unrated > 0 || cancelled.size > 0) && (
            <ul className="mt-1.5 space-y-0.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
              {partly && (
                <li>
                  The app&apos;s ledger starts <b className="font-semibold text-slate-700 dark:text-slate-200">{day(since)}</b>;
                  {" "}days before it were not recorded, so this range is counted from then.
                </li>
              )}
              {unrated > 0 && (
                <li>
                  Value covers rated issues only: <b className="font-semibold text-slate-700 dark:text-slate-200">{num(unrated)}</b>
                  {" "}of {num(issues)} issue{issues === 1 ? "" : "s"} {unrated === 1 ? "has" : "have"} no rate.
                  {" "}A blank value means none of its issues has one — not ₹0.
                </li>
              )}
              {cancelled.size > 0 && (
                <li>
                  <b className="font-semibold text-slate-700 dark:text-slate-200">{num(cancelled.size)}</b> cancelled
                  {" "}issue{cancelled.size === 1 ? "" : "s"} listed in grey — left out of every subtotal and the Total.
                </li>
              )}
            </ul>
          )}

          {t.basis && (
            <details className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
              <summary className="cursor-pointer select-none font-medium text-slate-500 dark:text-slate-300 hover:text-toyotared">
                How this table is counted
              </summary>
              <ul className="mt-1.5 list-disc space-y-0.5 pl-5 leading-relaxed">
                {BASIS_KEYS.filter((k) => t.basis[k] && (k !== "list" || isList) && (k !== "person" || view === "person"))
                  .map((k) => <li key={k}>{t.basis[k]}</li>)}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
