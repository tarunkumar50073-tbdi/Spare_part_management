import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight, Boxes, ClipboardList, CloudUpload, Database, DatabaseZap, FileSpreadsheet, Info, Network,
  RefreshCw, Scale, Send, TriangleAlert, X,
} from "lucide-react";
import CardHead from "../../components/CardHead.jsx";
import NotCaptured from "../../components/NotCaptured.jsx";
import Table from "../../components/Table.jsx";
import { useCan } from "../../components/Can.jsx";
import { useConfirm } from "../../components/ConfirmDialog.jsx";
import { useStores } from "../../context/StoreContext.jsx";
import { usePartDrawer } from "../../context/PartDrawerContext.jsx";
import { erpControlService } from "../../services/erpControlService.js";
import { spareStockService } from "../../services/spareStockService.js";
import { invalidateStock } from "../../lib/stockQueries.js";
import { fmtDate, money, num, parseServerTime } from "../../lib/format.js";

// ERP Control Center: every figure the app holds about ERP, with its age and
// where it came from. Nothing here is called "live" — the stock snapshot is a
// push with a date on it, the DB-sync status lives in server memory, and
// write-back stays off until ERP approves it. Each card says which.

// With the year: a snapshot can be months old, and "10 Aug" alone hides that.
// Server stamps are UTC; parseServerTime keeps a zone-less one from reading as local.
const stamp = (iso) => {
  const d = parseServerTime(iso);
  return d
    ? d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "—";
};

// The calendar day of a server UTC stamp, in the plant's clock.
const stampDay = (iso) => fmtDate(parseServerTime(iso));

const age = (hours) => {
  if (hours == null) return null;
  if (hours < 1) return "under 1 h";
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.floor(hours / 24)} d`;
};

const every = (seconds) => {
  if (!seconds) return null;
  if (seconds < 120) return `${seconds} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
};

const plural = (n, word) => `${num(n)} ${word}${n === 1 ? "" : "s"}`;

// ------------------------------------------------------------------ chips

const CHIP_TONES = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300",
  warn: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300",
  bad: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300",
  off: "border-slate-200 bg-slate-50 text-slate-600 dark:border-navy-700 dark:bg-navy-800 dark:text-slate-300",
};

function StateChip({ tone = "off", label }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${CHIP_TONES[tone]}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {label}
    </span>
  );
}

// State -> [tone, label]. Labels say what the state means, not the enum.
function syncChip(s) {
  switch (s.state) {
    case "OK": return ["ok", `Synced · ${age(s.last_sync_age_hours)} ago`];
    case "ERROR": return ["bad", "Error on last run"];
    case "NEVER_RUN": return ["warn", "Not run since restart"];
    default: return ["off", "Not configured"];
  }
}

function snapshotChip(s) {
  switch (s.state) {
    case "SYNCED": return ["ok", `Current · ${age(s.age_hours)} old`];
    case "STALE": return ["warn", `Stale · ${age(s.age_hours)} old`];
    default: return ["off", "None received"];
  }
}

function inboxChip(s) {
  switch (s.state) {
    case "UNAVAILABLE": return ["bad", "Folder unavailable"];
    case "ERROR": return ["bad", "Error on last scan"];
    case "FILES_WAITING": return ["warn", `${plural(s.pending_files.length, "file")} waiting`];
    case "LAST_FILE_FAILED": return ["bad", "Last file failed to import"];
    case "OK": return ["ok", `Clear · scanned ${age(s.last_scan_age_hours)} ago`];
    default: return ["off", "Not scanned since restart"];
  }
}

function writeChip(s) {
  switch (s.state) {
    case "ACTIVE": return ["ok", "On"];
    case "NOT_CONFIGURED": return ["warn", "Off — ERP endpoint not set"];
    default: return ["warn", "Off — approval pending"];
  }
}

// ------------------------------------------------------------ status card

function StatusCard({ icon, tone, title, chip, rows, foot }) {
  return (
    <div className="card flex flex-col">
      <CardHead icon={icon} tone={tone} title={title} />
      <div className="mb-3"><StateChip tone={chip[0]} label={chip[1]} /></div>
      <dl className="flex-1 space-y-1.5 text-xs">
        {rows.filter(Boolean).map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 text-slate-400">{k}</dt>
            <dd className="min-w-0 text-right font-medium text-slate-700 dark:text-slate-200 tabular">{v}</dd>
          </div>
        ))}
      </dl>
      {foot && (
        <p className="mt-3 border-t border-slate-100 pt-2 text-[11px] leading-snug text-slate-400 dark:border-navy-800">
          {foot}
        </p>
      )}
    </div>
  );
}

const when = (iso, hours, suffix = "ago") => (iso ? `${stamp(iso)} (${age(hours)} ${suffix})` : null);

function StatusCards({ d }) {
  const sync = d.db_sync;
  const snap = d.stock_snapshot;
  const box = d.ledger_inbox;
  const wb = d.write_back;
  const lastRun = sync.last_result
    ? `Gate ${num(sync.last_result.gate_entry)} · GRN ${num(sync.last_result.receiving_register)} rows`
    : "—";
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatusCard
        icon={DatabaseZap} tone="blue" title="ERP database sync" chip={syncChip(sync)}
        rows={[
          ["Last sync", when(sync.last_sync_at, sync.last_sync_age_hours)
            || (sync.configured ? "None since the server started" : "—")],
          ["Automatic poll", sync.poller_running
            ? (every(sync.poll_seconds) ? `Every ${every(sync.poll_seconds)}` : "Running")
            : "Not running"],
          ["Window", sync.since_days ? `Last ${num(sync.since_days)} days` : "Full history"],
          ["Last run", lastRun],
        ]}
        foot={`Read-only pull of gate entries and GRNs. ${sync.note}`}
      />
      <StatusCard
        icon={Database} tone={snap.state === "SYNCED" ? "green" : "amber"} title="ERP stock snapshot" chip={snapshotChip(snap)}
        rows={[
          ["Parts with an ERP figure", `${num(snap.rows)} of ${num(snap.parts_total)}${snap.coverage_pct != null ? ` (${snap.coverage_pct}%)` : ""}`],
          ["Newest figure", when(snap.last_synced_at, snap.age_hours, "old") || "—"],
          snap.oldest_synced_at && snap.oldest_synced_at !== snap.last_synced_at
            ? ["Oldest figure", stamp(snap.oldest_synced_at)] : null,
          ["Counts as stale after", `${snap.stale_after_hours} h`],
        ]}
        foot={snap.source}
      />
      <StatusCard
        icon={FileSpreadsheet} tone="violet" title="ERP ledger inbox" chip={inboxChip(box)}
        rows={[
          // null = the folder could not be listed, so the count is unknown (not 0).
          ["Files waiting", box.pending_files == null ? "Unknown — folder unavailable" : num(box.pending_files.length)],
          ["Last scan", when(box.last_scan_at, box.last_scan_age_hours) || "None since the server started"],
          ["Automatic scan", box.poller_running
            ? (every(box.poll_seconds) ? `Every ${every(box.poll_seconds)}` : "Running")
            : "Not running"],
          box.consecutive_failures > 0 ? ["Failed scans in a row", num(box.consecutive_failures)] : null,
        ]}
        foot={`${box.scope} Status resets when the server restarts.`}
      />
      <StatusCard
        icon={CloudUpload} tone={wb.active ? "green" : "amber"} title="ERP write-back" chip={writeChip(wb)}
        rows={[
          ["Waiting to send", plural(wb.pending, "movement")],
          ["Oldest waiting", when(wb.oldest_pending_at, wb.oldest_pending_age_hours) || "—"],
          ["Sent to ERP so far", wb.pushed_total ? `${num(wb.pushed_total)} · last ${stamp(wb.last_pushed_at)}` : "None"],
        ]}
        foot={wb.reason}
      />
    </div>
  );
}

// ------------------------------------------------------------- last error

function errorsOf(d) {
  const out = [];
  const sync = d.db_sync;
  const box = d.ledger_inbox;
  if (sync.last_error) {
    out.push({
      source: "ERP database sync", message: sync.last_error,
      detail: sync.last_sync_at ? `Last good sync ${stamp(sync.last_sync_at)}` : "No successful sync since the server started",
    });
  }
  if (box.error) out.push({ source: "ERP ledger inbox folder", message: box.error });
  if (box.last_error) {
    out.push({
      source: "ERP ledger inbox scan", message: box.last_error,
      detail: box.consecutive_failures ? `${plural(box.consecutive_failures, "failed scan")} in a row` : null,
    });
  }
  const failedFile = (box.recent || []).find((r) => r.ok === false);
  if (failedFile) {
    out.push({ source: "ERP ledger file", message: `${failedFile.file}: ${failedFile.error}`, detail: stamp(failedFile.at) });
  }
  return out;
}

function LastErrors({ errors }) {
  if (!errors.length) return null;
  return (
    <div className="card border-rose-200 bg-rose-50/60 dark:border-rose-500/30 dark:bg-rose-500/[0.08]" role="alert">
      <div className="flex items-center gap-2 text-sm font-semibold text-rose-700 dark:text-rose-300">
        <TriangleAlert size={16} aria-hidden="true" /> Last error{errors.length > 1 ? "s" : ""}
      </div>
      <ul className="mt-2 space-y-2">
        {errors.map((e) => (
          <li key={e.source} className="text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-200">{e.source}</span>
            {e.detail && <span className="text-slate-400"> · {e.detail}</span>}
            <p className="mt-0.5 break-words font-mono text-[11px] text-rose-700 dark:text-rose-300">{e.message}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- mirrors

function Mirrors({ mirrors }) {
  const list = [
    ["Gate entries", "Vehicle / material arrivals", mirrors.gate_entries],
    ["GRN register", "ERP receiving history (srv_report)", mirrors.receiving_register],
  ];
  return (
    <div className="card">
      <CardHead icon={Network} tone="navy" title="ERP mirrors"
        hint="Read-only copies of ERP tables, plant-wide · matched to this store by part number" />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="text-[11px] uppercase tracking-wide text-slate-400">
            <tr>
              <th className="py-2 pr-3 text-left font-semibold">Mirror</th>
              <th className="px-3 py-2 text-right font-semibold">Rows</th>
              <th className="px-3 py-2 text-left font-semibold">Newest date</th>
              <th className="py-2 pl-3 text-right font-semibold">This store&apos;s parts</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
            {list.map(([name, hint, m]) => (
              <tr key={name}>
                <td className="py-2.5 pr-3">
                  <p className="font-medium text-slate-800 dark:text-white">{name}</p>
                  <p className="text-[11px] text-slate-400">{hint}</p>
                </td>
                <td className="px-3 py-2.5 text-right tabular">{m.rows ? num(m.rows) : <span className="text-slate-400">Empty</span>}</td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  {m.latest_date ? (
                    <>
                      {fmtDate(m.latest_date)}
                      {m.age_days != null && (
                        <span className="text-slate-400"> · {m.age_days <= 0 ? "today" : `${m.age_days} d ago`}</span>
                      )}
                    </>
                  ) : <span className="text-slate-400">—</span>}
                </td>
                <td className="py-2.5 pl-3 text-right whitespace-nowrap tabular">
                  {m.matched_rows
                    ? `${plural(m.matched_rows, "row")} · ${plural(m.matched_parts, "part")}`
                    : <span className="text-slate-400">None match</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------------ pending movements

const TXN_BADGE = { ISSUE: "badge-warning", RECEIPT: "badge-success", RETURN: "badge-info" };

const PENDING_COLUMNS = [
  {
    key: "part_no", label: "Part", sortable: true,
    searchValue: (r) => `${r.part_no} ${r.part_name || ""}`,
    render: (r) => (
      <div className="min-w-0">
        <p className="font-medium text-slate-800 dark:text-white">{r.part_no}</p>
        <p className="truncate text-[11px] text-slate-400">{r.part_name || "—"}</p>
      </div>
    ),
  },
  {
    key: "txn_type", label: "Type", sortable: true,
    render: (r) => <span className={`badge ${TXN_BADGE[r.txn_type] || "badge-neutral"}`}>{r.txn_type}</span>,
  },
  {
    key: "qty_delta", label: "Qty", sortable: true, align: "right",
    render: (r) => (
      <span className="tabular font-semibold">
        {r.qty_delta > 0 ? "+" : ""}{num(r.qty_delta)}
        {r.uom && <span className="ml-1 text-[10px] font-normal uppercase text-slate-400">{r.uom}</span>}
      </span>
    ),
  },
  {
    key: "department", label: "Department / ref",
    searchValue: (r) => `${r.department || ""} ${r.reference || ""}`,
    render: (r) => r.department || r.reference || "—",
    exportValue: (r) => r.department || r.reference || "",
  },
  { key: "at", label: "Recorded", sortable: true, render: (r) => stamp(r.at), exportValue: (r) => stamp(r.at) },
  {
    key: "age_hours", label: "Waiting", sortable: true, align: "right",
    render: (r) => age(r.age_hours) || "—", exportValue: (r) => age(r.age_hours) || "",
  },
];

function PendingMovements({ wb, onOpen }) {
  const hint = wb.pending > wb.shown
    ? `Oldest ${num(wb.shown)} of ${num(wb.pending)} shown — the order they will be sent in`
    : "Oldest first — the order they will be sent in";
  const empty = wb.pushed_total
    ? "Nothing is waiting — every movement recorded here has been sent to ERP."
    : "Nothing is waiting — no issue, receipt or return has been recorded in the app yet.";
  return (
    <div className="card">
      <CardHead icon={CloudUpload} tone="amber" title="Movements not yet in ERP" hint={hint} />
      <Table
        columns={PENDING_COLUMNS}
        rows={wb.rows}
        onRowClick={(r) => onOpen(r.part_id)}
        emptyMessage={empty}
        exportName={wb.rows.length ? "erp_pending_movements" : ""}
        maxHeight="420px"
      />
      <p className="mt-2 text-[11px] text-slate-400">{wb.note}</p>
    </div>
  );
}

// --------------------------------------------------------- reconciliation

function Tile({ label, value, tone }) {
  return (
    <div className="rounded-lg border border-slate-100 px-3 py-2 dark:border-navy-800">
      <p className="text-[11px] text-slate-400">{label}</p>
      <p className={`text-lg font-bold tabular ${tone}`}>{num(value)}</p>
    </div>
  );
}

// A gap's money figure: null = none of those gaps has a rate, so the value is
// unknown rather than zero; partly priced shows how many were left out.
function GapValue({ value, unpriced, tone }) {
  if (value == null) {
    return <span className="text-xs font-medium text-slate-400">Not valued (no rate)</span>;
  }
  return (
    <span className={`font-semibold tabular ${tone}`}>
      {money(value)}
      {unpriced > 0 && (
        <span className="ml-1 text-[11px] font-normal text-slate-400">Partial ({num(unpriced)} unpriced)</span>
      )}
    </span>
  );
}

// Newest alone can hide weeks-old figures behind one fresh push, so the stale
// warning counts every ERP figure past the stale window.
function staleWarning(rec) {
  const stale = rec.erp_stale_figures || 0;
  if (!stale) return null;
  const tail = "so their gaps describe ERP as it was then, not today.";
  if (stale >= rec.erp_figures) {
    const newest = age(rec.erp_age_hours);
    return rec.erp_oldest && stampDay(rec.erp_oldest) !== stampDay(rec.erp_as_of)
      ? `Every ERP figure is at least ${newest} old (oldest ${age(rec.erp_oldest_age_hours)}), ${tail}`
      : `The ERP figures are ${newest} old, ${tail}`;
  }
  return `${num(stale)} of ${plural(rec.erp_figures, "ERP figure")} ${stale === 1 ? "is" : "are"} older than ${rec.stale_after_hours} h`
    + ` (oldest ${age(rec.erp_oldest_age_hours)}), ${tail}`;
}

function Reconciliation({ rec, onOpen }) {
  const reconciled = (rec.matched || 0) + (rec.short || 0) + (rec.excess || 0);
  const v = rec.value_impact;
  const erpAge = age(rec.erp_age_hours);
  const spread = rec.erp_oldest && stampDay(rec.erp_oldest) !== stampDay(rec.erp_as_of);
  const erpSide = spread
    ? `ERP figures from ${stampDay(rec.erp_oldest)} to ${stampDay(rec.erp_as_of)}`
    : `ERP side as of ${stamp(rec.erp_as_of)}${erpAge ? ` (${erpAge} old)` : ""}`;
  const hint = rec.erp_as_of
    ? erpSide + (rec.counted_from ? ` · counts ${stampDay(rec.counted_from)} – ${stampDay(rec.counted_to)}` : "")
    : "No ERP stock figure received";
  const warning = staleWarning(rec);
  return (
    <div className="card">
      <CardHead
        icon={Scale} tone="red" title="ERP vs physical count" hint={hint}
        action={(
          <Link to="/spare-erp-gap" className="inline-flex items-center gap-1 text-xs font-medium text-toyotared hover:underline">
            Open gap list <ArrowRight size={13} aria-hidden="true" />
          </Link>
        )}
      />
      {rec.erp_state === "NONE" ? (
        <NotCaptured
          what="ERP has not pushed a stock figure for any part of this store"
          needs="Reconciliation sets ERP's figure beside the store's own count; it fills in once ERP pushes stock."
        />
      ) : (
        <div className="space-y-4">
          {warning && (
            <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              {warning}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <Tile label="Matched" value={rec.matched} tone="text-emerald-600 dark:text-emerald-400" />
            <Tile label="Short (physical < ERP)" value={rec.short} tone="text-rose-600 dark:text-rose-400" />
            <Tile label="Excess (physical > ERP)" value={rec.excess} tone="text-amber-600 dark:text-amber-400" />
            <Tile label="Counted, not in ERP" value={rec.not_synced} tone="text-slate-700 dark:text-slate-200" />
            <Tile label="In ERP, not counted" value={rec.no_physical} tone="text-slate-700 dark:text-slate-200" />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="space-y-1.5 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-slate-500 dark:text-slate-400">Accuracy</span>
                <span className="font-semibold tabular text-slate-800 dark:text-white">
                  {rec.accuracy_pct != null ? `${rec.accuracy_pct}%` : "—"}
                  <span className="ml-1 text-[11px] font-normal text-slate-400">
                    {reconciled ? `of ${plural(reconciled, "part")} with both figures` : "no part has both figures"}
                  </span>
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-slate-500 dark:text-slate-400">Short value</span>
                <GapValue value={v.short_value} unpriced={v.short_unpriced} tone="text-rose-600 dark:text-rose-400" />
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-slate-500 dark:text-slate-400">Excess value</span>
                <GapValue value={v.excess_value} unpriced={v.excess_unpriced} tone="text-amber-600 dark:text-amber-400" />
              </div>
              <p className="pt-1 text-[11px] leading-snug text-slate-400">
                {v.basis}
                {v.unpriced_gaps > 0 && ` ${plural(v.unpriced_gaps, "gap")} without a rate ${v.unpriced_gaps === 1 ? "is" : "are"} not valued.`}
              </p>
            </div>
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Largest gaps by value</p>
              {rec.top_gaps.length ? (
                <ul className="divide-y divide-slate-100 dark:divide-navy-800">
                  {rec.top_gaps.map((g) => (
                    <li key={g.part_id}>
                      <button type="button" onClick={() => onOpen(g.part_id)}
                        className="flex w-full items-center justify-between gap-3 py-1.5 text-left text-xs hover:text-toyotared">
                        <span className="min-w-0">
                          <span className="font-medium">{g.part_no}</span>
                          <span className="ml-1.5 truncate text-slate-400">{g.part_name}</span>
                        </span>
                        <span className="shrink-0 tabular">
                          <span className={g.gap_qty < 0 ? "text-rose-600 dark:text-rose-400" : "text-amber-600 dark:text-amber-400"}>
                            {g.gap_qty > 0 ? "+" : ""}{num(g.gap_qty)}
                          </span>
                          <span className="ml-2 font-semibold">{money(g.value)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-slate-400">No priced gap — either every counted part matches ERP or the gaps carry no rate.</p>
              )}
            </div>
          </div>
          <p className="flex items-start gap-1.5 text-[11px] leading-snug text-slate-400">
            <Info size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
            {rec.caveat}
          </p>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ data sources

const SOURCE_ICON = { erp: Database, dx: ClipboardList, physical: Boxes };
const SOURCE_TONE = { erp: "blue", dx: "violet", physical: "green" };

function sourceFact(s) {
  if (s.key === "dx") {
    if (!s.ledger_rows) return "No movement recorded yet";
    // Split by what reaches ERP: most rows are opening counts, not movements.
    const bits = [`${plural(s.movement_rows, "movement")} for ERP (issue/receipt/return)`];
    if (s.opening_rows) bits.push(`${plural(s.opening_rows, "opening count")} (app only)`);
    if (s.adjustment_rows) bits.push(`${plural(s.adjustment_rows, "count adjustment")} (app only)`);
    return `Ledger starts ${stampDay(s.ledger_started_at)} · ${bits.join(" · ")}`;
  }
  if (s.key === "physical") {
    return `${num(s.counted_parts)} of ${num(s.total_parts)} parts counted`
      + (s.last_counted_at ? ` · last count ${stamp(s.last_counted_at)}` : "");
  }
  return null;
}

function DataSources({ sources }) {
  return (
    <div className="card">
      <CardHead icon={Info} tone="navy" title="Where each figure comes from"
        hint="Three sources that are easy to mix up — only the first one is ERP" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {sources.map((s) => {
          const fact = sourceFact(s);
          return (
            <div key={s.key} className="rounded-lg border border-slate-100 p-3 dark:border-navy-800">
              <CardHead icon={SOURCE_ICON[s.key] || Info} tone={SOURCE_TONE[s.key] || "navy"} title={s.label} />
              <p className="text-xs text-slate-600 dark:text-slate-300">{s.what}</p>
              <p className="mt-1.5 text-[11px] leading-snug text-slate-400">{s.trust}</p>
              {fact && <p className="mt-2 text-[11px] font-medium text-slate-600 dark:text-slate-300 tabular">{fact}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- push result

function pushMessage(res) {
  if (res.error) return ["bad", res.error];
  if (res.configured === false) {
    const stay = res.pending === 1 ? "stays" : "stay";
    return ["warn", `Nothing was sent: ${res.reason}. ${plural(res.pending, "movement")} ${stay} queued in the app.`];
  }
  if (!res.pushed && !res.failed && !res.pending) return ["off", "Nothing to send — the queue was empty."];
  const failed = res.failed ? ` ${plural(res.failed, "movement")} failed and stay${res.failed === 1 ? "s" : ""} pending.` : "";
  // The push reports pending = everything not sent, failures included — count those once.
  const waiting = (res.pending || 0) - (res.failed || 0);
  const left = waiting > 0 ? ` ${num(waiting)} still waiting.` : "";
  return [res.failed ? "warn" : "ok", `Sent ${plural(res.pushed, "movement")} to ERP.${failed}${left}`];
}

function PushResult({ result, onClose }) {
  if (!result) return null;
  const [tone, text] = pushMessage(result);
  return (
    <div className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${CHIP_TONES[tone]}`} role="status">
      <span>{text}</span>
      <button type="button" onClick={onClose} className="shrink-0 opacity-70 hover:opacity-100" aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}

// --------------------------------------------------------------------- page

function Skeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card space-y-3">
            <div className="skeleton h-8 w-40" />
            <div className="skeleton h-5 w-28" />
            <div className="skeleton h-3 w-full" />
            <div className="skeleton h-3 w-5/6" />
            <div className="skeleton h-3 w-2/3" />
          </div>
        ))}
      </div>
      <div className="card space-y-2">
        {Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton h-6 w-full" />)}
      </div>
    </div>
  );
}

export default function ErpControlCenter() {
  const { activeCode: code, loading: storesLoading } = useStores();
  const { openPart } = usePartDrawer();
  // POST /spare-stock/erp-sync takes the Store Stock or the ERP Control Center edit right.
  const canPushStock = useCan("store_stock", "update");
  const canPushErp = useCan("erp_control", "update");
  const canPush = canPushStock || canPushErp;
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [pushResult, setPushResult] = useState(null);

  const q = useQuery({
    queryKey: ["stock", "erp-control", code],
    queryFn: () => erpControlService.status(code).then((r) => r.data.data),
    enabled: Boolean(code),
    refetchInterval: 60_000,
  });
  const d = q.data;

  const push = useMutation({
    mutationFn: () => spareStockService.erpSync(code).then((r) => r.data.data),
    onSuccess: (res) => {
      setPushResult(res);
      invalidateStock(qc);
    },
    // The API layer already toasts the message; keep it beside the button too.
    onError: (err) => setPushResult({ error: err?.response?.data?.message || "The push request failed." }),
  });

  const handlePush = async () => {
    const wb = d?.write_back;
    if (!wb) return;
    // Only a live write changes ERP, so only that asks first.
    if (wb.active && !(await confirm({
      title: "Send to ERP",
      message: `Send ${plural(wb.pending, "pending movement")} to ERP now? ERP's stock will change.`,
      confirmText: "Send", danger: false,
    }))) return;
    setPushResult(null);
    push.mutate();
  };

  const pending = d?.write_back?.pending ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-bold text-slate-800 dark:text-white">
            <Network size={18} className="text-toyotared" aria-hidden="true" /> ERP Control Center
          </h2>
          <p className="mt-0.5 max-w-3xl text-xs text-slate-400">
            What the app knows about ERP for this store: what came in and how old it is, what is waiting to go
            out, and where ERP and the shelf disagree. Every figure carries its date — none of it is a live feed.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {d?.generated_at && (
            <span className="text-[11px] text-slate-400">
              Checked {parseServerTime(d.generated_at)?.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) ?? "—"} · every minute
            </span>
          )}
          <button type="button" className="btn-secondary inline-flex items-center gap-1.5"
            onClick={() => q.refetch()} disabled={!code || q.isFetching}>
            <RefreshCw size={14} className={q.isFetching ? "animate-spin" : ""} aria-hidden="true" /> Refresh
          </button>
          {canPush && d && (
            <button type="button" className="btn-primary inline-flex items-center gap-1.5"
              onClick={handlePush} disabled={push.isPending || pending === 0}
              title={pending === 0 ? "Nothing is waiting to be sent" : d.write_back.reason}>
              <Send size={14} aria-hidden="true" />
              {push.isPending ? "Pushing…" : `Push pending to ERP${pending ? ` (${num(pending)})` : ""}`}
            </button>
          )}
        </div>
      </div>

      <PushResult result={pushResult} onClose={() => setPushResult(null)} />

      {!code ? (
        storesLoading ? <Skeleton /> : (
          <div className="card text-center text-sm text-slate-400 py-10">No store is selected — pick one in the sidebar.</div>
        )
      ) : q.isPending ? (
        <Skeleton />
      ) : !d ? (
        <div className="card py-10 text-center">
          <TriangleAlert size={24} className="mx-auto mb-2 text-rose-500" aria-hidden="true" />
          <p className="text-sm text-slate-600 dark:text-slate-300">Couldn&apos;t load the ERP status.</p>
          {q.error?.response?.data?.message && (
            <p className="mt-1 text-xs text-slate-400">{q.error.response.data.message}</p>
          )}
          <button type="button" onClick={() => q.refetch()} className="mt-3 text-sm font-medium text-toyotared hover:underline">
            Retry
          </button>
        </div>
      ) : (
        <>
          {q.isError && (
            // A failed background refresh keeps the last good reading, labelled as such.
            <p className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              <TriangleAlert size={14} className="shrink-0" aria-hidden="true" />
              Couldn&apos;t refresh — showing the reading from {stamp(d.generated_at)}.
              <button type="button" onClick={() => q.refetch()} className="font-medium text-toyotared hover:underline">Retry</button>
            </p>
          )}
          <StatusCards d={d} />
          <LastErrors errors={errorsOf(d)} />
          <div className="grid grid-cols-1 gap-6 2xl:grid-cols-2">
            <PendingMovements wb={d.write_back} onOpen={openPart} />
            <Reconciliation rec={d.reconciliation} onOpen={openPart} />
          </div>
          <Mirrors mirrors={d.db_sync.mirrors} />
          <DataSources sources={d.data_sources} />
        </>
      )}
    </div>
  );
}
