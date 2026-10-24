import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import {
  ArrowLeft, CircleCheck, Hourglass, Info, PackageCheck, PencilLine, RefreshCw, Search, Wrench,
} from "lucide-react";
import ErrorState from "../../components/ErrorState.jsx";
import ActionForm from "../../components/scan/ActionForm.jsx";
import { placeText } from "../../components/scan/forms/flow.js";
import {
  ISSUE_STATUS, IssueAge, IssueStatusPill, NONE_USED, issueStatusLabel, useMinuteClock,
} from "../../components/spare/IssueLifecycle.jsx";
import { useStores } from "../../context/StoreContext.jsx";
import { spareStockService } from "../../services/spareStockService.js";
import { spareFlowService } from "../../services/spareFlowService.js";
import { fmtStamp, num } from "../../lib/format.js";

// Confirm Installation — the line user's Stage-2 screen. The store issues a part
// to a person (Stage 1, on Scan Part: qty + department + mobile); that part then
// waits for someone to record WHERE it was fitted. Two tabs:
//   * Waiting — the issues still waiting for that: open one and fill in the line
//     / machine (and die) and how much was used.
//   * Installed — the issues already confirmed: where each is fitted now and how
//     much was used, with Update to change either (the part moved, or more of it
//     was used). Every update is kept in the part's history — the Part Ledger
//     and the Scan Part timeline show each one.
// It is the one screen the install_confirm right opens — the user never sees
// issue / receive / return.
//
// There is no per-part QR to re-scan (the store prints bin sheets, not a label
// per part), so both tabs are searchable LISTS, not a scanner: the
// fitter finds their part by part no / department / who it was issued to /
// mobile (and, once installed, line / machine).
//
// The write (POST /spare-stock/issues/:id/confirm, repeatable) accepts
// install_confirm as well as scan_part edit; it still needs access to the part's
// store. The reads (GET /pending-confirmations, GET /installations) are open
// like the app's other reads.

const TABS = [
  { key: "waiting", label: "Waiting", Icon: Hourglass },
  { key: "installed", label: "Installed", Icon: PackageCheck },
];
// The Installed list holds the newest confirmations; the search reaches older ones.
const INSTALLED_LIMIT = 200;
// Typing in the Installed search costs one request at the end, not one per key.
const SEARCH_DELAY_MS = 300;

// How an installed issue reads. A confirmation with 0 used is stored as
// PARTIALLY_USED, but nothing was fitted — it reads "Not used yet", never
// "Partly used". After a return the issue's own status says where it is.
const installState = (r) => {
  const fitted = r.status === "INSTALLED" || r.status === "PARTIALLY_USED";
  if (fitted && r.actual_qty != null && Number(r.actual_qty) === 0) return NONE_USED;
  if (r.status === "PARTIALLY_USED") return { label: "Partly used", badge: "badge-success" };
  if (r.status === "INSTALLED") return { label: "Installed", badge: "badge-success" };
  return { label: issueStatusLabel(r.status), badge: ISSUE_STATUS[r.status]?.badge || "badge-neutral" };
};

// "Used 1 of 2". An INSTALLED issue with no figure counts as fully used (as the
// backend's _installed_qty does).
const usedLine = (r) => {
  const used = r.actual_qty != null ? Number(r.actual_qty) : r.status === "INSTALLED" ? Number(r.issued_qty) : null;
  return used == null ? "Usage not recorded" : `Used ${num(used)} of ${num(r.issued_qty)}`;
};

// "Qty 3" — or, once some came back before anyone confirmed the issue, "Qty 3 ·
// 1 returned · 2 still out": it stays under Waiting for the rest (store, 16 Oct
// 2026), and only what is still out can be confirmed.
const waitingQty = (r) => (Number(r.returned_qty) > 0
  ? `Qty ${num(r.qty)} · ${num(r.returned_qty)} returned · ${num(r.outstanding_qty)} still out`
  : `Qty ${num(r.qty)}`);

// "Tarun (79) · Store · 98xxxxxxxx" — who has it, as recorded at the issue.
const holderOf = (r) => [
  r.issued_to && (r.issued_to_code ? `${r.issued_to} (${r.issued_to_code})` : r.issued_to),
  r.department, r.issued_to_mobile,
].filter(Boolean).join(" · ");

function InstalledRow({ r, onUpdate }) {
  const state = installState(r);
  // An update needs something of the issue still out (confirm_installation).
  const allBack = r.outstanding_qty != null && Number(r.outstanding_qty) <= 0;
  return (
    <li className="card flex items-start gap-3 p-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        <PackageCheck size={18} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="truncate font-semibold text-slate-800 dark:text-slate-100">{r.part_no}</span>
          <span className={`badge ${state.badge}`}>{state.label}</span>
        </div>
        <p className="truncate text-xs text-slate-500 dark:text-slate-400">{r.part_name}</p>
        <p className="mt-1 break-words text-xs font-medium text-slate-700 dark:text-slate-200">
          {placeText(r) || "Line / machine not recorded"}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-slate-400">
          Issued to {holderOf(r) || "—"}
        </p>
        <p className="truncate text-[11px] text-slate-400">
          Confirmed {r.confirmed_by ? `by ${r.confirmed_by} · ` : ""}{fmtStamp(r.confirmed_at)}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="tabular text-sm font-bold text-slate-800 dark:text-slate-100">{usedLine(r)}</p>
        {Number(r.returned_qty) > 0 && (
          <p className="tabular text-[11px] text-slate-400">{num(r.returned_qty)} returned</p>
        )}
        {allBack ? (
          <p className="mt-1.5 text-[11px] text-slate-400">All returned</p>
        ) : (
          <button type="button" onClick={onUpdate} aria-label={`Update ${r.part_no || "this part"}`}
            className="btn-secondary mt-1.5 inline-flex items-center gap-1.5 !py-1 text-xs">
            <PencilLine size={13} aria-hidden="true" /> Update
          </button>
        )}
      </div>
    </li>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true">
      {Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton h-20 w-full rounded-xl" />)}
    </div>
  );
}

function EmptyNote({ title, text }) {
  return (
    <div className="card flex flex-col items-center gap-2 p-10 text-center">
      <CircleCheck size={28} className="text-emerald-500" aria-hidden="true" />
      <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</p>
      <p className="text-xs text-slate-400">{text}</p>
    </div>
  );
}

export default function ConfirmInstallation() {
  const { activeCode } = useStores();
  const storeCode = activeCode || "MAINTENANCE";
  const qc = useQueryClient();
  const now = useMinuteClock();
  // ?tab= keeps the tab across a reload, and the list returns to it after a save.
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "installed" ? "installed" : "waiting";
  const setTab = (key) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    next.set("tab", key);
    return next;
  }, { replace: true });
  const [text, setText] = useState("");    // the search box as typed (one box, both tabs)
  const [asked, setAsked] = useState("");  // what the Installed list searches, after a short pause
  // The issue being filled in: { partId, ledgerId, update }. null = showing the list.
  const [picked, setPicked] = useState(null);

  useEffect(() => {
    const t = text.trim();
    if (t === asked) return undefined;
    const id = setTimeout(() => setAsked(t), SEARCH_DELAY_MS);
    return () => clearTimeout(id);
  }, [text, asked]);

  // Both lists share the "stock" query prefix so an issue or confirm anywhere
  // refreshes them live (the SSE "stock" event), the way the Work Queue stays fresh.
  const list = useQuery({
    queryKey: ["stock", "pending-confirmations", storeCode],
    queryFn: () => spareStockService.pendingConfirmations(storeCode).then((r) => r.data.data),
  });
  // Silent: the tab shows a failure itself (ErrorState) — a toast as well would
  // repeat on every stock event while the endpoint is down.
  const installed = useQuery({
    queryKey: ["stock", "installations", storeCode, asked],
    queryFn: () => spareStockService.installations(storeCode, asked, INSTALLED_LIMIT, { silent: true })
      .then((r) => r.data.data),
    enabled: tab === "installed",
    placeholderData: keepPreviousData,
  });

  const rows = useMemo(() => (Array.isArray(list.data) ? list.data : []), [list.data]);
  const filtered = useMemo(() => {
    const t = text.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter((r) =>
      [r.part_no, r.part_name, r.department, r.issued_to, r.issued_to_mobile, r.issued_to_code]
        .some((v) => String(v || "").toLowerCase().includes(t)));
  }, [rows, text]);
  const installedRows = Array.isArray(installed.data) ? installed.data : [];
  const active = tab === "installed" ? installed : list;

  // The install form is driven by the part's scan result (its open issues).
  const scanQ = useQuery({
    queryKey: ["stock", "scan-result", picked?.partId],
    queryFn: () => spareFlowService.scanResult(picked.partId).then((r) => r.data.data),
    enabled: Boolean(picked?.partId),
  });

  const back = () => setPicked(null);
  const onDone = (message) => {
    if (message) toast.success(message);
    // Both tabs: a first confirmation moves the issue from Waiting to Installed.
    qc.invalidateQueries({ queryKey: ["stock", "pending-confirmations", storeCode] });
    qc.invalidateQueries({ queryKey: ["stock", "installations", storeCode] });
    if (picked?.partId) qc.invalidateQueries({ queryKey: ["stock", "scan-result", picked.partId] });
    setPicked(null);
  };

  // --- Detail: fill (or change) the line / machine for one issued part ---
  if (picked) {
    const scan = scanQ.data || null;
    const part = scan?.part || null;
    return (
      <div className="mx-auto max-w-2xl">
        <button type="button" onClick={back}
          className="btn-secondary mb-4 inline-flex items-center gap-1.5 !py-1.5 text-xs">
          <ArrowLeft size={14} aria-hidden="true" /> Back to the list
        </button>
        {scanQ.isError ? (
          <ErrorState onRetry={() => scanQ.refetch()} message="Could not load this part — try again." />
        ) : !scan ? (
          <div className="card p-6"><div className="skeleton h-40 w-full" /></div>
        ) : (
          <div className="card p-4 sm:p-5">
            <div className="mb-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                {picked.update ? "Update where this part is fitted" : "Confirm where this part was fitted"}
              </p>
              <h2 className="break-words text-lg font-bold text-slate-800 dark:text-white">
                {part?.part_no}{part?.part_name ? ` — ${part.part_name}` : ""}
              </h2>
            </div>
            <ActionForm actionKey="UPDATE_INSTALLATION" scan={scan} target={picked.ledgerId}
              source="MANUAL_ENTRY" onDone={onDone} onCancel={back} />
          </div>
        )}
      </div>
    );
  }

  let body;
  if (tab === "waiting") {
    // --- Waiting: parts issued and waiting for a line / machine ---
    body = list.isError ? (
      <ErrorState onRetry={() => list.refetch()} message="Could not load the issued parts — try again." />
    ) : list.isPending ? (
      <ListSkeleton />
    ) : filtered.length === 0 ? (
      <EmptyNote title={rows.length === 0 ? "Nothing to confirm" : "No match"}
        text={rows.length === 0
          ? "Every issued part has had its line / machine recorded."
          : "No issued part matches your search."} />
    ) : (
      <ul className="space-y-2">
        {filtered.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => setPicked({ partId: r.part_id, ledgerId: r.id, update: false })}
              className="card flex w-full items-center gap-3 p-3 text-left transition-colors hover:border-toyotared">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-toyotared/10 text-toyotared">
                <Wrench size={18} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="truncate font-semibold text-slate-800 dark:text-slate-100">{r.part_no}</span>
                  <IssueStatusPill issue={r} />
                </div>
                <p className="truncate text-xs text-slate-500 dark:text-slate-400">{r.part_name}</p>
                {Number(r.returned_qty) > 0 && (
                  <p className="mt-0.5 truncate text-[11px] font-semibold text-amber-700 dark:text-amber-400">
                    {waitingQty(r)}
                  </p>
                )}
                <p className="mt-0.5 truncate text-[11px] text-slate-400">
                  {Number(r.returned_qty) > 0 ? "" : `${waitingQty(r)} · `}
                  {[r.department, r.issued_to].filter(Boolean).join(" · ") || "department not recorded"}
                  {r.issued_to_mobile ? ` · ${r.issued_to_mobile}` : ""}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <IssueAge at={r.issued_at} now={now} prefix="" />
                <p className="mt-1 text-[11px] font-semibold text-toyotared">Fill line / machine →</p>
              </div>
            </button>
          </li>
        ))}
      </ul>
    );
  } else {
    // --- Installed: confirmed issues — where each is now, with Update ---
    body = (
      <>
        <p className="mb-3 flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-navy-700 dark:bg-navy-800/50 dark:text-slate-300">
          <Info size={14} className="mt-px shrink-0 text-slate-400" aria-hidden="true" />
          <span>
            Parts carry no QR code of their own, so nothing is scanned here: find the part and press Update to
            change its line / machine / die or how much was used. Every change stays in the part&apos;s history
            (Part Ledger).
          </span>
        </p>
        {installed.isError && !installed.data ? (
          <ErrorState onRetry={() => installed.refetch()} message="Could not load the installed parts — try again." />
        ) : installed.isPending ? (
          <ListSkeleton />
        ) : installedRows.length === 0 ? (
          <EmptyNote title={asked ? "No match" : "Nothing installed yet"}
            text={asked
              ? "No installed part matches your search."
              : "A part shows here once its line / machine has been recorded."} />
        ) : (
          <>
            <ul className="space-y-2" aria-label="Installed parts">
              {installedRows.map((r) => (
                <InstalledRow key={r.id} r={r}
                  onUpdate={() => setPicked({ partId: r.part_id, ledgerId: r.id, update: true })} />
              ))}
            </ul>
            {installedRows.length >= INSTALLED_LIMIT && (
              <p className="mt-2 text-center text-[11px] text-slate-400">
                Showing the latest {num(INSTALLED_LIMIT)} — search to find an older one.
              </p>
            )}
          </>
        )}
      </>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800 dark:text-white">Confirm Installation</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Parts the store has issued to the floor. Open the one you fitted and record the line / machine
            (and die) it went on — change it later under Installed.
          </p>
        </div>
        <button type="button" onClick={() => active.refetch()} disabled={active.isFetching}
          className="btn-secondary inline-flex items-center gap-1.5 !py-1.5 text-xs">
          <RefreshCw size={13} className={active.isFetching ? "animate-spin" : ""} aria-hidden="true" /> Refresh
        </button>
      </div>

      <div role="tablist" aria-label="Issued parts"
        className="mb-3 inline-flex rounded-lg border border-slate-200 p-0.5 text-sm dark:border-navy-700">
        {TABS.map((t) => {
          const on = tab === t.key;
          return (
            <button key={t.key} type="button" role="tab" aria-selected={on} onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition ${on
                ? "bg-toyotared text-white" : "text-slate-600 dark:text-slate-300"}`}>
              <t.Icon size={14} aria-hidden="true" /> {t.label}
              {t.key === "waiting" && list.data && (
                <span className={`tabular rounded-full px-1.5 text-[11px] font-semibold ${on
                  ? "bg-white/20" : "bg-slate-100 text-slate-500 dark:bg-navy-800 dark:text-slate-400"}`}>
                  {num(rows.length)}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="relative mb-3">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          aria-hidden="true" />
        <input value={text} onChange={(e) => setText(e.target.value)} className="input-field pl-9"
          placeholder={tab === "installed"
            ? "Search part no., description, name, mobile, department, line or machine"
            : "Search part no., description, department, name or mobile"}
          aria-label={tab === "installed" ? "Search installed parts" : "Search issued parts"} />
      </div>

      {body}
    </div>
  );
}
