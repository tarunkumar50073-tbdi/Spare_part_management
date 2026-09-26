import React from "react";
import { useQuery } from "@tanstack/react-query";
import { fmtDate, num, parseServerTime } from "../../lib/format.js";
import { timelineMeta } from "../../lib/scanStatus.js";
import { spareFlowService } from "../../services/spareFlowService.js";
import { TONE_CHIP, scanIcon } from "../scan/scanIcons.js";

// A part's history as one vertical timeline (spec 21): received, GRN, quality,
// issued, installed on a line / machine / die, returned, inspected, sent for
// rework, back from the supplier, RGP GRN, added to stock — newest first, each
// event with who, where and how many. Rows come from the backend timeline
// (scan_result.timeline or GET /spare-flow/parts/:id/timeline); the kind ->
// label / icon / tone vocabulary is lib/scanStatus TIMELINE_KIND, so the Scan
// Part workstation and the part drawer's trace say the same thing.

// The full timeline of one part ({ rows, has_more }). One key and one limit
// for every reader — the Scan Part history and the part drawer's trace share
// the cached copy, and a "stock" push refreshes both.
export const TIMELINE_LIMIT = 200;
export function usePartTimeline(partId, { enabled = true } = {}) {
  return useQuery({
    queryKey: ["stock", "timeline", partId],
    queryFn: () => spareFlowService.timeline(partId, TIMELINE_LIMIT).then((r) => r.data.data),
    enabled: enabled && partId != null,
  });
}

// ERP gate / GRN rows carry a DATE only (the ERP records no clock time), so
// they show a date only — never a made-up 00:00. App events are naive-UTC
// stamps, shown in the plant's clock, with the year: a part's life spans years.
function timelineWhen(at) {
  if (!at) return "Time not recorded";
  if (String(at).length <= 10) return fmtDate(at);
  const d = parseServerTime(at);
  if (!d) return "—";
  const date = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${date} · ${time}`;
}

// "QUALITY_PENDING" -> "Quality pending" for the status change line.
const words = (s) => {
  const w = String(s).replace(/_/g, " ").toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
};

function Chip({ label, children }) {
  return (
    <span className="inline-flex max-w-full items-baseline gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600 dark:bg-navy-800 dark:text-slate-300">
      {label && <span className="shrink-0 text-slate-400">{label}</span>}
      <span className="min-w-0 truncate font-medium">{children}</span>
    </span>
  );
}

// The quantity of the event. A stock-ledger row has a signed delta (what it did
// to available stock); a journal row has a plain quantity (what moved between
// buckets, e.g. 2 sent to the supplier) — shown as such, never given a sign it
// doesn't have.
function QtyChip({ row }) {
  const delta = row.qty_delta == null ? null : Number(row.qty_delta);
  if (delta != null && delta !== 0) {
    const up = delta > 0;
    return (
      <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular ${up
        ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
        : "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"}`}>
        {up ? "+" : "−"}{num(Math.abs(delta))} {up ? "to stock" : "from stock"}
      </span>
    );
  }
  if (row.qty == null) return null;
  return <Chip label="Qty">{num(row.qty)}</Chip>;
}

function detailChips(row) {
  const line = [row.line_name, row.line_no].filter(Boolean).join(" ");
  const docs = new Set([row.rgp_no, row.grn_no, row.return_no].filter(Boolean));
  return [
    row.department && ["Dept", row.department],
    row.issued_to && ["To", row.issued_to],
    line && [/^line\b/i.test(line) ? "" : "Line", line],
    row.machine && ["Machine", row.machine],
    row.die_no && ["Die", row.die_no],
    row.supplier && ["Supplier", row.supplier],
    row.rgp_no && ["RGP", row.rgp_no],
    row.grn_no && ["GRN", row.grn_no],
    row.return_no && ["Return", row.return_no],
    // The reference is often the same document number again (or, on a label
    // print, the Part No. the QR carries) — only shown when it says something
    // the chips above don't.
    row.reference && !docs.has(row.reference) && row.source !== "label" && ["Ref", row.reference],
  ].filter(Boolean);
}

/**
 * rows      timeline rows, newest first
 * compact   tighter spacing and no status-change line (the Scan Part preview)
 */
export default function PartTimeline({ rows, compact = false, emptyText = "Nothing recorded for this part yet.", ariaLabel = "Part history" }) {
  if (!rows?.length) {
    return <p className="text-sm text-slate-400">{emptyText}</p>;
  }
  return (
    <ol aria-label={ariaLabel}>
      {rows.map((r, i) => {
        const meta = timelineMeta(r.kind);
        const Icon = scanIcon(meta.icon);
        const last = i === rows.length - 1;
        const chips = detailChips(r);
        const fromErp = typeof r.source === "string" && r.source.startsWith("erp");
        return (
          <li key={`${r.source || "row"}-${r.at || ""}-${i}`} className="flex gap-3">
            <div className="flex shrink-0 flex-col items-center">
              <span className={`flex h-7 w-7 items-center justify-center rounded-full ${TONE_CHIP[meta.tone] || TONE_CHIP.neutral}`}>
                <Icon size={14} aria-hidden="true" />
              </span>
              {!last && <span className="my-1 w-px flex-1 bg-slate-200 dark:bg-navy-700" aria-hidden="true" />}
            </div>
            <div className={`min-w-0 flex-1 ${last ? "" : compact ? "pb-3" : "pb-4"}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <p className="min-w-0 text-sm font-semibold text-slate-800 dark:text-slate-100">
                  {r.title || meta.label}
                  {/* Read from the ERP (gate entry / GRN register), not recorded
                      in this app — said so, so the two are never confused. */}
                  {fromErp && (
                    <span className="ml-1.5 rounded bg-slate-100 px-1 py-px align-[1px] text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:bg-navy-800 dark:text-slate-400">ERP</span>
                  )}
                </p>
                <time dateTime={r.at || undefined} className="shrink-0 text-[11px] tabular text-slate-400">
                  {timelineWhen(r.at)}
                </time>
              </div>
              {r.detail && <p className="mt-0.5 break-words text-xs text-slate-500 dark:text-slate-400">{r.detail}</p>}
              {!compact && r.prev_status && r.new_status && r.prev_status !== r.new_status && (
                <p className="mt-0.5 text-[11px] text-slate-400">
                  {words(r.prev_status)} <span aria-hidden="true">→</span><span className="sr-only">to</span> {words(r.new_status)}
                </p>
              )}
              {(chips.length > 0 || r.qty != null || r.qty_delta != null || r.user) && (
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <QtyChip row={r} />
                  {(compact ? chips.slice(0, 4) : chips).map(([label, value]) => (
                    <Chip key={`${label}-${value}`} label={label}>{value}</Chip>
                  ))}
                  {r.user && <span className="text-[11px] text-slate-400">by {r.user}</span>}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
