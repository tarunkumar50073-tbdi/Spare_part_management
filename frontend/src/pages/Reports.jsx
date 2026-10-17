import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarRange, Clock, Download, FileSpreadsheet, FileDown, FileText, Sheet } from "lucide-react";
import ErrorState from "../components/ErrorState.jsx";
import { reportService } from "../services/reportService.js";
import { useStores } from "../context/StoreContext.jsx";
import { downloadFile } from "../utils/download.js";

const pad = (n) => String(n).padStart(2, "0");
// A plant-calendar YYYY-MM-DD — toISOString() would hand back yesterday for
// the first 5.5 hours of every plant day (this screen runs on the plant clock).
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// "2026-10-13" -> "13.10.2026": how a date reads on a card and in a file name.
const dotted = (iso) => iso.split("-").reverse().join(".");
// "13.10.2026", or "01.10.2026 to 13.10.2026" for a longer period.
const period = (from, to) => (from === to ? dotted(to) : `${dotted(from)} to ${dotted(to)}`);

// "13.10.2026" — the date in the Daily Stock Report's file name, the same one
// the server prints on it.
const reportDate = () => dotted(isoDay(new Date()));

// The spare store's ready-made stock workbooks, built by the server for the
// store the user is in: the whole stock position (MIS), and only the stock
// (the store, 14 Oct 2026: "daily mis k alawa only daily stock report").
const STOCK_WORKBOOKS = [
  {
    path: "/spare-stock/daily-report", file: "Daily Stock Report", title: "Daily Stock Report (MIS)",
    text: <>One print-ready workbook: a summary page with the key figures and sign-off, then the full stock
      detail, critical &amp; reorder, excess and category sheets.</>,
  },
  {
    path: "/spare-stock/daily-stock-only", file: "Daily Stock Report (Stock Only)",
    title: "Daily Stock Report (Stock Only)",
    text: "Only the stock: every active part with its location, quantity in stock and min / reorder / max — "
      + "dark red at zero, red at or below min or reorder, green in between, yellow above max, grey not counted. "
      + "One sheet, ready to print.",
  },
];

/** One of the stock workbooks above, as a card with its download. */
function StockWorkbook({ storeCode, path, file, title, text }) {
  const [preparing, setPreparing] = useState(false);
  const download = () => {
    setPreparing(true);
    // A failure is already on screen as the API client's toast.
    downloadFile(path, `${file} ${reportDate()}.xlsx`, { store_code: storeCode })
      .catch(() => {})
      .finally(() => setPreparing(false));
  };

  return (
    <div className="card border-l-4 border-l-toyotared flex flex-col sm:flex-row sm:items-center gap-4">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-rose-50 text-toyotared dark:bg-rose-500/15">
        <FileSpreadsheet size={22} />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="font-semibold text-slate-800 dark:text-white">{title}</h3>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{text}</p>
      </div>
      <button className="btn-primary shrink-0 justify-center disabled:opacity-60" onClick={download} disabled={preparing}>
        <Download size={16} /> {preparing ? "Preparing…" : "Download Excel"}
      </button>
    </div>
  );
}

// The buttons a report card can show, in this order, for the formats the
// catalogue lists for that report.
const FORMATS = [
  { key: "excel", label: "Excel", ext: "xlsx", icon: FileDown },
  { key: "csv", label: "CSV", ext: "csv", icon: Sheet },
  { key: "pdf", label: "PDF", ext: "pdf", icon: FileText },
];

// "<Label> <DD.MM.YYYY>[ to <DD.MM.YYYY>].<ext>", the name the server gives the
// file: a character no file system takes becomes a space, so "Reorder / Critical
// List" comes down as "Reorder Critical List", never as a folder path.
const fileName = (label, from, to, ext) => {
  const safe = label.replace(/[\\/:*?"<>|]+/g, " ").replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim();
  return `${safe || "Report"} ${period(from, to)}.${ext}`;
};

// The default period: the 1st of this month to today.
const thisMonth = () => {
  const today = new Date();
  return { from: isoDay(new Date(today.getFullYear(), today.getMonth(), 1)), to: isoDay(today) };
};

/** One date range for every report that covers a period. */
function PeriodBar({ range, onChange, error }) {
  const today = isoDay(new Date());
  return (
    <div className="card flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="min-w-0 flex-1">
        <h3 className="flex items-center gap-2 font-semibold text-slate-800 dark:text-white">
          <CalendarRange size={16} className="text-toyotared" aria-hidden="true" /> Period
        </h3>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
          Used by every report below that covers a period. The others are as of now.
        </p>
        {error && <p role="alert" className="mt-1 text-sm font-medium text-toyotared">{error}</p>}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
          From
          <input type="date" className={`input-field sm:!w-[160px] ${error ? "border-toyotared" : ""}`}
            value={range.from} max={range.to || today} onChange={(e) => onChange({ ...range, from: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
          To
          <input type="date" className={`input-field sm:!w-[160px] ${error ? "border-toyotared" : ""}`}
            value={range.to} min={range.from || undefined} max={today}
            onChange={(e) => onChange({ ...range, to: e.target.value })} />
        </label>
      </div>
    </div>
  );
}

/** One report of the store: what it is, the period it covers, its downloads. */
function ReportCard({ report, storeCode, range, rangeError }) {
  // The formats being prepared right now, so a second click waits for the file.
  const [preparing, setPreparing] = useState({});
  const dated = Boolean(report.needs_dates);
  const blocked = dated && Boolean(rangeError);
  const formats = FORMATS.filter((f) => report.formats?.includes(f.key));

  const download = (format) => {
    const today = isoDay(new Date());
    const [from, to] = dated ? [range.from, range.to] : [today, today];
    const params = dated ? { store_code: storeCode, date_from: from, date_to: to } : { store_code: storeCode };
    setPreparing((p) => ({ ...p, [format.key]: true }));
    // A failure is already on screen as the API client's toast.
    downloadFile(`/reports/${report.key}/${format.key}`, fileName(report.label, from, to, format.ext), params)
      .catch(() => {})
      .finally(() => setPreparing((p) => ({ ...p, [format.key]: false })));
  };

  return (
    <div className="card flex flex-col gap-3">
      <div className="min-w-0">
        <h3 className="font-semibold text-slate-800 dark:text-white">{report.label}</h3>
        {report.description && (
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{report.description}</p>
        )}
      </div>
      <p className={`mt-auto flex items-center gap-1.5 text-xs font-medium ${blocked
        ? "text-toyotared" : "text-slate-500 dark:text-slate-400"}`}>
        {dated ? <CalendarRange size={14} aria-hidden="true" /> : <Clock size={14} aria-hidden="true" />}
        {!dated ? "As of now" : blocked ? "Pick a valid period above" : period(range.from, range.to)}
      </p>
      <div className="flex flex-wrap gap-2">
        {formats.map((f) => {
          const Icon = f.icon;
          return (
            <button key={f.key} type="button" disabled={blocked || preparing[f.key]} onClick={() => download(f)}
              className="btn-secondary flex-1 justify-center min-w-[76px] disabled:opacity-60">
              <Icon size={15} aria-hidden="true" /> {preparing[f.key] ? "Preparing…" : f.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const Note = ({ children }) => <p className="text-sm text-slate-500 dark:text-slate-400">{children}</p>;

export default function Reports() {
  const { activeCode, activeStore, loading: storesLoading } = useStores();
  const [range, setRange] = useState(thisMonth);

  // Silent: a failure is shown on the page in words (with Try again).
  const catalog = useQuery({
    queryKey: ["reports", "catalog", activeCode],
    queryFn: () => reportService.catalog(activeCode, { silent: true }).then((r) => r.data.data),
    enabled: Boolean(activeCode),
  });
  const reports = (Array.isArray(catalog.data) ? catalog.data : []).filter((r) => r?.key && r?.label);
  const rangeError = !range.from || !range.to
    ? "Pick both dates of the period."
    : range.from > range.to ? "“From” is after “To” — pick a valid period." : null;

  let body;
  if (storesLoading || (activeCode && catalog.isPending)) {
    body = (
      <div className="space-y-3" aria-busy="true">
        <Note>Loading the reports of this store…</Note>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => <div key={i} className="card"><div className="skeleton h-24 w-full" /></div>)}
        </div>
      </div>
    );
  } else if (!activeCode) {
    body = <Note>No store is available for this account, so there are no reports to show.</Note>;
  } else if (catalog.isError) {
    body = (
      <div className="card">
        <ErrorState title="Could not load the reports"
          message={catalog.error?.response?.data?.message || "The list of reports of this store did not load — try again."}
          onRetry={() => catalog.refetch()} />
      </div>
    );
  } else if (reports.length === 0) {
    body = <div className="card"><Note>This store has no reports yet.</Note></div>;
  } else {
    body = (
      <>
        {reports.some((r) => r.needs_dates) && <PeriodBar range={range} onChange={setRange} error={rangeError} />}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {reports.map((r) => (
            <ReportCard key={r.key} report={r} storeCode={activeCode} range={range} rangeError={rangeError} />
          ))}
        </div>
      </>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-800 dark:text-white flex flex-wrap items-center gap-2">
        <FileSpreadsheet size={18} className="text-toyotared" /> Reports
        {activeStore?.name && (
          <span className="text-sm font-normal text-slate-500 dark:text-slate-400">· {activeStore.name}</span>
        )}
      </h2>

      {/* The spare stock list is what these are built from, so they are offered
          in a spare store only — not in the Child Parts Store. */}
      {activeCode && activeCode !== "CHILD_PART"
        && STOCK_WORKBOOKS.map((w) => <StockWorkbook key={w.path} storeCode={activeCode} {...w} />)}

      {body}
    </div>
  );
}
