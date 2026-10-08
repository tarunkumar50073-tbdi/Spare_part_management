import React, { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { ArrowLeft, CircleCheck, RefreshCw, Search, Wrench } from "lucide-react";
import ErrorState from "../../components/ErrorState.jsx";
import ActionForm from "../../components/scan/ActionForm.jsx";
import { IssueAge, IssueStatusPill, useMinuteClock } from "../../components/spare/IssueLifecycle.jsx";
import { useStores } from "../../context/StoreContext.jsx";
import { spareStockService } from "../../services/spareStockService.js";
import { spareFlowService } from "../../services/spareFlowService.js";
import { num } from "../../lib/format.js";

// Confirm Installation — the line user's Stage-2 screen. The store issues a part
// to a person (Stage 1, on Scan Part: qty + department + mobile); that part then
// waits for someone to record WHERE it was fitted. This screen lists those
// waiting issues and lets the fitter fill in the line / machine (and die) and
// how much was used. It is the one screen the install_confirm right opens — the
// user never sees issue / receive / return.
//
// There is no per-part QR to re-scan (the store prints lot tags and bin sheets,
// not a label per part), so this is a searchable LIST, not a scanner: the fitter
// finds their part by part no / department / who it was issued to / mobile.
//
// The write (POST /spare-stock/issues/:id/confirm) accepts install_confirm as
// well as scan_part edit; it still needs access to the part's store. The read
// list (GET /pending-confirmations) is open like the app's other reads.

export default function ConfirmInstallation() {
  const { activeCode } = useStores();
  const storeCode = activeCode || "MAINTENANCE";
  const qc = useQueryClient();
  const now = useMinuteClock();
  const [q, setQ] = useState("");
  // The issue being filled in: { partId, ledgerId }. null = showing the list.
  const [picked, setPicked] = useState(null);

  // Shares the "stock" query prefix so an issue or confirm anywhere refreshes it
  // live (the SSE "stock" event), the same way the Work Queue stays fresh.
  const list = useQuery({
    queryKey: ["stock", "pending-confirmations", storeCode],
    queryFn: () => spareStockService.pendingConfirmations(storeCode).then((r) => r.data.data),
  });

  const rows = Array.isArray(list.data) ? list.data : [];
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter((r) =>
      [r.part_no, r.part_name, r.department, r.issued_to, r.issued_to_mobile, r.issued_to_code]
        .some((v) => String(v || "").toLowerCase().includes(t)));
  }, [rows, q]);

  // The install form is driven by the part's scan result (its open issues).
  const scanQ = useQuery({
    queryKey: ["stock", "scan-result", picked?.partId],
    queryFn: () => spareFlowService.scanResult(picked.partId).then((r) => r.data.data),
    enabled: Boolean(picked?.partId),
  });

  const back = () => setPicked(null);
  const onDone = (message) => {
    if (message) toast.success(message);
    qc.invalidateQueries({ queryKey: ["stock", "pending-confirmations", storeCode] });
    if (picked?.partId) qc.invalidateQueries({ queryKey: ["stock", "scan-result", picked.partId] });
    setPicked(null);
  };

  // --- Detail: fill the line / machine for one issued part ---
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
                Confirm where this part was fitted
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

  // --- List: parts issued and waiting for a line / machine ---
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800 dark:text-white">Confirm Installation</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Parts the store has issued to the floor. Open the one you fitted and record the line / machine
            (and die) it went on.
          </p>
        </div>
        <button type="button" onClick={() => list.refetch()} disabled={list.isFetching}
          className="btn-secondary inline-flex items-center gap-1.5 !py-1.5 text-xs">
          <RefreshCw size={13} className={list.isFetching ? "animate-spin" : ""} aria-hidden="true" /> Refresh
        </button>
      </div>

      <div className="relative mb-3">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          aria-hidden="true" />
        <input value={q} onChange={(e) => setQ(e.target.value)} className="input-field pl-9"
          placeholder="Search part no., description, department, name or mobile"
          aria-label="Search issued parts" />
      </div>

      {list.isError ? (
        <ErrorState onRetry={() => list.refetch()} message="Could not load the issued parts — try again." />
      ) : list.isPending ? (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton h-20 w-full rounded-xl" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="card flex flex-col items-center gap-2 p-10 text-center">
          <CircleCheck size={28} className="text-emerald-500" aria-hidden="true" />
          <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            {rows.length === 0 ? "Nothing to confirm" : "No match"}
          </p>
          <p className="text-xs text-slate-400">
            {rows.length === 0
              ? "Every issued part has had its line / machine recorded."
              : "No issued part matches your search."}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {filtered.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => setPicked({ partId: r.part_id, ledgerId: r.id })}
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
                  <p className="mt-0.5 truncate text-[11px] text-slate-400">
                    Qty {num(r.qty)} · {[r.department, r.issued_to].filter(Boolean).join(" · ") || "department not recorded"}
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
      )}
    </div>
  );
}
